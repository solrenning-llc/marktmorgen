/**
 * Early fraud warnings on our own Stripe account (312 [HQ1], unit 1): when a
 * card issuer warns that a payment a creator made to us for their plan or
 * for an add-on was probably fraudulent, the payment is refunded before the
 * cardholder disputes it, and the subscription that charged the card is
 * ended at once, without a final bill, so the card is never charged again.
 *
 * Why (official sources, read on the dates written):
 *   - stripe-node v23.1.0 (API 2026-10-28.endive), types/Radar/
 *     EarlyFraudWarnings.d.ts, read 12/11/2026: "An EFW is actionable if it
 *     has not received a dispute and has not been fully refunded. You may
 *     wish to proactively refund a charge that receives an EFW, in order to
 *     avoid receiving a dispute later." The list takes `created` (a range)
 *     and `expand`.
 *   - same package, types/Refunds.d.ts: "specifying `fraudulent` as the
 *     reason will add the associated card and email to your block lists".
 *   - docs.stripe.com/disputes/how-disputes-work, read by Claude 2 on
 *     01/11/2026 (docs/codex-queue.md, item 312): about 40% of Visa and
 *     Mastercard warnings left unrefunded become fraud disputes, and the
 *     dispute fee is never returned outside Mexico. A refund made now costs
 *     the payment we were never entitled to keep (a stolen card's money) and
 *     avoids the fee, the lost dispute and a mark on the account's dispute
 *     rate, which keeps the platform account (and every creator on it) safe.
 *
 * The owner's decision recorded in item 312 is followed as written: every
 * actionable warning on a plan or add-on payment is refunded in full.
 * Stripe's advice to refund only small charges is about merchants whose
 * customers are often misflagged; ours are creators paying for their own
 * store, and a payment flagged by the issuer is not revenue we may keep.
 *
 * Only `actionable` warnings are acted on, so a charge already disputed or
 * fully refunded is never refunded twice; the refund carries an idempotency
 * key per warning, and what each warning came to is remembered (SEEN_KEY),
 * so a warning listed again costs no other Stripe call. A payment that is not
 * a plan or an add-on invoice is left alone and counted as unmatched.
 *
 * Bounded before anything is spent: a deadline, at most MAX_PAGES pages of a
 * hundred, at most MAX_REFUNDS refunds a run (a misread list can never
 * refund more than that in a day; the rest wait for the next run, still
 * actionable) and at most MAX_RETRIES subscriptions whose ending is tried
 * again. Stripe charges nothing per API call; what this job costs is the
 * company's daily cron time (inside its 45 seconds) and one small Redis hash,
 * priced in tests/store-data-registry.ts.
 *
 * What the store sees afterwards is what an ended subscription already
 * means: the daily billing sync (lib/billing-sync.ts), which runs right
 * after this job, finds the subscription ended and applies the existing
 * rules, exactly as for any other plan that stops being paid.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { BillingError, isAddOn, isBillingConfigured, onPlatform, onPlatformAt } from "@/lib/billing";
import { type StripePage, readStripePage } from "@/lib/stripe-list";

/** The version whose charge still names its invoice and whose invoice names its subscription (as lib/plan-disputes.ts). */
const WARNING_VERSION = "2024-06-20";
/** Disputes can be opened for 120 days; so far back a warning is still worth acting on. */
export const LOOKBACK_DAYS = 120;
export const MAX_PAGES = 3;
/** The most payments refunded in one run. */
export const MAX_REFUNDS = 25;
/** The most refunded payments whose subscription is tried again in one run. */
export const MAX_RETRIES = 25;
/**
 * What each warning already read came to, by id: "final" (refunded and its
 * subscription ended, or nothing to do), "unmatched" (not a plan or add-on
 * payment) or "end:<sub id>" (refunded; its subscription still to end).
 */
export const SEEN_KEY = "nl:plan-fraud:seen";
const SEEN_SECONDS = 400 * 24 * 60 * 60;
const WARNING_ID = /^issfr_[A-Za-z0-9]+$/;
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]+$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;
const REFUND_ID = /^(re|pyr)_[A-Za-z0-9]+$/;
/** Subscriptions that bill nothing more. */
const ENDED = new Set(["canceled", "incomplete_expired"]);

