/**
 * The calls a store's page makes to Reddit's pixel (613 [WP12] unit 2),
 * worked out without a browser so they can be tested. Only what Claude 1
 * confirmed on Reddit's own pages on 2 November 2026
 * (docs/x-reddit-pixels-official-check-2026-11-02.md, Reddit items 1 to 6
 * and 9): the script at redditstatic.com with the pixel's ID, `init`, the
 * standard `PageVisit`, `Purchase` and `Lead` with `value`, `currency`,
 * `conversionId` and `products`, and Limited Data Use (`dpm: "LDU"` with the
 * visitor's country `dpcc` and, when known, region `dprc`).
 *
 * No identifier is ever passed (no email, phone or external id), and Reddit's
 * Automated Advanced Matching is off by the creator's own word before the
 * pixel is saved (lib/pixels.ts). A started checkout is not sent: none of the
 * eight standard events is it. The conversions API is lib/reddit-conversions.ts.
 */
import type { Pixels } from "@/lib/pixels";

export function redditScript(id: string): string {
  return `https://www.redditstatic.com/ads/pixel.js?pixel_id=${encodeURIComponent(id)}`;
}

/** Where a visitor is, for Limited Data Use: ISO 3166-1 country and, when known, ISO 3166-2 region ("US-CA"). */
export type Place = { country: string | null; region: string | null };

/** The place from the request's two geography headers, each held to its ISO shape; anything else is unknown. */
export function placeOf(country: string | null | undefined, region: string | null | undefined): Place {
  const c = country && /^[A-Z]{2}$/.test(country) ? country : null;
  const r = c && region && /^[A-Z0-9]{1,3}$/.test(region) ? `${c}-${region}` : null;
  return { country: c, region: r };
}

/**
 * The `init` call. A visitor who never said yes (allowed only because their
 * country does not ask first) is marked Limited Data Use for every event of
 * the page; with no known country there is nothing to mark, and such a
 * visitor is asked first anyway (lib/pixels.ts needsConsent).
 */
export function redditInitCall(id: string, limited: boolean, place: Place): unknown[] {
  if (!limited || !place.country) return ["init", id];
  return ["init", id, { dpm: "LDU", dpcc: place.country, ...(place.region ? { dprc: place.region } : {}) }];
}

export type RedditEvent =
  | { type: "purchase"; id: string; value: number; currency?: string; productId: string; title: string }
  | { type: "lead"; id?: string }
  | { type: "checkout" };

/** The `track` call for one event, or null when Reddit is not told about it. */
export function redditTrackCall(pixels: Pick<Pixels, "reddit">, event: RedditEvent): unknown[] | null {
  if (!pixels.reddit) return null;
  if (event.type === "purchase") {
    // The order's id as conversionId, the same a server send would carry, so Reddit counts it once (item 6).
    return ["track", "Purchase", { itemCount: 1, value: event.value, currency: (event.currency ?? "usd").toUpperCase(), conversionId: event.id, products: [{ id: event.productId, name: event.title, quantity: 1 }] }];
  }
  if (event.type === "lead") return ["track", "Lead", event.id ? { conversionId: event.id } : {}];
  return null;
}
