/**
 * The daily settling of moves to the monthly price (630 [HN6](14), unit 2c;
 * added 4 November 2026): what lib/yearly-fallback.ts, moveToMonthly, could
 * not finish while the member waited, read again from Stripe and finished,
 * once a day, first thing in the daily recovery job (lib/payment-recovery.ts,
 * recoverFailedPayments). Every call is made on the creator's connected
 * account at FALLBACK_STRIPE_VERSION; nothing here ever charges anyone.
 *
 * Three lists, each member left in place for the next day whenever Stripe
 * gives no certain answer (a timeout, its own failure, a refusal), so nothing
 * is decided on a guess:
 *
 *   - VOID ("account|yearly|monthly"): the month was paid and voiding the
 *     year failed. The year is read again: still open, it is voided; voided
 *     already, nothing is left to do; paid meanwhile, it goes to BOTH.
 *   - CHECK ("account|subscription|yearly"): the move's outcome was not known.
 *     The membership and the year are read again, under the membership's lock:
 *       on the monthly price (its item's interval is "month" and
 *       metadata[monthly_replaced] names this year) with its latest invoice
 *       paid: the year is voided. On the monthly price, the month not paid
 *       yet: left for tomorrow, for at most FALLBACK_CHECK_DAYS from that
 *       invoice; then the year is voided too (auto_advance=false stops only
 *       Stripe's own retries: the year could still be paid by hand on its
 *       page), and the month is what the membership owes. Still on the
 *       yearly price with a
 *       pending update: left for tomorrow (Stripe voids the update's invoice
 *       when it expires, at most 23 hours later). Still on the yearly price
 *       with none: the move was never made, so the year is retried by itself
 *       again (auto_advance=true), as before the member tried. The year paid
 *       meanwhile (by hand, or a payment still processing when the void was
 *       tried) while the membership is on the monthly price: to BOTH; while a
 *       pending update still waits on its month: that month is voided.
 *   - BOTH ("account|yearly|monthly"): the member paid the year and the
 *     month. Decided (4 November 2026): the year is what they paid for in
 *     full, so the year is kept and the month is undone. Under the
 *     membership's lock, in this order:
 *       1. a month still owed is voided, so it is never collected;
 *       2. the membership stays on the monthly price the member chose last,
 *          charging nothing until the end of the year paid (holdBody):
 *          `trial_end` at the end of the yearly invoice's line period,
 *          `proration_behavior=none` (the way Stripe documents to move a
 *          billing date without charging: "Change the billing period using a
 *          trial period", Set the subscription billing renewal date,
 *          docs.stripe.com/billing/subscriptions/billing-cycle, read 4
 *          November 2026; it may make a 0 invoice). Never back on the yearly
 *          price: that would charge a whole year on the day the paid one ends,
 *          against the member's own choice and with no word to them (review
 *          rev28). Stripe shows the membership as trialing until then, which
 *          the creator's note says; metadata[yearly_paid] names the year and
 *          metadata[yearly_paid_until] the day it ends, so a second run never
 *          holds it again and every reader knows this trial is paid;
 *       3. a month paid is refunded in full, never more than the month's
 *          `amount_paid` nor what is left on its charge, reason "duplicate".
 *          The payment is the invoice's own (Invoice object, `payments`,
 *          includable, docs.stripe.com/api/invoices/object, and Invoice
 *          Payment object, `payment.payment_intent` or `payment.charge` with
 *          `status` "paid", docs.stripe.com/api/invoice-payment/object, both
 *          read 4 November 2026: an invoice has had no `payment_intent` or
 *          `charge` of its own since 2025-03-31.basil). Never twice: a mark
 *          per monthly invoice, Stripe's own refunds of that payment read for
 *          one of ours (metadata[fallback_refund]) before a new one, and an
 *          idempotency key. A disputed charge is never refunded: the dispute
 *          is the member's money coming back already;
 *       4. the creator is told in a short note, in English.
 *     Before any of it, the year itself is read: a year refunded in full (on
 *     its charge or by credit notes) or lost in a dispute since is not a paid
 *     year, so nothing is undone and the creator is told: never a free year
 *     (a hold set before is ended at once, so the month is charged from that
 *     day). A courtesy refund of part of it, or a dispute the creator won,
 *     leaves a paid year; a dispute still open waits for its outcome, a month
 *     still owed not collected meanwhile (auto_advance=false, set back if
 *     the year is lost). A hold Stripe refuses for certain (a 4xx) never
 *     holds the refund back: the creator is told to look at the membership,
 *     also when the month was still owed and only voided. A trial keeps its
 *     access; a pause would not. A disputed month, or a month paid with no payment
 *     of its own on Stripe (the member's credit balance, or marked paid
 *     outside Stripe), is settled and the creator told; a part paid from the
 *     credit balance is said. A refund still pending waits until it
 *     succeeded. Such a "trial" is read as paid everywhere (paidYearHeld).
 *
 * Every notice is about the creator's own account and money, so it is the
 * company's email (lib/email.ts, "company"), never taken from the store's
 * own figure; an entry whose notice did not go is kept for the next run, the
 * facts worked out again from Stripe (never a second refund).
 *
 * No invoice is ever voided while a payment on it is still processing (a
 * bank debit): it waits for the next day.
 *
 * Bounded three ways: its own share of the daily job's time
 * (fallbackShare, so the recovery emails after it are never starved), every
 * Stripe call cut to what is left of that share, and FALLBACK_PER_SET entries
 * of each list a run, in a random order. An entry is kept at most
 * FALLBACK_MAX_DAYS from the day the job first saw it; then the creator is
 * told what is left to look at, and it leaves the list once that notice
 * went; one whose notice still does not go FALLBACK_TELL_DAYS later, or an
 * account with no store or no address left to tell, is dropped with a log
 * line. Entries never seen before are taken first, those past their time
 * last, so old ones never crowd new ones out of a run. An account Stripe
 * refuses us (401, 403: disconnected, or the key no longer reaches it) is
 * not read again that run, never taken for "nothing there", and its creator
 * is told at most once a week.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { NIMBUS_FROM, oneAddress, sendEmail } from "@/lib/email";
import { formatMoney } from "@/lib/money";
import { readListings } from "@/lib/catalog";
import { type Listing, type Store, storeForHandle, storeForId } from "@/lib/store";
import { productOfSub } from "@/lib/tier-rules";
import { withLock } from "@/lib/redis-lock";
import {
  FALLBACK_BOTH_KEY,
  FALLBACK_CHECK_KEY,
  FALLBACK_LOCK_SECONDS,
  FALLBACK_STORES_KEY,
  FALLBACK_STRIPE_VERSION,
  FALLBACK_VOID_KEY,
  fallbackLockKey,
} from "@/lib/yearly-fallback";

/** Entries of each list settled a run at most. */
export const FALLBACK_PER_SET = 25;
/**
 * How long a move applied with its first month not paid yet is waited on: longer than a bank debit takes to
 * confirm (Stripe gives SEPA Direct Debit up to 14 business days), and less than a month, so the invoice read is
 * still the move's own and not the next month's.
 */
