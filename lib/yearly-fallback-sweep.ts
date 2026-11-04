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
 *
 * Bounded by the job's deadline and by FALLBACK_PER_SET members of each list
 * a run, taken in a random order, so members left waiting never hold the
 * others back.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { formatMoney } from "@/lib/money";
import { readListings } from "@/lib/catalog";
import { type Listing, storeForHandle } from "@/lib/store";
import { productOfSub } from "@/lib/tier-rules";
import { withLock } from "@/lib/redis-lock";
import {
  FALLBACK_BOTH_KEY,
  FALLBACK_CHECK_KEY,
  FALLBACK_LOCK_SECONDS,
  FALLBACK_STRIPE_VERSION,
  FALLBACK_VOID_KEY,
  fallbackLockKey,
} from "@/lib/yearly-fallback";

/** Members of each list settled a run at most. */
export const FALLBACK_PER_SET = 25;
/**
 * How long a move applied with its first month not paid yet is waited on: longer than a bank debit takes to
 * confirm (Stripe gives SEPA Direct Debit up to 14 business days), and less than a month, so the invoice read is
 * still the move's own and not the next month's.
 */
export const FALLBACK_CHECK_DAYS = 21;
/**
 * A monthly invoice whose refund is settled (made, found made, disputed or nothing left), kept two days, past the
 * next daily run: a member is taken off BOTH once settled, so the mark only covers a run that stopped between the
 * refund and that; Stripe's own refunds of the payment, read for one of ours (metadata[fallback_refund]) before any
 * new one, are what keep a second refund from ever being made, on any day.
 */
export const fallbackRefundedKey = (invoice: string) => `nl:yearly:fallback:refunded:${invoice}`;
const REFUNDED_SECONDS = 2 * 86_400;

const ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]{6,64}$/;
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;
const INTENT_PATTERN = /^pi_[A-Za-z0-9]{6,64}$/;
const CHARGE_PATTERN = /^(ch|py)_[A-Za-z0-9]{6,64}$/;

export type FallbackSweep = { settled: number; left: number; refunds: number };
type Step = "done" | "wait";
type Raw = Record<string, unknown>;
type SubRead = {
  id?: unknown;
  status?: unknown;
  pending_update?: unknown;
  metadata?: Record<string, string> | null;
  latest_invoice?: unknown;
  items?: { data?: { id?: unknown; price?: { recurring?: { interval?: unknown } | null } | null }[] };
};

const v = FALLBACK_STRIPE_VERSION;
const get = (account: string, path: string) => onAccount("GET", account, path, undefined, v);
const post = (account: string, path: string, body = new URLSearchParams(), key?: string) => onAccount("POST", account, path, body, v, key);
/** Stripe says for certain the thing is not there: nothing is left to settle. */
const gone = (error: unknown) => error instanceof StripeError && error.status === 404;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const idOf = (value: unknown) => (typeof value === "string" ? value : value && typeof value === "object" ? str((value as { id?: unknown }).id) : "");
/** The subscription an invoice belongs to, where the API versions since 2025 name it. */
const subOf = (invoice: Raw) => idOf((invoice.parent as { subscription_details?: { subscription?: unknown } | null } | null)?.subscription_details?.subscription);
const ended = (sub: SubRead) => sub.status === "canceled" || sub.status === "incomplete_expired";
const interval = (sub: SubRead) => sub.items?.data?.[0]?.price?.recurring?.interval;
/** On the monthly price by this very move: what moveToMonthly writes, read back. */
const movedFor = (sub: SubRead, yearly: string) => interval(sub) === "month" && sub.metadata?.monthly_replaced === yearly;
const add = (key: string, entry: string) => redisPipeline([["SADD", key, entry]]);

