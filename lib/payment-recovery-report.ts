/**
 * How much of what failed came back (added 12 October 2026). Paddle Retain
 * sells this as "Recovered MRR" and Baremetrics Recover as its dashboard;
 * here it is read from the creator's own Stripe account, so it is their own
 * truth and nothing is written about anybody to work it out.
 *
 * A payment counts as recovered when a renewal of this store was paid in the
 * last 30 days after it had failed at least once: Stripe tried the card more
 * than once, or the member was emailed about it failing (lib/payment-recovery.ts,
 * which only writes about a payment that failed). "After an email" is the
 * second of those: the ones paid once the member had been told.
 *
 * Read when the studio's Membership numbers page opens, at most every ten
 * minutes, never on a visit to the store. And the emails the daily job sent
 * this month, counted as it sends them (lib/dunning-keys.ts).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { type Store, saleHandles } from "@/lib/store";
import { countKey, monthOf, sentKey } from "@/lib/dunning-keys";

const DAY = 86_400;
const MAX_PAGES = 10;
const CACHE_SECONDS = 10 * 60;

// v2: with the renewals in another currency counted (22 [E5], unit 2e).
const cacheKey = (store: Store) => `nl:dun:report:${store.statsId}:v2`;

export type RecoveryReport = {
  /** When Stripe was read, in seconds. */
  at: number;
  currency: string;
  /** Renewals paid in the last 30 days after failing at least once, and what they came to. */
  recovered: number;
  cents: number;
  /** Of them, those paid after the member was emailed about it. */
  afterEmail: number;
  afterEmailCents: number;
  /**
   * Of the same renewals, those paid in another currency than the store's (a
   * membership sold before it changed its currency renews in the old one):
   * counted, never added to the amounts (22 [E5], unit 2e).
   */
  elsewhere: number;
  /** Emails the daily job sent this month: about failed payments, and about cards. */
  month: { failed: number; cards: number };
  /** False when there were more paid invoices than one reading takes. */
  complete: boolean;
};

type Invoice = {
  id?: unknown;
  currency?: unknown;
  amount_paid?: unknown;
  attempt_count?: unknown;
  paid_out_of_band?: unknown;
  billing_reason?: unknown;
  status_transitions?: { paid_at?: unknown } | null;
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null;
};

/** The store an invoice's membership was sold by, under either place Stripe has kept it. */
const storeOf = (invoice: Invoice) => invoice.parent?.subscription_details?.metadata?.store ?? invoice.subscription_details?.metadata?.store ?? "";

/** Pure: the recovered renewals among a store's paid invoices, given which were emailed about. */
export function recoveredFrom(invoices: Invoice[], handles: Set<string>, currency: string, emailed: Set<string>, now: number) {
  const since = Math.floor(now / 1000) - 30 * DAY;
  const out = { recovered: 0, cents: 0, afterEmail: 0, afterEmailCents: 0, elsewhere: 0 };
  for (const invoice of invoices) {
    const id = typeof invoice.id === "string" ? invoice.id : "";
    const paidAt = typeof invoice.status_transitions?.paid_at === "number" ? invoice.status_transitions.paid_at : 0;
    const cents = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
    if (!id || paidAt < since || cents <= 0 || invoice.paid_out_of_band === true) continue;
    if (!handles.has(storeOf(invoice))) continue;
    // A renewal, not the first payment of a membership (which is the checkout's).
    if (invoice.billing_reason === "subscription_create") continue;
    const told = emailed.has(id);
    const retried = typeof invoice.attempt_count === "number" && invoice.attempt_count >= 2;
    if (!told && !retried) continue;
    if (invoice.currency !== currency) {
      out.elsewhere += 1;
      continue;
    }
    out.recovered += 1;
    out.cents += cents;
    if (told) {
      out.afterEmail += 1;
      out.afterEmailCents += cents;
    }
  }
  return out;
}

export async function recoveryReport(store: Store, fresh = false, now = Date.now()): Promise<RecoveryReport | null> {
  const account = store.stripeAccountId;
  if (!account || !store.statsId) return null;
  if (!fresh && isRedisConfigured()) {
    const [cached] = await redisPipeline([["GET", cacheKey(store)]]);
    if (typeof cached === "string") {
      try {
        return JSON.parse(cached) as RecoveryReport;
      } catch {
        // Read again below.
      }
    }
  }
  const invoices: Invoice[] = [];
  let after = "";
  let complete = false;
  // Created up to 60 days ago: a renewal that failed is retried for weeks
  // before it is paid, and still lands in the last 30 days.
  const createdSince = Math.floor(now / 1000) - 60 * DAY;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ status: "paid", limit: "100", "created[gte]": String(createdSince) });
    if (after) query.set("starting_after", after);
    const listed = (await onAccount("GET", account, `/invoices?${query}`)) as { data?: unknown; has_more?: unknown };
    const rows = (Array.isArray(listed.data) ? listed.data : []) as Invoice[];
    invoices.push(...rows);
    const last = rows[rows.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") {
      complete = true;
      break;
    }
    after = last.id;
  }
  const handles = saleHandles(store);
  const ours = invoices.filter((i) => typeof i.id === "string" && handles.has(storeOf(i)));
  const emailed = new Set<string>();
  if (ours.length && isRedisConfigured()) {
    const found = await redisPipeline(ours.map((i) => ["EXISTS", sentKey(account, i.id as string)]));
    ours.forEach((i, n) => {
      if (Number(found[n]) > 0) emailed.add(i.id as string);
    });
  }
  const month = { failed: 0, cards: 0 };
  if (isRedisConfigured()) {
    const [counts] = await redisPipeline([["HMGET", countKey(store.statsId, monthOf(now)), "failed", "cards"]]);
    if (Array.isArray(counts)) {
      month.failed = Number(counts[0]) || 0;
      month.cards = Number(counts[1]) || 0;
    }
  }
  const report: RecoveryReport = {
    at: Math.floor(now / 1000),
    currency: store.currency,
    ...recoveredFrom(ours, handles, store.currency, emailed, now),
    month,
    complete,
  };
  if (isRedisConfigured()) await redisPipeline([["SET", cacheKey(store), JSON.stringify(report), "EX", CACHE_SECONDS]]).catch(() => {});
  return report;
}