export const FALLBACK_CHECK_DAYS = 21;
/** The longest an entry stays on a list from the day the job first saw it: past FALLBACK_CHECK_DAYS, with room. */
export const FALLBACK_MAX_DAYS = 45;
/** Past FALLBACK_MAX_DAYS, how long its notice to the creator is tried each day before the entry is dropped with a log line. */
export const FALLBACK_TELL_DAYS = 14;
/** The most of the daily job's time this takes, and never more than a third of what is left. */
export const FALLBACK_SHARE_MS = 12_000;
/** Below this much time left, no new Stripe call is started: the entry waits for the next day. */
const LEAST_CALL_MS = 1_000;
/**
 * A monthly invoice whose refund is settled (made, found made, disputed or nothing left), kept two days, past the
 * next daily run: an entry is taken off BOTH once settled, so the mark only covers a run that stopped between the
 * refund and that; Stripe's own refunds of the payment, read for one of ours (metadata[fallback_refund]) before any
 * new one, are what keep a second refund from ever being made, on any day.
 */
export const fallbackRefundedKey = (invoice: string) => `nl:yearly:fallback:refunded:${invoice}`;
const REFUNDED_SECONDS = 2 * 86_400;
/** When the job first saw each entry (entry -> milliseconds), taken out with it. */
export const FALLBACK_SINCE_KEY = "nl:yearly:fallback:since";
/** An account Stripe refused us, its creator told: at most once a week. */
const deniedKey = (account: string) => `nl:yearly:fallback:denied:${account}`;
const DENIED_SECONDS = 7 * 86_400;

const ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]{6,64}$/;
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;
const INTENT_PATTERN = /^pi_[A-Za-z0-9]{6,64}$/;
const CHARGE_PATTERN = /^(ch|py)_[A-Za-z0-9]{6,64}$/;
const PRICE_PATTERN = /^price_[A-Za-z0-9]{6,64}$/;

export type FallbackSweep = { settled: number; left: number; refunds: number; expired: number; denied: number };
type Step = "done" | "wait";
type Raw = Record<string, unknown>;
type SubRead = {
  id?: unknown;
  status?: unknown;
  pending_update?: unknown;
  trial_end?: unknown;
  metadata?: Record<string, string> | null;
  latest_invoice?: unknown;
  items?: { data?: { id?: unknown; price?: { recurring?: { interval?: unknown } | null } | null }[] };
};
/** One run: its own time, the accounts refused us, its counts. */
type Run = { until: number; denied: Set<string>; out: FallbackSweep };

/** The share of the daily job's time this run may take, from `deadline`: never more than a third of what is left. */
export function fallbackShare(deadline: number, now = Date.now()): number {
  return now + Math.max(0, Math.min(FALLBACK_SHARE_MS, Math.floor((deadline - now) / 3)));
}

class OutOfTime extends Error {
  override name = "OutOfTime";
}
const v = FALLBACK_STRIPE_VERSION;
/** Every call cut to what is left of the run's share, so the job after it keeps its time. */
const ceiling = (run: Run) => {
  const left = Math.floor(run.until - Date.now());
  if (left < LEAST_CALL_MS) throw new OutOfTime("the run's share of time is spent");
  return Math.min(STRIPE_TIMEOUT_MS, left);
};
const get = (run: Run, account: string, path: string) => onAccount("GET", account, path, undefined, v, undefined, ceiling(run));
const post = (run: Run, account: string, path: string, body = new URLSearchParams(), key?: string) => onAccount("POST", account, path, body, v, key, ceiling(run));
/** Stripe says for certain the thing is not there: nothing is left to settle. */
const gone = (error: unknown) => error instanceof StripeError && error.status === 404;
/** Stripe will not let us reach the account at all: disconnected, or the key no longer reaches it. */
const deniedBy = (error: unknown) => error instanceof StripeError && (error.status === 401 || error.status === 403);
/** Refused for certain, the request not done: a 4xx but a 409 (a request under the same key in flight) or a 429. */
const refusedBy = (error: unknown) => error instanceof StripeError && error.status >= 400 && error.status < 500 && ![401, 403, 409, 429].includes(error.status);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const idOf = (value: unknown) => (typeof value === "string" ? value : value && typeof value === "object" ? str((value as { id?: unknown }).id) : "");
/** The subscription an invoice belongs to, where the API versions since 2025 name it. */
const subOf = (invoice: Raw) => idOf((invoice.parent as { subscription_details?: { subscription?: unknown } | null } | null)?.subscription_details?.subscription);
const ended = (sub: SubRead) => sub.status === "canceled" || sub.status === "incomplete_expired";
const interval = (sub: SubRead) => sub.items?.data?.[0]?.price?.recurring?.interval;
/** On the monthly price by this very move: what moveToMonthly writes, read back. */
const movedFor = (sub: SubRead, yearly: string) => interval(sub) === "month" && sub.metadata?.monthly_replaced === yearly;
const add = (key: string, entry: string) => redisPipeline([["SADD", key, entry]]);
const accountOf = (entry: string) => entry.split("|")[0] ?? "";