function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Settles what moves to the monthly price left behind, until the deadline. Never throws. */
export async function settleFallbacks(deadline: number): Promise<FallbackSweep> {
  const out: FallbackSweep = { settled: 0, left: 0, refunds: 0 };
  if (!isRedisConfigured()) return out;
  // BOTH last, so a year found paid by the two before is settled the same day.
  const lists: [string, (entry: string, out: FallbackSweep) => Promise<Step>][] = [
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
      if (Date.now() >= deadline) return out;
      let step: Step = "wait";
      try {
        step = await settle(entry, out);
      } catch (error) {
        // No certain answer: kept for tomorrow, never decided on a guess.
        if (!(error instanceof Error && error.name === "LockBusyError")) console.error("settling a move to monthly failed; kept for tomorrow", error);
      }
      if (step === "done") {
        try {
          await redisPipeline([["SREM", key, entry]]);
          out.settled += 1;
        } catch (error) {
          console.error("taking a settled move to monthly off its list failed", error);
        }
      } else out.left += 1;
    }
  }
  return out;
}

/** A member that cannot be read is no work for anyone: said in the log and taken off. */
function malformed(entry: string): Step {
  console.error("a move to monthly left to settle is malformed; taken off", entry.slice(0, 200));
  return "done";
}

/** VOID: the month was paid, voiding the year failed. */
async function settleVoid(entry: string): Promise<Step> {
  const [account = "", yearly = "", monthly = "", ...rest] = entry.split("|");
  if (rest.length || !ACCOUNT_PATTERN.test(account) || !INVOICE_PATTERN.test(yearly) || !INVOICE_PATTERN.test(monthly)) return malformed(entry);
  let year: Raw;
  try {
    year = await get(account, `/invoices/${encodeURIComponent(yearly)}`);
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
  if (year.status === "open" || year.status === "uncollectible") {
    await post(account, `/invoices/${encodeURIComponent(yearly)}/void`);
    return "done";
  }
  return "wait";
}

/** CHECK: whether the move was made, and whether its month was paid, read again. */
async function settleCheck(entry: string): Promise<Step> {
  const [account = "", subscription = "", yearly = "", ...rest] = entry.split("|");
  if (rest.length || !ACCOUNT_PATTERN.test(account) || !SUB_PATTERN.test(subscription) || !INVOICE_PATTERN.test(yearly)) return malformed(entry);
  return withLock(fallbackLockKey(subscription), FALLBACK_LOCK_SECONDS, 2_000, async (): Promise<Step> => {
    let sub: SubRead;
    let year: Raw;
    try {
      sub = (await get(account, `/subscriptions/${encodeURIComponent(subscription)}?expand[]=latest_invoice`)) as SubRead;
      year = await get(account, `/invoices/${encodeURIComponent(yearly)}`);
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
        await post(account, `/invoices/${encodeURIComponent(latestId)}/void`);
      }
      return "done";
    }
    if (year.status === "void") return "done";
    if (year.status !== "open" && year.status !== "uncollectible") return "wait";

    if (moved) {
      if (latest?.status === "paid" && latestId !== yearly) {
        // Moved and the month paid: the year can never be paid as well.
        await post(account, `/invoices/${encodeURIComponent(yearly)}/void`);
        return "done";
      }
      const created = typeof latest?.created === "number" ? latest.created : 0;
      const young = created > 0 && Date.now() / 1000 - created < FALLBACK_CHECK_DAYS * 86_400;
      if ((latest?.status === "open" || latest?.status === "draft") && young) return "wait";
      // The month never came, and the membership is on the monthly price now: what it owes is the month, on Stripe's
      // own retries. The year is voided, so it can no longer be paid by hand from its page or an old email beside the
      // month; a void refused because it was paid meanwhile leaves this here, read as paid tomorrow (BOTH).
      await post(account, `/invoices/${encodeURIComponent(yearly)}/void`);
      return "done";
    }
    if (interval(sub) === "year" && !ended(sub)) {
      // A pending update is voided by Stripe when it expires; read again tomorrow.
      if (sub.pending_update) return "wait";
      // Never moved: the year is retried by itself again, as before the member tried.
      if (year.status === "open") await post(account, `/invoices/${encodeURIComponent(yearly)}`, new URLSearchParams({ auto_advance: "true" }));
      return "done";
    }
    // Ended, or moved by something else: the year is never turned back on.
    return "done";
  });
}

