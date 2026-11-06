/**
 * The calls a store's page makes to X's pixel (613 [WP12]), worked out
 * without a browser so they can be tested. Only what Claude 1 confirmed on
 * X's own pages on 2 November 2026 (docs/x-reddit-pixels-official-check-2026-11-02.md):
 * `twq('config', id)` (X item 1), `twq('event', 'tw-<pixel>-<event>', {...})`
 * with `value`, `currency` and, on a purchase, `conversion_id` (items 3, 4,
 * 11), and `restricted_data_use: 'restrict_optimization'` (item 15). Nothing
 * from the conversions API, whose version and currency field were not
 * confirmed, and nothing from Reddit.
 */
import { type Pixels, xEventName } from "@/lib/pixels";

export const X_SCRIPT = "https://static.ads-twitter.com/uwt.js";

/** X's switch that limits what it does with a visitor's data. */
export const X_RESTRICTED = { restricted_data_use: "restrict_optimization" } as const;

/** What a page tells X about. A started checkout is not among X's events here. */
export type XEvent =
  | { type: "purchase"; id: string; value: number; currency?: string }
  | { type: "lead"; id?: string }
  | { type: "checkout" };

/** The `config` call: the pixel's ID, limited for a visitor who never said yes. */
export function xConfigCall(id: string, restricted: boolean): unknown[] {
  return ["config", id, ...(restricted ? [{ ...X_RESTRICTED }] : [])];
}

/** The `event` call for one event, or null when X is not told about it (no pixel, or no event ID from the creator). */
export function xEventCall(pixels: Pick<Pixels, "x" | "xEvents">, event: XEvent, restricted: boolean): unknown[] | null {
  if (!pixels.x) return null;
  const limit = restricted ? { ...X_RESTRICTED } : {};
  if (event.type === "purchase" && pixels.xEvents?.purchase) {
    // The order's id as conversion_id, so a later server send of the same purchase is counted once (X item 11).
    return ["event", xEventName(pixels.x, pixels.xEvents.purchase), { value: event.value, currency: (event.currency ?? "usd").toUpperCase(), conversion_id: event.id, ...limit }];
  }
  if (event.type === "lead" && pixels.xEvents?.lead) {
    return ["event", xEventName(pixels.x, pixels.xEvents.lead), { ...(event.id ? { conversion_id: event.id } : {}), ...limit }];
  }
  return null;
}
