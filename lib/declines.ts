/**
 * The declined charges on the creator's own Stripe account (630 [HN6](28)),
 * read for the studio's page of payments that did not go through: at most
 * DECLINE_PAGES pages of a hundred charges since a moment, `partial` when
 * there were more. Every charge of the account is read, not only this
 * store's: a checkout of one product does not write the store on its
 * payment, and the page says so. Nothing is kept.
 */
import { onAccount } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";
import { type DeclineRow, reasonOf } from "@/lib/declines-rules";

export const DECLINE_PAGES = 3;
export const DECLINE_DAYS = 30;

/** The declines since `since` (seconds), or null when Stripe's answer could not be read whole. */
export async function readDeclines(store: Pick<Store, "stripeAccountId">, since: number, pages = DECLINE_PAGES): Promise<{ rows: DeclineRow[]; partial: boolean } | null> {
  if (!store.stripeAccountId) return null;
  const rows: DeclineRow[] = [];
  const seen = new Set<string>();
  let after = "";
  for (let page = 0; page < pages; page += 1) {
    let list: Record<string, unknown>;
    try {
      list = await onAccount("GET", store.stripeAccountId, `/charges?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
    } catch {
      return null;
    }
    // An unreadable page is unknown, never "no declines".
    if (!list || !Array.isArray(list.data) || typeof list.has_more !== "boolean") return null;
    const data = list.data as Record<string, unknown>[];
    for (const charge of data) {
      if (!charge || typeof charge !== "object" || typeof charge.id !== "string" || seen.has(charge.id)) return null;
      seen.add(charge.id);
      if (charge.status !== "failed") continue;
      rows.push({
        reason: reasonOf(charge),
        cents: typeof charge.amount === "number" && Number.isFinite(charge.amount) ? charge.amount : 0,
        currency: typeof charge.currency === "string" && /^[a-z]{3}$/.test(charge.currency) ? charge.currency : "usd",
        created: typeof charge.created === "number" ? charge.created : 0,
      });
    }
    if (!list.has_more) return { rows, partial: false };
    const last = data[data.length - 1]?.id;
    if (typeof last !== "string") return null;
    after = last;
  }
  return { rows, partial: true };
}

/** The moment the page reads from: DECLINE_DAYS ago, in seconds. */
export function declinesSince(days = DECLINE_DAYS, now = Date.now()): number {
  return Math.floor(now / 1000) - days * 86_400;
}