function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The order a list is taken in: entries never seen first, then those still within FALLBACK_MAX_DAYS, then those past
 * it (whose notice has not gone yet), each group in a random order; so an entry that can never be settled never
 * keeps a new one out of FALLBACK_PER_SET. A list whose times cannot be read is only shuffled.
 */
async function inTurn(entries: string[]): Promise<string[]> {
  if (entries.length <= FALLBACK_PER_SET) return shuffled(entries);
  let seen: unknown[] = [];
  try {
    const [raw] = await redisPipeline([["HMGET", FALLBACK_SINCE_KEY, ...entries]]);
    seen = Array.isArray(raw) ? raw : [];
  } catch (error) {
    console.error("reading when the moves to monthly were first seen failed; taken in a random order", error);
    return shuffled(entries);
  }
  const now = Date.now();
  const groups: string[][] = [[], [], []];
  entries.forEach((entry, i) => {
    const since = Number(seen[i]);
    const group = seen[i] === null || seen[i] === undefined || !Number.isFinite(since) ? 0 : now - since <= FALLBACK_MAX_DAYS * 86_400_000 ? 1 : 2;
    groups[group].push(entry);
  });
  return groups.flatMap(shuffled);
}

/**
 * Settles what moves to the monthly price left behind, until `until` (the daily job passes its own share,
 * fallbackShare). Never throws.
 */
export async function settleFallbacks(until: number): Promise<FallbackSweep> {
  const run: Run = { until, denied: new Set(), out: { settled: 0, left: 0, refunds: 0, expired: 0, denied: 0 } };
  const out = run.out;
  if (!isRedisConfigured()) return out;
  // BOTH last, so a year found paid by the two before is settled the same day.
  const lists: [string, (run: Run, entry: string) => Promise<Step>][] = [
    [FALLBACK_VOID_KEY, settleVoid],
    [FALLBACK_CHECK_KEY, settleCheck],
    [FALLBACK_BOTH_KEY, settleBoth],
  ];
  for (const [key, settle] of lists) {
    let entries: string[] = [];
    try {
      const [raw] = await redisPipeline([["SMEMBERS", key]]);
      entries = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
    } catch (error) {
      console.error("reading the moves to monthly to settle failed", error);
      continue;
    }
    for (const entry of (await inTurn(entries)).slice(0, FALLBACK_PER_SET)) {
      if (Date.now() + LEAST_CALL_MS > until) return out;
      const account = accountOf(entry);
      if (run.denied.has(account)) {
        out.left += 1;
        continue;
      }
      let step: Step = "wait";
      try {
        step = (await expired(run, key, entry)) ?? (await settle(run, entry));
      } catch (error) {
        if (deniedBy(error)) {
          // Never read as "nothing there": the account is left alone for the run, and its creator told.
          run.denied.add(account);
          out.denied += 1;
          console.error("Stripe refuses us this account; its moves to monthly wait, and its creator is told", account, error);
          await tellDenied(account);
        } else if (!(error instanceof Error && (error.name === "LockBusyError" || error.name === "OutOfTime"))) {
          // No certain answer: kept for tomorrow, never decided on a guess.
          console.error("settling a move to monthly failed; kept for tomorrow", error);
        }
      }
      if (step === "done") {
        try {
          await redisPipeline([["SREM", key, entry], ["HDEL", FALLBACK_SINCE_KEY, entry]]);
          out.settled += 1;
        } catch (error) {
          console.error("taking a settled move to monthly off its list failed", error);
        }
      } else out.left += 1;
    }
  }
  return out;
}

/**
 * Past FALLBACK_MAX_DAYS since the job first saw it: the creator is told what is left to look at, and only once the
 * notice is accepted does it leave (never dropped unseen); null while it is not that old.
 */
async function expired(run: Run, key: string, entry: string): Promise<Step | null> {
  const now = Date.now();
  const [, first] = await redisPipeline([["HSETNX", FALLBACK_SINCE_KEY, entry, String(now)], ["HGET", FALLBACK_SINCE_KEY, entry]]);
  const since = Number(first);
  if (!Number.isFinite(since) || now - since <= FALLBACK_MAX_DAYS * 86_400_000) return null;
  const [account = "", a = "", b = ""] = entry.split("|");
  const invoices = (key === FALLBACK_CHECK_KEY ? [b] : [a, b]).filter((id) => INVOICE_PATTERN.test(id));
  const told = await tellCreator(account, null, {
    key: `fallback-expired:${entry}`,
    subject: "A member's move to a monthly price needs a look",
    lines: [
      `A member asked to move from a yearly price to a monthly one, and after ${FALLBACK_MAX_DAYS} days we still could not finish settling it on your Stripe account.`,
      "Nothing more will be done about it automatically. Please look at that customer on your Stripe account, so they are never charged for both the year and a month.",
      ...(key === FALLBACK_BOTH_KEY
        ? ["If the month's invoice is still open, we stopped collecting it while we waited: please void it if the year is paid, or collect it if not."]
        : []),
      ...(invoices.length ? ["", `Invoices to look at: ${invoices.join(", ")}.`] : []),
    ],
  });
  if (told === "unsent") {
    if (now - since <= (FALLBACK_MAX_DAYS + FALLBACK_TELL_DAYS) * 86_400_000) {
      console.error("a move to monthly could not be settled in time, and its notice did not go; kept until it does", entry.slice(0, 200));
      return "wait";
    }
    // Tried every day for FALLBACK_TELL_DAYS: an address that never takes it (suppressed, refused) never will.
    console.error(`a move to monthly could not be settled in time, and its notice did not go in ${FALLBACK_TELL_DAYS} days; taken off`, entry.slice(0, 200));
    run.out.expired += 1;
    return "done";
  }
  console.error("a move to monthly could not be settled in time; taken off", told === "told" ? "its creator told" : "no store to tell", entry.slice(0, 200));
  run.out.expired += 1;
  return "done";
}