/** BOTH: the year and the month were both paid, or the month is still owed beside a paid year. */
async function settleBoth(entry: string, out: FallbackSweep): Promise<Step> {
  const [account = "", yearly = "", monthly = "", ...rest] = entry.split("|");
  if (rest.length || !ACCOUNT_PATTERN.test(account) || !INVOICE_PATTERN.test(yearly) || !INVOICE_PATTERN.test(monthly) || yearly === monthly) return malformed(entry);
  let first: Raw;
  try {
    first = await get(account, `/invoices/${encodeURIComponent(monthly)}`);
  } catch (error) {
    if (gone(error)) return "done";
    throw error;
  }
  const subscription = subOf(first);
  if (!SUB_PATTERN.test(subscription)) return malformed(entry);
  return withLock(fallbackLockKey(subscription), FALLBACK_LOCK_SECONDS, 2_000, async (): Promise<Step> => {
    const query = new URLSearchParams();
    query.append("expand[]", "payments");
    const month = await get(account, `/invoices/${encodeURIComponent(monthly)}?${query}`);
    const year = await get(account, `/invoices/${encodeURIComponent(yearly)}`);
    // Only two invoices of one membership, the year paid: anything else is never refunded.
    if (subOf(year) !== subscription || subOf(month) !== subscription) return malformed(entry);
    if (year.status !== "paid") return "done";

    // 1. A month still owed is never collected.
    if (month.status === "open" || month.status === "uncollectible") await post(account, `/invoices/${encodeURIComponent(monthly)}/void`);
    else if (month.status !== "paid" && month.status !== "void") return "wait";

    // 2. Back on the year's own price, nothing charged until the year paid ends.
    let sub: SubRead | null = null;
    try {
      sub = (await get(account, `/subscriptions/${encodeURIComponent(subscription)}`)) as SubRead;
    } catch (error) {
      if (!gone(error)) throw error;
    }
    const back = sub ? await moveBack(account, sub, year, yearly) : "skipped";

    // 3. A month paid is refunded in full, once.
    if (month.status !== "paid") return "done";
    const refunded = await refundMonth(account, yearly, monthly, month);
    if (refunded > 0) {
      out.refunds += 1;
      await tellCreator(account, sub, yearly, monthly, refunded, str(month.currency) || "usd", back === "skipped" ? 0 : yearEnd(year)?.end ?? 0).catch((error) =>
        console.error("a note about a refunded month failed", error),
      );
    }
    return "done";
  });
}

/** The yearly invoice's own line: the price paid and when the year paid ends. */
function yearEnd(year: Raw): { price: string; end: number } | null {
  const lines = (year.lines as { data?: unknown } | null)?.data;
  for (const line of Array.isArray(lines) ? (lines as Raw[]) : []) {
    const price = idOf((line.pricing as { price_details?: { price?: unknown } | null } | null)?.price_details?.price);
    const end = (line.period as { end?: unknown } | null)?.end;
    if (/^price_[A-Za-z0-9]{6,64}$/.test(price) && typeof end === "number") return { price, end };
  }
  return null;
}

