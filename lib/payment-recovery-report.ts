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
const BILLING_REASONS = new Set([
  "automatic_pending_invoice_item_invoice", "manual", "quote_accept", "subscription",
  "subscription_create", "subscription_cycle", "subscription_threshold", "subscription_update", "upcoming",
]);

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

const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const unknownReport = () => new Error("Recovered payment figures could not be confirmed");

/** Validate the facts used for filtering and arithmetic before any can become zero. */
function invoiceEvidence(raw: unknown, now: number): raw is Invoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const invoice = raw as Invoice;
  if (typeof invoice.id !== "string" || !/^in_[A-Za-z0-9]+$/.test(invoice.id) ||
      typeof invoice.currency !== "string" || !/^[a-z]{3}$/.test(invoice.currency) ||
      !natural(invoice.amount_paid) || !natural(invoice.attempt_count) ||
      typeof invoice.billing_reason !== "string" || !BILLING_REASONS.has(invoice.billing_reason) ||
      !natural(invoice.status_transitions?.paid_at) || invoice.status_transitions.paid_at === 0 || invoice.status_transitions.paid_at > Math.floor(now / 1000) ||
      (invoice.paid_out_of_band !== undefined && typeof invoice.paid_out_of_band !== "boolean")) return false;
  for (const metadata of [invoice.parent?.subscription_details?.metadata, invoice.subscription_details?.metadata]) {
    if (metadata != null && (typeof metadata !== "object" || Array.isArray(metadata) || Object.values(metadata).some(value => typeof value !== "string"))) return false;
  }
  return true;
}

/** A cached report is evidence too; malformed JSON is not a cache miss. */
function reportEvidence(raw: unknown, store: Store, now: number): raw is RecoveryReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const report = raw as RecoveryReport;
  return natural(report.at) && report.at <= Math.floor(now / 1000) && report.currency === store.currency &&
    [report.recovered, report.cents, report.afterEmail, report.afterEmailCents, report.elsewhere].every(natural) &&
    report.afterEmail <= report.recovered && report.afterEmailCents <= report.cents && typeof report.complete === "boolean" &&
    !!report.month && natural(report.month.failed) && natural(report.month.cards) && natural(report.month.failed + report.month.cards);
}

/** A confirmed absent hash field is zero; other nondecimal values are unknown. */
function countEvidence(raw: unknown): number {
  if (raw === null) return 0;
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw) || !natural(Number(raw))) throw unknownReport();
  return Number(raw);
}

/** Pure: the recovered renewals among a store's paid invoices, given which were emailed about. */
export function recoveredFrom(invoices: Invoice[], handles: Set<string>, currency: string, emailed: Set<string>, now: number) {
  if (!Number.isFinite(now)) throw unknownReport();
  const since = Math.floor(now / 1000) - 30 * DAY;
  const out = { recovered: 0, cents: 0, afterEmail: 0, afterEmailCents: 0, elsewhere: 0 };
  const seen = new Set<string>();
  for (const invoice of invoices) {
    if (!invoiceEvidence(invoice, now) || seen.has(invoice.id as string)) throw unknownReport();
    seen.add(invoice.id as string);
    const id = typeof invoice.id === "string" ? invoice.id : "";
    const paidAt = typeof invoice.status_transitions?.paid_at === "number" ? invoice.status_transitions.paid_at : 0;
    const cents = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
    if (!id || paidAt < since || cents <= 0 || invoice.paid_out_of_band === true) continue;
    if (!handles.has(storeOf(invoice))) continue;
    // Only a subscription cycle is a renewal; other known invoice reasons are not recovered renewals.
    if (invoice.billing_reason !== "subscription_cycle") continue;
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
  if (!Object.values(out).every(natural)) throw unknownReport();
  return out;
}

export async function recoveryReport(store: Store, fresh = false, now = Date.now()): Promise<RecoveryReport | null> {
  const account = store.stripeAccountId;
  if (!account || !store.statsId || !isRedisConfigured()) return null;
  if (!Number.isFinite(now)) throw unknownReport();
  if (!fresh && isRedisConfigured()) {
    const reply = await redisPipeline([["GET", cacheKey(store)]]);
    if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== null && typeof reply[0] !== "string")) throw unknownReport();
    const cached = reply[0];
    if (typeof cached === "string") {
      const report: unknown = JSON.parse(cached);
      if (!reportEvidence(report, store, now)) throw unknownReport();
      return report;
    }
  }
  const invoices: Invoice[] = [];
  const seen = new Set<string>();
  let after = "";
  let complete = false;
  // Created up to 60 days ago: a renewal that failed is retried for weeks
  // before it is paid, and still lands in the last 30 days.
  const createdSince = Math.floor(now / 1000) - 60 * DAY;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ status: "paid", limit: "100", "created[gte]": String(createdSince) });
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", account, `/invoices?${query}`);
    if (!listed || listed.object !== "list" || !Array.isArray(listed.data) || listed.data.length > 100 ||
        typeof listed.has_more !== "boolean" || (listed.has_more && listed.data.length === 0)) throw unknownReport();
    const rows = listed.data as Invoice[];
    for (const invoice of rows) {
      if (!invoiceEvidence(invoice, now) || seen.has(invoice.id as string)) throw unknownReport();
      seen.add(invoice.id as string);
    }
    invoices.push(...rows);
    const last = rows[rows.length - 1];
    if (!listed.has_more) {
      complete = true;
      break;
    }
    after = last.id as string;
  }
  const handles = saleHandles(store);
  const ours = invoices.filter((i) => typeof i.id === "string" && handles.has(storeOf(i)));
  const emailed = new Set<string>();
  if (ours.length && isRedisConfigured()) {
    const found = await redisPipeline(ours.map((i) => ["EXISTS", sentKey(account, i.id as string)]));
    if (!Array.isArray(found) || found.length !== ours.length || found.some(value => value !== 0 && value !== 1)) throw unknownReport();
    ours.forEach((i, n) => {
      if (found[n] === 1) emailed.add(i.id as string);
    });
  }
  const month = { failed: 0, cards: 0 };
  if (isRedisConfigured()) {
    const reply = await redisPipeline([["HMGET", countKey(store.statsId, monthOf(now)), "failed", "cards"]]);
    if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(reply[0]) || reply[0].length !== 2) throw unknownReport();
    month.failed = countEvidence(reply[0][0]);
    month.cards = countEvidence(reply[0][1]);
    if (!natural(month.failed + month.cards)) throw unknownReport();
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