export type FraudWarningCounts = {
  seen: number;
  refunded: number;
  ended: number;
  unmatched: number;
  skipped: number;
  failed: number;
  complete: boolean;
};

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const idOf = (value: unknown): string => (typeof value === "string" ? value : typeof objectOf(value)?.id === "string" ? String(objectOf(value)!.id) : "");
const count = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null);

/** The idempotency key of the refund of one warning's payment: the same warning never refunds twice. */
export const refundKeyOf = (warningId: string): string => `efw-refund:${warningId}`;

async function remember(id: string, what: string): Promise<void> {
  await redisPipeline([["HSET", SEEN_KEY, id, what], ["EXPIRE", SEEN_KEY, SEEN_SECONDS]]);
}

/** Whether the subscription is one of ours: a store's plan or an add-on. */
function ours(subscription: Record<string, unknown>): boolean {
  if (isAddOn(subscription)) return true;
  const store = objectOf(subscription.metadata)?.store;
  return typeof store === "string" && store !== "";
}

/** Ends a subscription at once and without a final bill. True when it bills nothing more. */
async function endSubscription(subscriptionId: string): Promise<boolean> {
  try {
    const ended = await onPlatform("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, { version: WARNING_VERSION });
    return idOf(ended) === subscriptionId && ENDED.has(String(objectOf(ended)?.status));
  } catch (error) {
    // Gone already: it bills nothing.
    if (error instanceof BillingError && error.status === 404) return true;
    throw error;
  }
}

/**
 * Refunds what is left of a charge, for one warning. True only for a receipt
 * of this charge, of exactly that amount, succeeded or on its way.
 */
async function refund(warningId: string, chargeId: string, cents: number): Promise<boolean> {
  const body = new URLSearchParams({ charge: chargeId, amount: String(cents), reason: "fraudulent" });
  body.set("metadata[early_fraud_warning]", warningId);
  const receipt = objectOf(await onPlatformAt(WARNING_VERSION, "POST", "/refunds", body, refundKeyOf(warningId)));
  return Boolean(receipt)
    && receipt!.object === "refund"
    && REFUND_ID.test(idOf(receipt!.id))
    && idOf(receipt!.charge) === chargeId
    && receipt!.amount === cents
    && (receipt!.status === "succeeded" || receipt!.status === "pending");
}

/** "refunded-held": refunded, its subscription still to end (tried again next run). */
type Outcome = "refunded" | "refunded-held" | "ended" | "unmatched" | "skipped" | "held";

/** Acts on one listed warning. */
async function applyWarning(warning: Record<string, unknown>, known: string | undefined, budget: { refunds: number }): Promise<Outcome> {
  const id = idOf(warning.id);
  if (known === "final" || known === "unmatched") return "skipped";
  if (known?.startsWith("end:")) return (await endSubscription(known.slice(4))) ? (await remember(id, "final"), "ended") : "held";
  // Disputed or fully refunded already: nothing to do, and never a second refund.
  if (warning.actionable !== true) {
    await remember(id, "final");
    return "skipped";
  }
  const charge = objectOf(warning.charge);
  const chargeId = idOf(charge);
  const amount = count(charge?.amount);
  const refunded = count(charge?.amount_refunded);
  // A charge not expanded or not readable: not acted on, read again next run.
  if (!charge || !CHARGE_ID.test(chargeId) || amount === null || refunded === null) throw new Error("the warning's charge could not be read");
  const subscriptionId = idOf(objectOf(charge.invoice)?.subscription);
  if (!SUBSCRIPTION_ID.test(subscriptionId)) {
    await remember(id, "unmatched");
    return "unmatched";
  }
  const subscription = objectOf(await onPlatformAt(WARNING_VERSION, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`));
  // Another subscription's reply decides nothing; read again next run.
  if (!subscription || idOf(subscription.id) !== subscriptionId) throw new Error("Stripe answered for another subscription");
  if (!ours(subscription)) {
    await remember(id, "unmatched");
    return "unmatched";
  }
  const left = amount - refunded;
  if (left > 0) {
    if (budget.refunds <= 0) return "held";
    budget.refunds -= 1;
    if (!(await refund(id, chargeId, left))) throw new Error("the refund was not confirmed");
  }
  // Refunded (or nothing left to refund): the card is never charged again. Written down before the ending is
  // tried, so a refunded warning (no longer actionable) whose ending fails is still ended on a later run.
  if (!ENDED.has(String(subscription.status))) {
    await remember(id, `end:${subscriptionId}`);
    let ended = false;
    try {
      ended = await endSubscription(subscriptionId);
    } catch (error) {
      console.error(`ending subscription ${subscriptionId} after early fraud warning ${id} failed`, error);
    }
    if (!ended) return left > 0 ? "refunded-held" : "held";
  }
  await remember(id, "final");
  return left > 0 ? "refunded" : "ended";
}

/**
 * Reads the warnings of the last LOOKBACK_DAYS until `deadline`
 * (milliseconds since the epoch), newest first, then tries again to end the
 * subscriptions of payments already refunded that the list no longer shows.
 */
export async function syncPlanFraudWarnings(deadline: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<FraudWarningCounts> {
  const counts: FraudWarningCounts = { seen: 0, refunded: 0, ended: 0, unmatched: 0, skipped: 0, failed: 0, complete: false };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  const [raw] = await redisPipeline([["HGETALL", SEEN_KEY]]);
  const seen = new Map<string, string>();
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) seen.set(String(raw[i]), String(raw[i + 1]));
  else if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) seen.set(key, String(value));
  const listed = new Set<string>();
  const since = nowSeconds - LOOKBACK_DAYS * 24 * 60 * 60;
  let after = "";
  let listDone = false;
  let readable = true;
  let held = 0;
  // Every refund asked for counts, confirmed or not, so a run never asks for more than MAX_REFUNDS.
  const budget = { refunds: MAX_REFUNDS };
  for (let page = 0; page < MAX_PAGES && !listDone; page += 1) {
    if (Date.now() > deadline) return counts;
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge.invoice");
    if (after) query.set("starting_after", after);
    let read: StripePage;
    try {
      read = readStripePage(await onPlatformAt(WARNING_VERSION, "GET", `/radar/early_fraud_warnings?${query}`), () => true, WARNING_ID);
    } catch (error) {
      counts.failed += 1;
      readable = false;
      console.error("reading early fraud warnings failed", error);
      break;
    }
    if (read.unreadable) {
      counts.failed += read.unreadable;
      readable = false;
    }
    for (const warning of read.rows) {
      if (Date.now() > deadline) return counts;
      counts.seen += 1;
      const id = idOf(warning.id);
      listed.add(id);
      after = id;
      try {
        const outcome = await applyWarning(warning, seen.get(id), budget);
        if (outcome === "refunded" || outcome === "refunded-held") counts.refunded += 1;
        if (outcome === "refunded") continue;
        if (outcome === "ended") counts.ended += 1;
        else if (outcome === "unmatched") counts.unmatched += 1;
        else if (outcome === "skipped") counts.skipped += 1;
        else held += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(`acting on early fraud warning ${id} failed`, error);
      }
    }
    if (!read.hasMore) listDone = true;
    else if (!read.lastId) {
      readable = false;
      break;
    }
  }
  if (!listDone) console.error("early fraud warnings: more than one run's pages; the oldest wait for the next run");
  // Refunded, and no longer listed: their subscriptions are tried again by id.
  const stale = [...seen].filter(([id, what]) => what.startsWith("end:") && !listed.has(id)).slice(0, MAX_RETRIES);
  for (const [id, what] of stale) {
    if (Date.now() > deadline) return counts;
    try {
      if (await endSubscription(what.slice(4))) {
        await remember(id, "final");
        counts.ended += 1;
      } else held += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(`ending the subscription of early fraud warning ${id} failed`, error);
    }
  }
  counts.complete = listDone && readable && held === 0 && counts.failed === 0 && stale.length < MAX_RETRIES;
  return counts;
}