/** An entry that cannot be read is no work for anyone: said in the log and taken off. */
function malformed(entry: string): Step {
  console.error("a move to monthly left to settle is malformed; taken off", entry.slice(0, 200));
  return "done";
}

/** An invoice with its payments, each payment's PaymentIntent expanded (the Invoice Payment object, `payment`). */
async function readInvoice(run: Run, account: string, id: string): Promise<Raw> {
  const query = new URLSearchParams();
  query.append("expand[]", "payments.data.payment.payment_intent");
  return get(run, account, `/invoices/${encodeURIComponent(id)}?${query}`);
}
type PaymentRow = { status?: unknown; amount_paid?: unknown; payment?: { payment_intent?: unknown; charge?: unknown } | null };
const paymentsOf = (invoice: Raw) => {
  const rows = (invoice.payments as { data?: unknown } | null)?.data;
  return Array.isArray(rows) ? (rows as PaymentRow[]) : [];
};
/** A payment on the invoice still being processed (a bank debit): such an invoice is never voided. */
const processing = (invoice: Raw) =>
  paymentsOf(invoice).some((row) => {
    const intent = row.payment?.payment_intent;
    return intent && typeof intent === "object" && (intent as { status?: unknown }).status === "processing";
  });

/** Voids an invoice read with readInvoice, unless a payment on it is still processing: false then, to wait. */
async function voidIdle(run: Run, account: string, invoice: Raw): Promise<boolean> {
  if (processing(invoice)) return false;
  await post(run, account, `/invoices/${encodeURIComponent(idOf(invoice.id))}/void`);
  return true;
}

/** VOID: the month was paid, voiding the year failed. */
async function settleVoid(run: Run, entry: string): Promise<Step> {
  const [account = "", yearly = "", monthly = "", ...rest] = entry.split("|");
  if (rest.length || !ACCOUNT_PATTERN.test(account) || !INVOICE_PATTERN.test(yearly) || !INVOICE_PATTERN.test(monthly)) return malformed(entry);
  let year: Raw;
  try {
    year = await readInvoice(run, account, yearly);
  } catch (error) {
    if (gone(error)) return "done";
    throw error;
  }
  if (year.status === "void") return "done";
  if (year.status === "paid") {
    // Paid in the seconds the month was: the month is refunded, never both kept.
    await add(FALLBACK_BOTH_KEY, `${account}|${yearly}|${monthly}`);
    return "done";
  }
  if (year.status === "open" || year.status === "uncollectible") return (await voidIdle(run, account, year)) ? "done" : "wait";
  return "wait";
}

/** CHECK: whether the move was made, and whether its month was paid, read again. */
async function settleCheck(run: Run, entry: string): Promise<Step> {
  const [account = "", subscription = "", yearly = "", ...rest] = entry.split("|");
  if (rest.length || !ACCOUNT_PATTERN.test(account) || !SUB_PATTERN.test(subscription) || !INVOICE_PATTERN.test(yearly)) return malformed(entry);
  return withLock(fallbackLockKey(subscription), FALLBACK_LOCK_SECONDS, 2_000, async (): Promise<Step> => {
    let sub: SubRead;
    let year: Raw;
    try {
      sub = (await get(run, account, `/subscriptions/${encodeURIComponent(subscription)}?expand[]=latest_invoice`)) as SubRead;
      year = await readInvoice(run, account, yearly);
    } catch (error) {
      if (gone(error)) return "done";
      throw error;
    }
    const latest = sub.latest_invoice && typeof sub.latest_invoice === "object" ? (sub.latest_invoice as Raw) : null;
    const latestId = idOf(sub.latest_invoice);
    const moved = movedFor(sub, yearly);

    if (year.status === "paid") {
      // The year was paid (by hand on its page, or a payment that was still processing). On the monthly price, the
      // month is undone (BOTH).
      if (moved && INVOICE_PATTERN.test(latestId) && latestId !== yearly) {
        await add(FALLBACK_BOTH_KEY, `${account}|${yearly}|${latestId}`);
        return "done";
      }
      // Not moved, but a pending update still waits on its month: that month is voided, which cancels the update
      // (Stripe, Pending updates), so paying it later can never move a membership whose year is paid.
      if (!moved && sub.pending_update && latest?.status === "open" && INVOICE_PATTERN.test(latestId) && latestId !== yearly) {
        return (await voidIdle(run, account, await readInvoice(run, account, latestId))) ? "done" : "wait";
      }
      return "done";
    }
    if (year.status === "void") return "done";
    if (year.status !== "open" && year.status !== "uncollectible") return "wait";

    if (moved) {
      if (latest?.status === "paid" && latestId !== yearly) {
        // Moved and the month paid: the year can never be paid as well.
        return (await voidIdle(run, account, year)) ? "done" : "wait";
      }
      const created = num(latest?.created);
      const young = created > 0 && Date.now() / 1000 - created < FALLBACK_CHECK_DAYS * 86_400;
      if ((latest?.status === "open" || latest?.status === "draft") && young) return "wait";
      // The month never came, and the membership is on the monthly price now: what it owes is the month, on Stripe's
      // own retries. The year is voided, so it can no longer be paid by hand from its page or an old email beside the
      // month; a void refused because it was paid meanwhile leaves this here, read as paid tomorrow (BOTH), and a
      // payment of the year still processing waits for its outcome.
      return (await voidIdle(run, account, year)) ? "done" : "wait";
    }
    if (interval(sub) === "year" && !ended(sub)) {
      // A pending update is voided by Stripe when it expires; read again tomorrow.
      if (sub.pending_update) return "wait";
      // Never moved: the year is retried by itself again, as before the member tried.
      if (year.status === "open") await post(run, account, `/invoices/${encodeURIComponent(yearly)}`, new URLSearchParams({ auto_advance: "true" }));
      return "done";
    }
    // Ended, or moved by something else: the year is never turned back on.
    return "done";
  });
}

