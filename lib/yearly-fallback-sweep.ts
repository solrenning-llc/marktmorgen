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
 *       2. the membership goes back to the year's own price, charging
 *          nothing until the end of the year paid: `trial_end` at the end of
 *          the yearly invoice's line period, `proration_behavior=none` (the
 *          way Stripe documents to move a billing date without charging:
 *          "Change the billing period using a trial period", Set the
 *          subscription billing renewal date, docs.stripe.com/billing/
 *          subscriptions/billing-cycle, read 4 November 2026; it may make a
 *          0 invoice). Stripe shows the membership as trialing until then,
 *          which the creator's note says; metadata[yearly_paid] names the
 *          year, so a second run never moves it again;
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
 *       4. the creator is told in a short note, in English, from the store's
 *          own email figure, only by the run that made the refund.
 *     Before any of it, the year itself is read: a year refunded (on its
 *     charge or by a credit note) or disputed since is not a paid year, so
 *     nothing is undone and the creator is told: never a free year. A move
 *     back that Stripe refuses for certain (a 4xx: the yearly price archived,
 *     say), or a subscription in flexible billing mode, does not hold the
 *     refund back: the month is refunded and the creator is told the
 *     membership is still monthly. A disputed month, or a month paid with no
 *     payment of its own on Stripe (the member's credit balance, or marked
 *     paid outside Stripe), is settled and the creator told, never kept.
 *
 * No invoice is ever voided while a payment on it is still processing (a
 * bank debit): it waits for the next day.
 *
 * Bounded three ways: its own share of the daily job's time
 * (fallbackShare, so the recovery emails after it are never starved), every
 * Stripe call cut to what is left of that share, and FALLBACK_PER_SET entries
 * of each list a run, in a random order. An entry is kept at most
 * FALLBACK_MAX_DAYS from the day the job first saw it; then the creator is
 * told what is left to look at, and it leaves the list. An account Stripe
 * refuses us (401, 403: disconnected, or the key no longer reaches it) is
 * not read again that run, never taken for "nothing there", and its creator
 * is told at most once a week.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
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
  billing_mode?: { type?: unknown } | null;
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
    for (const entry of shuffled(entries).slice(0, FALLBACK_PER_SET)) {
      if (Date.now() + LEAST_CALL_MS > until) return out;
      const account = accountOf(entry);
      if (run.denied.has(account)) {
        out.left += 1;
        continue;
      }
      let step: Step = "wait";
      try {
        step = (await expired(run, key, entry)) ? "done" : await settle(run, entry);
      } catch (error) {
        if (deniedBy(error)) {
          // Never read as "nothing there": the account is left alone for the run, and its creator told.
          run.denied.add(account);
          out.denied += 1;
          console.error("Stripe refuses us this account; its moves to monthly wait, and its creator is told", account, error);
          await tellDenied(account).catch((failure) => console.error("telling a creator their Stripe account cannot be reached failed", failure));
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

/** Past FALLBACK_MAX_DAYS since the job first saw it: the creator is told what is left to look at, and it leaves. */
async function expired(run: Run, key: string, entry: string): Promise<boolean> {
  const now = Date.now();
  const [, first] = await redisPipeline([["HSETNX", FALLBACK_SINCE_KEY, entry, String(now)], ["HGET", FALLBACK_SINCE_KEY, entry]]);
  const since = Number(first);
  if (!Number.isFinite(since) || now - since <= FALLBACK_MAX_DAYS * 86_400_000) return false;
  const [account = "", a = "", b = ""] = entry.split("|");
  console.error("a move to monthly could not be settled in time; taken off, its creator told", entry.slice(0, 200));
  run.out.expired += 1;
  const invoices = (key === FALLBACK_CHECK_KEY ? [b] : [a, b]).filter((id) => INVOICE_PATTERN.test(id));
  await tellCreator(account, null, {
    kind: "expired",
    key: `fallback-expired:${entry}`,
    subject: "A member's move to a monthly price needs a look",
    lines: [
      `A member asked to move from a yearly price to a monthly one, and after ${FALLBACK_MAX_DAYS} days we still could not finish settling it on your Stripe account.`,
      "Nothing more will be done about it automatically. Please look at that customer on your Stripe account, so they are never charged for both the year and a month.",
      ...(invoices.length ? ["", `Invoices to look at: ${invoices.join(", ")}.`] : []),
    ],
  }).catch((error) => console.error("telling a creator about a move left unsettled failed", error));
  return true;
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

    // 0. A year refunded or disputed since is not a paid year: nothing is undone, never a free year.
    const kept = await yearKept(run, account, year);
    if (kept !== "kept") {
      const [first] = await redisPipeline([["SET", fallbackRefundedKey(monthly), `year-${kept}`, "NX", "EX", REFUNDED_SECONDS]]);
      if (first !== null) {
        await tellCreator(account, sub, {
          kind: "year-undone",
          key: `fallback-year-undone:${account}:${monthly}`,
          subject: "A member's yearly payment was refunded or disputed",
          lines: [
            `A member paid their yearly renewal while their move to the monthly price was being made, and that yearly payment was ${kept === "refunded" ? "refunded" : "disputed"} afterwards.`,
            "So the membership stays on the monthly price, the monthly payment is kept, and nothing was refunded by us.",
            "",
            `Invoices: ${yearly} (the year, ${kept}) and ${monthly} (the month).`,
          ],
        }).catch((error) => console.error("a note about a yearly payment undone failed", error));
      }
      return "done";
    }

    // 1. A month still owed is never collected (unless a payment on it is still processing: then it waits).
    if (month.status === "open" || month.status === "uncollectible") {
      if (!(await voidIdle(run, account, month))) return "wait";
    } else if (month.status !== "paid" && month.status !== "void") return "wait";

    // 2. Back on the year's own price, nothing charged until the year paid ends.
    const back = sub ? await moveBack(run, account, sub, year, yearly) : "skipped";
    const until = back === "moved" || back === "already" ? yearEnd(year)?.end ?? 0 : 0;
    const where =
      until > 0
        ? `Their membership is back on the yearly price, with nothing more to pay until ${new Date(until * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}. Stripe shows it as a trial until then; the year is paid.`
        : "Their membership could not be moved back to the yearly price by itself, so it is still monthly. Please move it on your Stripe account, so the next month is not charged.";

    // 3. A month paid is refunded in full, once; anything that cannot be refunded is said to the creator.
    if (month.status !== "paid") return "done";
    const outcome = await refundMonth(run, account, yearly, monthly, month);
    const invoices = `Invoices: ${yearly} (the year, kept) and ${monthly} (the month).`;
    if (outcome.kind === "refunded") {
      run.out.refunds += 1;
      await tellCreator(account, sub, {
        kind: "refunded",
        key: `fallback-both:${account}:${monthly}`,
        subject: "A member's extra month was refunded",
        lines: [
          "A member paid their yearly renewal while their move to the monthly price was being made, so they paid for both.",
          `The year is kept. The month, ${money(outcome.amount)}, was refunded in full.`,
          where,
          "",
          `${invoices} It is all on your own Stripe account, under that customer.`,
        ],
      }).catch((error) => console.error("a note about a refunded month failed", error));
    } else if (outcome.kind === "disputed") {
      await tellCreator(account, sub, {
        kind: "disputed",
        key: `fallback-disputed:${account}:${monthly}`,
        subject: "A member disputed an extra month they paid",
        lines: [
          "A member paid their yearly renewal while their move to the monthly price was being made, so they paid for both.",
          "They disputed the month's payment with their bank, so we did not refund it: the dispute is how that money goes back. You can answer the dispute on your Stripe account.",
          where,
          "",
          invoices,
        ],
      }).catch((error) => console.error("a note about a disputed month failed", error));
    } else if (outcome.kind === "no-payment") {
      await tellCreator(account, sub, {
        kind: "no-payment",
        key: `fallback-nopay:${account}:${monthly}`,
        subject: "A member paid an extra month that needs a look",
        lines: [
          "A member paid their yearly renewal while their move to the monthly price was being made, so they paid for both.",
          `The month (${money(num(month.amount_paid) || num(month.total))}) was paid without a card payment on Stripe: from the member's credit balance, or marked paid outside Stripe. So nothing was refunded by itself. If they are owed it, please refund or credit it on your Stripe account.`,
          where,
          "",
          invoices,
        ],
      }).catch((error) => console.error("a note about a month paid without a payment failed", error));
    }
    // "settled-before": a note went with the refund already, or there was nothing left to refund.
    return "done";
  });
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

/** Whether the year is still a paid year: never refunded (on its charge or by a credit note) nor disputed since. */
async function yearKept(run: Run, account: string, year: Raw): Promise<"kept" | "refunded" | "disputed"> {
  if (num(year.post_payment_credit_notes_amount) > 0) return "refunded";
  for (const row of await paidPayments(run, account, year)) {
    const found = await chargeOf(run, account, row);
    if (!found) continue;
    if (found.charge.disputed === true) return "disputed";
    if (num(found.charge.amount_refunded) > 0 || found.charge.refunded === true) return "refunded";
  }
  return "kept";
}

/** The membership back on the year's own price until the year paid ends; never twice, never a charge. */
async function moveBack(run: Run, account: string, sub: SubRead, year: Raw, yearly: string): Promise<"moved" | "already" | "skipped" | "refused"> {
  if (ended(sub)) return "skipped";
  if (sub.metadata?.yearly_paid === yearly || interval(sub) === "year") return "already";
  if (!movedFor(sub, yearly)) {
    console.error("a membership paid twice is not on the monthly price of its move; left as it is", account, idOf(sub.id));
    return "skipped";
  }
  // Flexible billing mode keeps the billing date when a trial is set (Stripe, Set the subscription billing renewal
  // date): the move back would not charge nothing until the year paid ends, so it is left to the creator.
  if (sub.billing_mode?.type === "flexible") return "skipped";
  const paid = yearEnd(year);
  const itemId = idOf(sub.items?.data?.[0]?.id);
  if (!paid || !itemId || paid.end <= Math.floor(Date.now() / 1000) + 3_600) {
    console.error("a membership paid twice has no year left to move back to; left on the monthly price", account, idOf(sub.id));
    return "skipped";
  }
  try {
    await post(run, account, `/subscriptions/${encodeURIComponent(idOf(sub.id))}`, moveBackBody(itemId, paid.price, paid.end, yearly), `fallback-back:${yearly}`);
  } catch (error) {
    // Refused for certain (the yearly price archived, say): the refund is never held back for it; the creator is told.
    if (!refusedBy(error)) throw error;
    console.error("moving a membership paid twice back to its yearly price was refused; the month is refunded all the same", account, idOf(sub.id), error);
    return "refused";
  }
  return "moved";
}

/** The move back, as Stripe is sent it: the year's price, nothing charged until `end`, the move's marks taken off. */
export function moveBackBody(itemId: string, yearlyPrice: string, end: number, yearly: string): URLSearchParams {
  return new URLSearchParams({
    "items[0][id]": itemId,
    "items[0][price]": yearlyPrice,
    trial_end: String(end),
    proration_behavior: "none",
    "metadata[every]": "year",
    // Empty values take a key off (Stripe, Metadata).
    "metadata[monthly_from]": "",
    "metadata[monthly_replaced]": "",
    "metadata[yearly_paid]": yearly,
  });
}

type RefundOutcome =
  | { kind: "refunded"; amount: number }
  | { kind: "disputed" }
  | { kind: "no-payment" }
  | { kind: "settled-before" };

/** The month's payment refunded in full, once; a month with nothing to refund settles too, never kept. */
async function refundMonth(run: Run, account: string, yearly: string, monthly: string, month: Raw): Promise<RefundOutcome> {
  const mark = fallbackRefundedKey(monthly);
  const [settled] = await redisPipeline([["GET", mark]]);
  if (typeof settled === "string") return { kind: "settled-before" };
  const done = (why: string) => redisPipeline([["SET", mark, why, "EX", REFUNDED_SECONDS]]);

  const rows = await paidPayments(run, account, month);
  let gave = 0;
  let disputed = false;
  let found = false;
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
      gave += num(ours.amount);
      paidOnInvoice -= num(ours.amount);
      continue;
    }
    const left = num(paid.charge.amount) - num(paid.charge.amount_refunded);
    const give = Math.min(paidOnInvoice, typeof row.amount_paid === "number" ? row.amount_paid : paidOnInvoice, left);
    if (give <= 0) continue;
    try {
      await post(
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
    gave += give;
    paidOnInvoice -= give;
  }
  if (gave > 0) {
    await done("refunded");
    return { kind: "refunded", amount: gave };
  }
  if (disputed) {
    await done("disputed");
    return { kind: "disputed" };
  }
  await done(found ? "none" : "no-payment");
  // Paid with no payment of its own on Stripe (a credit balance, or marked paid outside Stripe): settled, the creator
  // told; a payment fully refunded before is nothing left to give.
  return found ? { kind: "settled-before" } : { kind: "no-payment" };
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

/** Stripe refuses us the account: its creator is told, at most once a week. */
async function tellDenied(account: string): Promise<void> {
  if (!ACCOUNT_PATTERN.test(account)) return;
  const [first] = await redisPipeline([["SET", deniedKey(account), "1", "NX", "EX", DENIED_SECONDS]]);
  if (first === null) return;
  await tellCreator(account, null, {
    kind: "denied",
    key: `fallback-denied:${account}:${Math.floor(Date.now() / (DENIED_SECONDS * 1000))}`,
    subject: "We cannot reach your Stripe account",
    lines: [
      "A member moved, or asked to move, from a yearly price to a monthly one, and we need to finish that on your Stripe account so they are never charged for both.",
      "Stripe no longer lets us reach your account. Please connect it again from your studio; until then, please look at your members whose yearly renewal failed on Stripe.",
    ],
  });
}

type Note = { kind: string; key: string; subject: string; lines: string[] };

/** A short note to the creator, in English, from the store's own email figure. */
async function tellCreator(account: string, sub: SubRead | null, note: Note): Promise<void> {
  const store = await storeOf(account, sub);
  if (!store || !store.email) return;
  const productId = sub ? productOfSub(sub as Parameters<typeof productOfSub>[0]) : "";
  const [product] = productId ? await readListings(store, [productId]).catch(() => [] as Listing[]) : [];
  const subject = product?.title ? `${note.subject} for ${product.title}` : note.subject;
  await sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: subject.slice(0, 200),
    text: note.lines.join("\n"),
    idempotencyKey: note.key.slice(0, 200),
  });
}