/** The membership back on the year's own price until the year paid ends; never twice, never a charge. */
async function moveBack(account: string, sub: SubRead, year: Raw, yearly: string): Promise<"moved" | "already" | "skipped"> {
  if (ended(sub)) return "skipped";
  if (sub.metadata?.yearly_paid === yearly || interval(sub) === "year") return "already";
  if (!movedFor(sub, yearly)) {
    console.error("a membership paid twice is not on the monthly price of its move; left as it is", account, idOf(sub.id));
    return "skipped";
  }
  const paid = yearEnd(year);
  const itemId = idOf(sub.items?.data?.[0]?.id);
  if (!paid || !itemId || paid.end <= Math.floor(Date.now() / 1000) + 3_600) {
    console.error("a membership paid twice has no year left to move back to; left on the monthly price", account, idOf(sub.id));
    return "skipped";
  }
  await post(account, `/subscriptions/${encodeURIComponent(idOf(sub.id))}`, moveBackBody(itemId, paid.price, paid.end, yearly), `fallback-back:${yearly}`);
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

/** The month's payment refunded in full, once: what was refunded by this run, 0 when nothing was. */
async function refundMonth(account: string, yearly: string, monthly: string, month: Raw): Promise<number> {
  const mark = fallbackRefundedKey(monthly);
  const [settled] = await redisPipeline([["GET", mark]]);
  if (typeof settled === "string") return 0;
  const done = (why: string) => redisPipeline([["SET", mark, why, "EX", REFUNDED_SECONDS]]);

  const rows = (month.payments as { data?: unknown } | null)?.data;
  const payment = (Array.isArray(rows) ? (rows as Raw[]) : []).find((row) => row.status === "paid");
  const how = (payment?.payment ?? null) as { payment_intent?: unknown; charge?: unknown } | null;
  const intent = idOf(how?.payment_intent);
  const chargeId = idOf(how?.charge);
  if (!INTENT_PATTERN.test(intent) && !CHARGE_PATTERN.test(chargeId)) throw new Error("a paid monthly invoice shows no payment yet");
  const by: [string, string] = INTENT_PATTERN.test(intent) ? ["payment_intent", intent] : ["charge", chargeId];

  let charge: Raw;
  if (by[0] === "payment_intent") {
    const pi = await get(account, `/payment_intents/${encodeURIComponent(intent)}?expand[]=latest_charge`);
    charge = pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as Raw) : {};
  } else charge = await get(account, `/charges/${encodeURIComponent(chargeId)}`);
  if (typeof charge.amount !== "number") throw new Error("a monthly payment's charge could not be read");
  if (charge.disputed === true) {
    await done("disputed");
    return 0;
  }
  // One made here before, under this invoice: never a second; its note is still owed when no mark was left.
  const made = await get(account, `/refunds?${new URLSearchParams({ [by[0]]: by[1], limit: "100" })}`);
  const ours = (Array.isArray(made.data) ? (made.data as Raw[]) : []).find(
    (r) => (r.metadata as Record<string, string> | null)?.fallback_refund === monthly && r.status !== "failed" && r.status !== "canceled",
  );
  if (ours) {
    await done("refunded");
    return typeof ours.amount === "number" ? ours.amount : 0;
  }
  const left = charge.amount - (typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0);
  const paidOnInvoice = typeof month.amount_paid === "number" ? month.amount_paid : 0;
  const paidByThis = typeof payment?.amount_paid === "number" ? payment.amount_paid : paidOnInvoice;
  const give = Math.min(paidOnInvoice, paidByThis, left);
  if (give <= 0) {
    await done("none");
    return 0;
  }
  try {
    await post(
      account,
      "/refunds",
      new URLSearchParams({ [by[0]]: by[1], amount: String(give), reason: "duplicate", "metadata[fallback_refund]": monthly, "metadata[fallback_year]": yearly }),
      `fallback-refund:${monthly}`,
    );
  } catch (error) {
    if (error instanceof StripeError && (error.code === "charge_already_refunded" || error.code === "charge_disputed" || error.code === "refund_disputed_payment")) {
      await done(error.code);
      return 0;
    }
    throw error;
  }
  await done("refunded");
  return give;
}

/** The creator's note, in English, from the store's own email figure. */
async function tellCreator(account: string, sub: SubRead | null, yearly: string, monthly: string, amount: number, currency: string, until: number): Promise<void> {
  const handle = str(sub?.metadata?.store);
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || store.stripeAccountId !== account || !store.email) return;
  const productId = sub ? productOfSub(sub as Parameters<typeof productOfSub>[0]) : "";
  const [product] = productId ? await readListings(store, [productId]).catch(() => [] as Listing[]) : [];
  const title = product?.title || "a membership";
  const date = until > 0 ? new Date(until * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
  await sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `A member's extra month was refunded for ${title}`.slice(0, 200),
    text: [
      `A member of ${title} paid their yearly renewal while their move to the monthly price was being made, so they paid for both.`,
      `The year is kept. The month, ${formatMoney(amount, currency)}, was refunded in full.`,
      date
        ? `Their membership is back on the yearly price, with nothing more to pay until ${date}. Stripe shows it as a trial until then; the year is paid.`
        : "Their membership was not moved back to the yearly price by itself. Please look at it on your Stripe account.",
      "",
      `Invoices: ${yearly} (the year, kept) and ${monthly} (the month, refunded). It is all on your own Stripe account, under that customer.`,
    ].join("\n"),
    idempotencyKey: `fallback-both:${account}:${monthly}`,
  });
}
