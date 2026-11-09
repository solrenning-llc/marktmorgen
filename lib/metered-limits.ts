/**
 * A short-window limit and a store's monthly figure, checked together
 * (added 17 October 2026). The short limit (lib/request-guard.ts,
 * withinLimit) keeps one connection or one loop from a burst; the figure is
 * what bounds the store's month, the one each plan's worst month prices
 * (tests/plan-cost-registry.ts):
 *
 *   withinStore    a public request a store answers: its cart, a search, a
 *                  download, the page after paying... counted with the pages
 *                  it draws (lib/traffic.ts, takePublicRequest).
 *   withinService  a call to another service made for a store: counted as
 *                  one of its "integration" figure (lib/store-allowance-rules.ts).
 *
 * The registry finds every scope used with either, so a public path or a
 * call out cannot be added without a figure.
 */
import { withinEssentialLimit, withinLimit } from "@/lib/request-guard";
import type { Store } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { holdPublicRequests, takePublicRequest } from "@/lib/traffic";

export async function withinStore(scope: string, who: string, limit: number, windowSeconds: number, store: Store, side: "public" | "buyer" = "public"): Promise<boolean> {
  return (await withinStoreWhy(scope, who, limit, windowSeconds, store, side)) === null;
}

/**
 * withinStore with the reason it refused: "tries" when the connection's short window is spent (it comes back in minutes),
 * "window" when the store's own window has no room on that side (it comes back only when the window turns).
 *
 * The side "lookup" is for a request that asks about an order before anything proves it is one (lib/order-lookup.ts):
 * it counts on the public side, and a refusal there is NOT left counted. A refused public request stays in the window's
 * one count (lib/traffic.ts, countRequest), which is also the buyers' count, so leaving made-up lookups counted would
 * spend the buyers' reserve just the same.
 */
export async function withinStoreWhy(scope: string, who: string, limit: number, windowSeconds: number, store: Store, side: "public" | "buyer" | "lookup" = "public"): Promise<"tries" | "window" | null> {
  if (!(await withinLimit(scope, who, limit, windowSeconds))) return "tries";
  const taken = side === "lookup" ? await holdPublicRequests(store, 1, Date.now()) : await takePublicRequest(store, side);
  return taken ? null : "window";
}

/**
 * Why a call to another service for a store is refused, or null when it may go: "tries" for the short window, or
 * the store's "integration" figure's own reason with its words (used, no place this month, not counted just now).
 */
export type ServiceRefusal = { reason: "tries" } | { reason: "used" | "pool" | "unknown"; message: string };

export async function withinServiceWhy(scope: string, who: string, limit: number, windowSeconds: number, store: Store): Promise<ServiceRefusal | null> {
  // A confirmed monthly allowance cannot repair an unknown short-window
  // counter. Refuse before taking that allowance or calling the provider.
  if (!(await withinEssentialLimit(scope, who, limit, windowSeconds))) return { reason: "tries" };
  const taken = await takeAllowance(store, "integration");
  return taken.ok ? null : { reason: taken.reason, message: taken.message };
}

export async function withinService(scope: string, who: string, limit: number, windowSeconds: number, store: Store): Promise<boolean> {
  return (await withinServiceWhy(scope, who, limit, windowSeconds, store)) === null;
}

/** A route that answers in JSON: the short window under its own code, the figure with its own words in `message`. */
export function serviceRefusedJson(refusal: ServiceRefusal, code: string): Response {
  return Response.json(refusal.reason === "tries" ? { ok: false, error: code } : { ok: false, error: code, message: refusal.message }, { status: 429 });
}

/** A route that sends the creator back to a page: the short window as `tries`, the figure as "allowance-<reason>". */
export function serviceRefusalCode(refusal: ServiceRefusal, tries: string): string {
  return refusal.reason === "tries" ? tries : `allowance-${refusal.reason}`;
}