/** BOTH: the year and the month were both paid, or the month is still owed beside a paid year. */
async function settleBoth(run: Run, entry: string): Promise<Step> {
  const [account = "", yearly = "", monthly = "", ...rest] = entry.split("|");
  if (rest.length || !ACCOUNT_PATTERN.test(account) || !INVOICE_PATTERN.test(yearly) || !INVOICE_PATTERN.test(monthly) || yearly === monthly) return malformed(entry);
  let first: Raw;
  try {
    first = await get(run, account, `/invoices/${encodeURIComponent(monthly)}`);
  } catch (error) {
    if (gone(error)) return "done";
    throw error;
  }
  const subscription = subOf(first);
  if (!SUB_PATTERN.test(subscription)) return malformed(entry);
  return withLock(fallbackLockKey(subscription), FALLBACK_LOCK_SECONDS, 2_000, async (): Promise<Step> => {
    const month = await readInvoice(run, account, monthly);
    const year = await readInvoice(run, account, yearly);
    // Only two invoices of one membership, the year paid: anything else is never refunded.
    if (subOf(year) !== subscription || subOf(month) !== subscription) return malformed(entry);
    if (year.status !== "paid") return "done";
    let sub: SubRead | null = null;
    try {
      sub = (await get(run, account, `/subscriptions/${encodeURIComponent(subscription)}`)) as SubRead;
    } catch (error) {
      if (!gone(error)) throw error;
    }
    const money = (cents: number) => formatMoney(cents, str(month.currency) || str(year.currency) || "usd");
    const invoices = `Invoices: ${yearly} (the year) and ${monthly} (the month).`;
    const sent = (told: Told): Step => {
      if (told === "nostore") console.error("a move to monthly was settled, and its creator has no store or address left to tell", account, monthly);
      return told === "unsent" ? "wait" : "done";
    };
    const path = sub ? `/subscriptions/${encodeURIComponent(idOf(sub.id))}` : "";
    /** Our hold, set by an earlier run on this year: still a trial ending when the year paid ends. */
    const heldHere = Boolean(sub && !ended(sub) && sub.status === "trialing" && sub.metadata?.yearly_paid === yearly);
    /** The month still owed, its collection stopped by us while the year's dispute was open. */
    const pausedHere = (month.status === "open" || month.status === "uncollectible") && (month.metadata as Record<string, string> | null)?.fallback_paused === yearly;

    // 0. A year refunded in full (on its charge or by credit notes) or lost in a dispute since is not a paid year:
    //    nothing is undone, never a free year. A dispute still open waits for its outcome (within FALLBACK_MAX_DAYS),
    //    a month still owed not collected meanwhile, so it is not tried on the member's card again and again.
    const kept = await yearKept(run, account, year);
    if (kept === "open-dispute") {
      if ((month.status === "open" || month.status === "uncollectible") && month.auto_advance !== false && !processing(month)) {
        await post(run, account, `/invoices/${encodeURIComponent(monthly)}`, new URLSearchParams({ auto_advance: "false", "metadata[fallback_paused]": yearly }), `fallback-pause:${monthly}`);
      }
      return "wait";
    }
    if (kept !== "kept") {
      // The month stopped by us is collected again: the year it stood beside is not paid any more.
      if (pausedHere) {
        await post(run, account, `/invoices/${encodeURIComponent(monthly)}`, new URLSearchParams({ auto_advance: "true", "metadata[fallback_paused]": "" }), `fallback-resume:${monthly}`);
      }
      // A hold set for that year ends now, so it is never a free year: the monthly price is charged from today.
      let unheld: "none" | "ended" | "refused" = "none";
      if (heldHere) {
        try {
          await post(
            run,
            account,
            path,
            new URLSearchParams({ trial_end: "now", proration_behavior: "none", "metadata[yearly_paid]": "", "metadata[yearly_paid_until]": "" }),
            `fallback-unhold:${yearly}`,
          );
          unheld = "ended";
        } catch (error) {
          if (!refusedBy(error)) throw error;
          console.error("ending the hold of a year no longer paid was refused; its creator is told", account, idOf(sub?.id), error);
          unheld = "refused";
        }
      }
      const [mark] = await redisPipeline([["GET", fallbackRefundedKey(monthly)]]);
      const refundedBefore = typeof mark === "string" ? /^refunded:(\d+)/.exec(mark) : null;
      const what = kept === "refunded" ? "refunded" : "lost in a dispute";
      return sent(
        await tellCreator(account, sub, {
          key: `fallback-year-undone:${account}:${monthly}`,
          subject: "A member's yearly payment was refunded or disputed",
          lines: [
            `A member paid their yearly renewal while their move to the monthly price was being made, and that yearly payment was ${what} afterwards.`,
            unheld === "ended"
              ? "So the time we held for that year has ended: the membership goes on at the monthly price, and its next monthly payment is taken now."
              : unheld === "refused"
                ? "We held the membership with nothing to pay until the end of that year, and could not end that hold by itself. Please end its trial on your Stripe account, so the year is not given for free."
                : `So the membership stays on the monthly price${pausedHere ? ", and its monthly payment is collected again" : ""}.`,
            refundedBefore ? `We had refunded the month, ${money(Number(refundedBefore[1]))}, before the year was ${what}; that refund stands.` : "Nothing more was refunded by us.",
            "",
            invoices,
          ],
        }),
      );
    }

    // 1. A month still owed is never collected (unless a payment on it is still processing: then it waits).
    if (month.status === "open" || month.status === "uncollectible") {
      if (!(await voidIdle(run, account, month))) return "wait";
    } else if (month.status !== "paid" && month.status !== "void") return "wait";

    // 2. Held on the monthly price the member chose, nothing charged until the year paid ends, so the year is never
    //    paid on top of; never moved back to the yearly price, which would charge a year when it ends.
    const back = sub ? await hold(run, account, sub, year, yearly) : "ended";
    const where = whereWords(back, yearEnd(year)?.end ?? 0);
    const settledBack = back === "held";

    // 3. A month paid is refunded in full, once; anything that cannot be refunded is said to the creator.
    if (month.status !== "paid") {
      if (settledBack || back === "ended") return "done";
      // The month was voided, but the membership could not be held by itself: the creator is told.
      return sent(
        await tellCreator(account, sub, {
          key: `fallback-back:${account}:${monthly}`,
          subject: "A member's yearly payment needs a look",
          lines: ["A member paid their yearly renewal while their move to the monthly price was being made. The monthly payment was not taken.", where, "", invoices],
        }),
      );
    }
    const outcome = await refundMonth(run, account, yearly, monthly, month);
    if (outcome.kind === "pending") return "wait";
    const credit = Math.max(0, num(month.total) - num(month.amount_paid));
    const creditLine = credit > 0 && outcome.kind !== "no-payment" ? [`Part of the month, ${money(credit)}, was paid from the member's credit balance on your Stripe account; it was not given back by itself. If they are owed it, please credit it back.`] : [];
    if (outcome.kind === "refunded") {
      const paidMonth = num(month.amount_paid);
      const told = await tellCreator(account, sub, {
        key: `fallback-both:${account}:${monthly}`,
        subject: "A member's extra month was refunded",
        lines: [
          "A member paid their yearly renewal while their move to the monthly price was being made, so they paid for both.",
          outcome.amount >= paidMonth
            ? `The year is kept. The month, ${money(outcome.amount)}, was refunded in full.`
            : `The year is kept. Of the month's ${money(paidMonth)}, we refunded ${money(outcome.amount)}${outcome.earlier > 0 ? `; ${money(outcome.earlier)} of it had been refunded before` : ""}.`,
          ...creditLine,
          where,
          "",
          `${invoices} It is all on your own Stripe account, under that customer.`,
        ],
      });
      if (told !== "unsent" && !outcome.again) run.out.refunds += 1;
      return sent(told);
    }
    if (outcome.kind === "disputed") {
      return sent(
        await tellCreator(account, sub, {
          key: `fallback-disputed:${account}:${monthly}`,
          subject: "A member disputed an extra month they paid",
          lines: [
            "A member paid their yearly renewal while their move to the monthly price was being made, so they paid for both.",
            "They disputed the month's payment with their bank, so we did not refund it: the dispute is how that money goes back to them.",
            "Please accept the dispute on your Stripe account. If you counter it and win, they will have paid for both the year and the month.",
            ...creditLine,
            where,
            "",
            invoices,
          ],
        }),
      );
    }
    if (outcome.kind === "no-payment") {
      return sent(
        await tellCreator(account, sub, {
          key: `fallback-nopay:${account}:${monthly}`,
          subject: "A member paid an extra month that needs a look",
          lines: [
            "A member paid their yearly renewal while their move to the monthly price was being made, so they paid for both.",
            `The month (${money(num(month.amount_paid) || num(month.total))}) was paid without a card payment on Stripe: from the member's credit balance, or marked paid outside Stripe. So nothing was refunded by itself. If they are owed it, please refund or credit it on your Stripe account.`,
            where,
            "",
            invoices,
          ],
        }),
      );
    }
    // "none": the payment was refunded in full before, by someone else; only what could not go back is said.
    if (creditLine.length || !settledBack) {
      return sent(
        await tellCreator(account, sub, {
          key: `fallback-back:${account}:${monthly}`,
          subject: "A member's yearly payment needs a look",
          lines: ["A member paid their yearly renewal while their move to the monthly price was being made.", ...creditLine, where, "", invoices],
        }),
      );
    }
    return "done";
  });
}

