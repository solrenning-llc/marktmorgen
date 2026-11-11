/**
 * The declined charges on the creator's own Stripe account (630 [HN6](28)),
 * read for the studio's page of payments that did not go through: at most
 * DECLINE_PAGES pages of a hundred charges since a moment, within one time
 * limit for the whole read (DECLINE_WAIT_MS), `partial` when there were more
 * than were read. Every charge of the account is read, not only this
 * store's: a checkout of one product does not write the store on its
 * payment, and the page says so (so only the account's owner opens it).
 * Nothing is kept.
 *
 * Unknown is never "none": a charge whose status, time, kind or id cannot be
 * read makes the whole read unknown (null), since it may have been declined;
 * a declined charge without a readable amount and currency is counted with
 * both null, never as 0 or as US dollars.
 */
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { onAccount } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";
import { type DeclineRow, reasonOf } from "@/lib/declines-rules";

export const DECLINE_PAGES = 3;
export const DECLINE_DAYS = 30;
/** The whole read, every page together, ends within this; a page cut off by it leaves the read partial. */
export const DECLINE_WAIT_MS = 8_000;

/** What Stripe writes as a charge's status (Charge object, `status`). */
const STATUSES = new Set(["succeeded", "pending", "failed"]);

/**
 * What was read: the declines; whether more charges in the period were left
 * unread (`partial`); how many charges were read in all (`charges`); and the
 * time of the oldest one read (`oldest`, seconds; null when none was), which
 * is how far back a partial read goes.
 */
export type DeclineRead = { rows: DeclineRow[]; partial: boolean; charges: number; oldest: number | null };

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The declines since `since` (seconds), or null when Stripe's answer could not be read. */
export async function readDeclines(store: Pick<Store, "stripeAccountId">, since: number, pages = DECLINE_PAGES, ms = DECLINE_WAIT_MS): Promise<DeclineRead | null> {
  if (!store.stripeAccountId) return null;
  const deadline = Date.now() + ms;
  const rows: DeclineRow[] = [];
  const seen = new Set<string>();
  let oldest: number | null = null;
  const result = (partial: boolean): DeclineRead => ({ rows, partial, charges: seen.size, oldest });
  let after = "";
  for (let page = 0; page < pages; page += 1) {
    const left = deadline - Date.now();
    // Out of time after a page was read: what was read, said to be partial.
    if (left < 50) return page === 0 ? null : result(true);
    let list: Record<string, unknown>;
    try {
      list = await onAccount("GET", store.stripeAccountId, `/charges?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, undefined, undefined, undefined, Math.min(Math.floor(left), STRIPE_TIMEOUT_MS));
    } catch {
      // The first page unanswered is unknown; a later one leaves the older charges unread.
      return page === 0 ? null : result(true);
    }
    // An unreadable page is unknown, never "no declines".
    // Stripe's own list envelope only (Codex G, Claude 1 on #1913): another object, or none, is not a page of charges.
    if (!list || list.object !== "list" || !Array.isArray(list.data) || typeof list.has_more !== "boolean") return null;
    const data = list.data as unknown[];
    for (const raw of data) {
      if (!raw || typeof raw !== "object") return null;
      const charge = raw as Record<string, unknown>;
      if (charge.object !== "charge" || typeof charge.id !== "string" || !charge.id || seen.has(charge.id)) return null;
      if (typeof charge.status !== "string" || !STATUSES.has(charge.status) || !isTime(charge.created)) return null;
      seen.add(charge.id);
      if (oldest === null || charge.created < oldest) oldest = charge.created;
      if (charge.status !== "failed") continue;
      const known = typeof charge.amount === "number" && Number.isSafeInteger(charge.amount) && charge.amount >= 0 && typeof charge.currency === "string" && /^[a-z]{3}$/.test(charge.currency);
      rows.push({
        reason: reasonOf(charge),
        cents: known ? (charge.amount as number) : null,
        currency: known ? (charge.currency as string) : null,
        created: charge.created,
      });
    }
    if (!list.has_more) return result(false);
    // "More" with nothing on the page cannot be followed: unknown.
    const last = (data[data.length - 1] as { id?: unknown } | undefined)?.id;
    if (typeof last !== "string") return null;
    after = last;
  }
  return result(true);
}

/** The moment the page reads from: DECLINE_DAYS ago, in seconds. */
export function declinesSince(days = DECLINE_DAYS, now = Date.now()): number {
  return Math.floor(now / 1000) - days * 86_400;
}
