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
import { withinLimit } from "@/lib/request-guard";
import type { Store } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { takePublicRequest } from "@/lib/traffic";

export async function withinStore(scope: string, who: string, limit: number, windowSeconds: number, store: Store, side: "public" | "buyer" = "public"): Promise<boolean> {
  if (!(await withinLimit(scope, who, limit, windowSeconds))) return false;
  return takePublicRequest(store, side);
}

/**
 * Why a call to another service for a store is refused, or null when it may go: "tries" for the short window, or
 * the store's "integration" figure's own reason with its words (used, no place this month, not counted just now).
 */
export type ServiceRefusal = { reason: "tries" } | { reason: "used" | "pool" | "unknown"; message: string };

export async function withinServiceWhy(scope: string, who: string, limit: number, windowSeconds: number, store: Store): Promise<ServiceRefusal | null> {
  if (!(await withinLimit(scope, who, limit, windowSeconds))) return { reason: "tries" };
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