type Back = "held" | "refused" | "skipped" | "ended";

/** What the creator is told of where the membership is now, from what hold did. */
function whereWords(back: Back, end: number): string {
  const until = end > 0 ? new Date(end * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
  if (back === "held" && until) {
    return `Their membership stays on the monthly price with nothing more to pay until ${until}, the end of the year they paid. Stripe shows it as a trial until then, but the year is paid. After that, it renews each month, as they chose.`;
  }
  if (back === "ended") return "The membership has ended since, so nothing more will be charged.";
  return "We could not hold it with nothing to pay until the end of the year they paid, so it was left as it is. Please look at its next payment on your Stripe account, so they are not charged again before the year they paid ends.";
}

/** The yearly invoice's own line: the price paid and when the year paid ends. */
function yearEnd(year: Raw): { price: string; end: number } | null {
  const lines = (year.lines as { data?: unknown } | null)?.data;
  for (const line of Array.isArray(lines) ? (lines as Raw[]) : []) {
    const price = idOf((line.pricing as { price_details?: { price?: unknown } | null } | null)?.price_details?.price);
    const end = (line.period as { end?: unknown } | null)?.end;
    if (PRICE_PATTERN.test(price) && typeof end === "number") return { price, end };
  }
  return null;
}

/** The charge behind one paid payment of an invoice read with readInvoice: its PaymentIntent's latest, or itself. */
async function chargeOf(run: Run, account: string, row: PaymentRow): Promise<{ by: [string, string]; charge: Raw } | null> {
  const intent = idOf(row.payment?.payment_intent);
  const chargeId = idOf(row.payment?.charge);
  if (INTENT_PATTERN.test(intent)) {
    const pi = await get(run, account, `/payment_intents/${encodeURIComponent(intent)}?expand[]=latest_charge`);
    const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as Raw) : null;
    if (!charge || typeof charge.amount !== "number") throw new Error("a payment's charge could not be read");
    return { by: ["payment_intent", intent], charge };
  }
  if (CHARGE_PATTERN.test(chargeId)) {
    const charge = await get(run, account, `/charges/${encodeURIComponent(chargeId)}`);
    if (typeof charge.amount !== "number") throw new Error("a payment's charge could not be read");
    return { by: ["charge", chargeId], charge };
  }
  return null;
}

/** The paid payments of an invoice, read in full: the expanded list, then Stripe's own list when it holds more. */
async function paidPayments(run: Run, account: string, invoice: Raw): Promise<PaymentRow[]> {
  const listed = invoice.payments as { has_more?: unknown } | null;
  if (listed?.has_more !== true) return paymentsOf(invoice).filter((row) => row.status === "paid");
  const query = new URLSearchParams({ invoice: idOf(invoice.id), status: "paid", limit: "100" });
  const read = await get(run, account, `/invoice_payments?${query}`);
  if (read.has_more === true) throw new Error("more paid payments on one invoice than are read");
  return (Array.isArray(read.data) ? (read.data as PaymentRow[]) : []).filter((row) => row.status === "paid");
}

/**
 * Where a disputed charge stands, from Stripe's own disputes of it (Dispute object, `status`,
 * docs.stripe.com/api/disputes/object): won (or closed with no chargeback) keeps the money with the creator; lost
 * gives it back; anything else is still open.
 */
async function disputeOf(run: Run, account: string, chargeId: string): Promise<"won" | "lost" | "open"> {
  const read = await get(run, account, `/disputes?${new URLSearchParams({ charge: chargeId, limit: "10" })}`);
  const rows = Array.isArray(read.data) ? (read.data as Raw[]) : [];
  if (!rows.length) return "open";
  if (rows.some((d) => d.status === "lost")) return "lost";
  if (rows.every((d) => d.status === "won" || d.status === "warning_closed" || d.status === "prevented")) return "won";
  return "open";
}

/**
 * Whether the year is still a paid year. Refunded only when refunded in full (its charge's `refunded`, or its whole
 * amount, or credit notes for all of what was paid): a small courtesy refund leaves a paid year. Disputed only when
 * the dispute was lost: one the creator won leaves a paid year, one still open waits.
 */
async function yearKept(run: Run, account: string, year: Raw): Promise<"kept" | "refunded" | "disputed" | "open-dispute"> {
  const paid = num(year.amount_paid);
  if (paid > 0 && num(year.post_payment_credit_notes_amount) >= paid) return "refunded";
  for (const row of await paidPayments(run, account, year)) {
    const found = await chargeOf(run, account, row);
    if (!found) continue;
    const charge = found.charge;
    if (charge.refunded === true || (num(charge.amount) > 0 && num(charge.amount_refunded) >= num(charge.amount))) return "refunded";
    if (charge.disputed === true) {
      const outcome = await disputeOf(run, account, idOf(charge.id));
      if (outcome === "lost") return "disputed";
      if (outcome === "open") return "open-dispute";
    }
  }
  return "kept";
}

/**
 * The membership held on the monthly price the member chose, with nothing charged until the year paid ends
 * (holdBody); never twice, never a charge. It keeps its access (a trial is a live membership,
 * lib/membership-access.ts; a paused one is not). Never moved back to the yearly price: on the day the paid year ends
 * Stripe would charge a whole year, with no word to the member, against their last choice (review rev28).
 */
async function hold(run: Run, account: string, sub: SubRead, year: Raw, yearly: string): Promise<Back> {
  if (ended(sub)) return "ended";
  if (sub.metadata?.yearly_paid === yearly) return "held";
  if (!movedFor(sub, yearly)) {
    console.error("a membership paid twice is not on the monthly price of its move; left as it is", account, idOf(sub.id));
    return "skipped";
  }
  const paid = yearEnd(year);
  if (!paid || paid.end <= Math.floor(Date.now() / 1000) + 3_600) {
    console.error("a membership paid twice has no year left to hold; left on the monthly price", account, idOf(sub.id));
    return "skipped";
  }
  try {
    await post(run, account, `/subscriptions/${encodeURIComponent(idOf(sub.id))}`, holdBody(paid.end, yearly), `fallback-hold:${yearly}`);
    return "held";
  } catch (error) {
    if (!refusedBy(error)) throw error;
    console.error("holding a membership paid twice on its monthly price was refused; its creator is told", account, idOf(sub.id), error);
    return "refused";
  }
}

/**
 * The hold, as Stripe is sent it: the same monthly price, nothing charged until `end` (a trial sets no new price, so
 * no new billing period begins), the paid year named and the day it ends, so every reader knows this trial is paid
 * while it lasts (lib/yearly-switch-rules.ts, paidYearHeld).
 */
export function holdBody(end: number, yearly: string): URLSearchParams {
  return new URLSearchParams({ trial_end: String(end), proration_behavior: "none", "metadata[yearly_paid]": yearly, "metadata[yearly_paid_until]": String(end) });
}

type RefundOutcome =
  | { kind: "refunded"; amount: number; again: boolean; earlier: number }
  | { kind: "pending" }
  | { kind: "disputed" }
  | { kind: "no-payment" }
  | { kind: "none" };

/**
 * The month's payment refunded in full, once; a month with nothing to refund settles too, never kept. Worked out
 * from Stripe each time (the mark only spares calls), so a notice that did not go is sent again with the same facts.
 * A refund still pending waits until it succeeded.
 */
async function refundMonth(run: Run, account: string, yearly: string, monthly: string, month: Raw): Promise<RefundOutcome> {
  const mark = fallbackRefundedKey(monthly);
  const [settled] = await redisPipeline([["GET", mark]]);
  const before = typeof settled === "string" ? /^refunded:(\d+)(?::(\d+))?$/.exec(settled) : null;
  if (before) return { kind: "refunded", amount: Number(before[1]), again: true, earlier: Number(before[2] ?? 0) };
  if (settled === "disputed" || settled === "no-payment" || settled === "none") return { kind: settled };
  const done = (why: string) => redisPipeline([["SET", mark, why, "EX", REFUNDED_SECONDS]]);

  const rows = await paidPayments(run, account, month);
  let gave = 0;
  /** Refunded on the month's payments before, by someone else (the creator, at Stripe): said, never given twice. */
  let earlier = 0;
  let disputed = false;
  let found = false;
  let pending = false;
  let paidOnInvoice = num(month.amount_paid);
  for (const row of rows) {
    const paid = await chargeOf(run, account, row);
    if (!paid) continue;
    found = true;
    if (paid.charge.disputed === true) {
      disputed = true;
      continue;
    }
    // One made here before, under this invoice: never a second (Stripe's own list, read in full).
    const ours = await ourRefund(run, account, paid.by, monthly);
    if (ours) {
      if (ours.status !== "succeeded") pending = true;
      gave += num(ours.amount);
      earlier += Math.max(0, num(paid.charge.amount_refunded) - num(ours.amount));
      paidOnInvoice -= num(ours.amount);
      continue;
    }
    earlier += Math.max(0, num(paid.charge.amount_refunded));
    const left = num(paid.charge.amount) - num(paid.charge.amount_refunded);
    const give = Math.min(paidOnInvoice, typeof row.amount_paid === "number" ? row.amount_paid : paidOnInvoice, left);
    if (give <= 0) continue;
    let made: Raw;
    try {
      made = await post(
        run,
        account,
        "/refunds",
        new URLSearchParams({ [paid.by[0]]: paid.by[1], amount: String(give), reason: "duplicate", "metadata[fallback_refund]": monthly, "metadata[fallback_year]": yearly }),
        `fallback-refund:${monthly}:${paid.by[1]}`,
      );
    } catch (error) {
      if (error instanceof StripeError && (error.code === "charge_disputed" || error.code === "refund_disputed_payment")) {
        disputed = true;
        continue;
      }
      if (error instanceof StripeError && error.code === "charge_already_refunded") continue;
      throw error;
    }
    if (made.status !== "succeeded") pending = true;
    gave += give;
    paidOnInvoice -= give;
  }
  if (pending) return { kind: "pending" };
  if (gave > 0) {
    await done(`refunded:${gave}:${earlier}`);
    return { kind: "refunded", amount: gave, again: false, earlier };
  }
  const kind = disputed ? "disputed" : found ? "none" : "no-payment";
  await done(kind);
  return { kind };
}
/** A refund of ours already made on this payment, from Stripe's own list read in full (a few pages at most). */
async function ourRefund(run: Run, account: string, by: [string, string], monthly: string): Promise<Raw | null> {
  let after = "";
  for (let page = 0; page < 5; page += 1) {
    const query = new URLSearchParams({ [by[0]]: by[1], limit: "100" });
    if (after) query.set("starting_after", after);
    const made = await get(run, account, `/refunds?${query}`);
    const rows = Array.isArray(made.data) ? (made.data as Raw[]) : [];
    const ours = rows.find(
      (r) => (r.metadata as Record<string, string> | null)?.fallback_refund === monthly && r.status !== "failed" && r.status !== "canceled",
    );
    if (ours) return ours;
    if (made.has_more !== true || !rows.length) return null;
    after = idOf(rows[rows.length - 1].id);
  }
  // Never taken for "none of ours": more refunds than are read, so it waits.
  throw new Error("more refunds on one payment than are read");
}

/** The store an account belongs to: by the membership's own store, else by the account recorded with the move. */
async function storeOf(account: string, sub: SubRead | null): Promise<Store | null> {
  const handle = str(sub?.metadata?.store);
  const byHandle = handle ? await storeForHandle(handle) : null;
  if (byHandle?.stripeAccountId === account) return byHandle;
  const [sid] = await redisPipeline([["HGET", FALLBACK_STORES_KEY, account]]);
  const byId = typeof sid === "string" && sid ? await storeForId(sid) : null;
  return byId?.stripeAccountId === account ? byId : null;
}

/** Stripe refuses us the account: its creator is told, at most once a week (again the next run if it did not go). */
async function tellDenied(account: string): Promise<void> {
  if (!ACCOUNT_PATTERN.test(account)) return;
  const [first] = await redisPipeline([["SET", deniedKey(account), "1", "NX", "EX", DENIED_SECONDS]]);
  if (first === null) return;
  const told = await tellCreator(account, null, {
    key: `fallback-denied:${account}:${Math.floor(Date.now() / (DENIED_SECONDS * 1000))}`,
    subject: "We cannot reach your Stripe account",
    lines: [
      "A member moved, or asked to move, from a yearly price to a monthly one, and we need to finish that on your Stripe account so they are never charged for both.",
      "Stripe no longer lets us reach your account. Please connect it again from your studio; until then, please look at your members whose yearly renewal failed on Stripe.",
    ],
  });
  if (told === "unsent") await redisPipeline([["DEL", deniedKey(account)]]).catch(() => {});
}

type Note = { key: string; subject: string; lines: string[] };
/** Whether a notice went: accepted by the sender, no store to tell (nothing more can be done), or not sent. */
type Told = "told" | "nostore" | "unsent";

/**
 * A short note to the creator, in English, about their own account and their money: counted as the company's
 * (lib/email.ts, "company": "what we send a creator about their own account"), never against the store's own
 * figure, which an ended plan or a trial may have spent. What did not go is said, so the entry is kept for it.
 */
async function tellCreator(account: string, sub: SubRead | null, note: Note): Promise<Told> {
  try {
    const store = await storeOf(account, sub);
    // No store, or no address an email can ever go to: nothing more can be done by email (said in the log by the caller).
    if (!store || !oneAddress(store.email)) return "nostore";
    const productId = sub ? productOfSub(sub as Parameters<typeof productOfSub>[0]) : "";
    const [product] = productId ? await readListings(store, [productId]).catch(() => [] as Listing[]) : [];
    const subject = product?.title ? `${note.subject} for ${product.title}` : note.subject;
    const ok = await sendEmail({
      meter: { by: "company" },
      from: NIMBUS_FROM,
      to: store.email,
      subject: subject.slice(0, 200),
      text: note.lines.join("\n"),
      idempotencyKey: note.key.slice(0, 200),
    });
    return ok ? "told" : "unsent";
  } catch (error) {
    console.error("a notice to a creator about a move to monthly failed", error);
    return "unsent";
  }
}
