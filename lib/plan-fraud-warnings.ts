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
 * Item 312 asks for every actionable warning on a plan or add-on payment to
 * be refunded in full; the note of 01/11/2026 left open whether to limit it
 * to charges near the dispute fee, as Stripe advises. Decided by Claude 1
 * under ALL-160 (agents decide, 12/11/2026): the item's text is followed.
 * Stripe's advice is about merchants whose customers are often misflagged;
 * ours are creators paying for their own store, a payment flagged by the
 * issuer is not revenue we may keep, and every dispute marks the platform
 * account all creators depend on. The job stays off (FRAUD_REFUNDS_ON) until
 * the Terms and refund policy say so.
 *
 * Not in this unit: one-off platform charges with no subscription (chargeNow,
 * e.g. paid AI captions) are counted as unmatched and left alone; a sibling
 * plan or add-on paid with the same card is not ended (Radar's block list,
 * from reason "fraudulent", refuses its next charge).
 *
 * Only `actionable` warnings are refunded, so a charge already disputed or
 * fully refunded is never refunded twice (its subscription is still ended);
 * the refund carries an idempotency
 * key per warning, and what each warning came to is remembered (SEEN_KEY,
 * written before the refund is asked for, so a refund made at Stripe whose
 * answer is lost still ends its subscription on a later run),
 * so a warning listed again costs no other Stripe call. A payment that is not
 * a plan or an add-on invoice is left alone and counted as unmatched.
 *
 * Bounded before anything is spent: a deadline, at most MAX_PAGES pages of a
 * hundred, at most MAX_REFUNDS refunds a run (a misread list can never
 * refund more than that in a day; the rest wait for the next run, still
 * actionable) and at most MAX_RETRIES subscriptions whose ending is tried
 * again. The deadline is checked before every Stripe call, not inside one: a
 * call can still take up to Stripe's own timeout. Stripe charges nothing per API call; what this job costs is the
 * company's daily cron time (inside its 45 seconds) and one small Redis hash,
 * priced in tests/store-data-registry.ts.
 *
 * What the store sees afterwards is what an ended subscription already
 * means: the daily billing sync (lib/billing-sync.ts), which runs right
 * after this job, finds the subscription ended and applies the existing
 * rules, exactly as for any other plan that stops being paid.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { BillingError, isAddOn, isBillingConfigured, onPlatform, onPlatformAt } from "@/lib/billing";
import { type StripePage, readStripePage } from "@/lib/stripe-list";

/** The version whose charge still names its invoice and whose invoice names its subscription (as lib/plan-disputes.ts). */
const WARNING_VERSION = "2024-06-20";
/** Disputes can be opened for 120 days; so far back a warning is still worth acting on. */
export const LOOKBACK_DAYS = 120;
/**
 * Off until the Terms and the refund policy say that a payment its card's
 * issuer warns was fraudulent may be refunded and its plan ended
 * automatically (item 312, point 4): the unit that publishes those words turns
 * this on in the same change. While off, the job reads nothing and acts on
 * nothing.
 */
export const FRAUD_REFUNDS_ON = false;
export const MAX_PAGES = 3;
/** The most payments refunded in one run. */
export const MAX_REFUNDS = 25;
/** The most refunded payments whose subscription is tried again in one run. */
export const MAX_RETRIES = 25;
/**
 * What each warning already read came to, by id: "final" (refunded and its
 * subscription ended, or nothing to do), "unmatched" (not a plan or add-on
 * payment) or "act:<sub id>" (decided: written before the refund is asked
 * for; what is left of the charge is refunded and the subscription ended on
 * this or a later run).
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
  /** The job is switched off (FRAUD_REFUNDS_ON): nothing was read or done. */
  off?: true;
};

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const idOf = (value: unknown): string => (typeof value === "string" ? value : typeof objectOf(value)?.id === "string" ? String(objectOf(value)!.id) : "");
const count = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null);

/** The idempotency key of the refund of one warning's payment: the same warning never refunds twice. */
export const refundKeyOf = (warningId: string): string => `efw-refund:${warningId}`;

/**
 * Writes what a warning came to, and throws unless both replies read exactly (review of #4168, second round): the
 * `act:` mark must be known to be written before a refund is asked for, or a lost refund answer would leave nothing
 * that brings the next run back to the subscription.
 */
async function remember(id: string, what: string): Promise<void> {
  const replies = repliesFor(await redisPipeline([["HSET", SEEN_KEY, id, what], ["EXPIRE", SEEN_KEY, SEEN_SECONDS]]), 2);
  const added = replies ? countOf(replies[0]) : null;
  if (!replies || added === null || added > 1 || replies[1] !== 1) throw new Error("what was decided about an early fraud warning was not confirmed as written");
}

/** At most this many old decided fields are dropped a run (see syncPlanFraudWarnings). */
export const MAX_PRUNE = 500;

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
 * Refunds what is left of a charge, for one warning. True only for a
 * succeeded receipt of this charge, of exactly that amount: a pending one is
 * not proof that money went back (as refundCharge in lib/billing.ts), so the
 * warning is come back to on the next run.
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
    && receipt!.status === "succeeded";
}

/** "refunded-held": refunded, its subscription still to end (tried again next run). */
type Outcome = "refunded" | "refunded-held" | "ended" | "unmatched" | "skipped" | "held";

/** The charge a listed warning is about, read from its expanded row; null when it cannot be read. */
function chargeOf(warning: Record<string, unknown>): { id: string; left: number; subscriptionId: string } | null {
  const charge = objectOf(warning.charge);
  const id = idOf(charge);
  const amount = count(charge?.amount);
  const refunded = count(charge?.amount_refunded);
  if (!charge || !CHARGE_ID.test(id) || amount === null || refunded === null || refunded > amount) return null;
  return { id, left: amount - refunded, subscriptionId: idOf(objectOf(charge.invoice)?.subscription) };
}

/**
 * Refunds what is left of a warning's charge (while the warning is still
 * actionable), then ends the subscription. `act:<sub>` is already written, so
 * whatever happens from here (a refund made at Stripe whose answer is lost, a
 * run cut off, an ending that fails) the next run comes back to this
 * subscription, even once Stripe stops calling the warning actionable.
 */
async function settle(
  id: string,
  warning: Record<string, unknown>,
  subscriptionId: string,
  budget: { refunds: number },
  deadline: number,
): Promise<Outcome> {
  let refunded = false;
  if (warning.actionable === true) {
    const charge = chargeOf(warning);
    if (!charge) throw new Error("the warning's charge could not be read");
    if (charge.left > 0) {
      if (budget.refunds <= 0 || Date.now() > deadline) return "held";
      budget.refunds -= 1;
      // Same key on every try: Stripe answers a retry within a day with the first refund, and after that the charge's
      // own refunded amount (left above) keeps a second one from being made.
      if (!(await refund(id, charge.id, charge.left))) throw new Error("the refund was not confirmed");
      refunded = true;
    }
  }
  if (Date.now() > deadline) return refunded ? "refunded-held" : "held";
  let ended = false;
  try {
    ended = await endSubscription(subscriptionId);
  } catch (error) {
    console.error(`ending subscription ${subscriptionId} after early fraud warning ${id} failed`, error);
  }
  if (!ended) return refunded ? "refunded-held" : "held";
  await remember(id, "final");
  return refunded ? "refunded" : "ended";
}

/** Acts on one listed warning. */
async function applyWarning(
  warning: Record<string, unknown>,
  known: string | undefined,
  budget: { refunds: number },
  deadline: number,
): Promise<Outcome> {
  const id = idOf(warning.id);
  if (known === "final" || known === "unmatched") return "skipped";
  // Already decided: refund what may still be left and end the subscription, whatever the warning says now.
  if (known?.startsWith("act:")) return settle(id, warning, known.slice(4), budget, deadline);
  // A warning first seen when it is no longer actionable (disputed, or fully refunded, before we acted) goes the same
  // way: settle refunds only an actionable warning, so nothing is refunded, but the subscription that charged the card
  // the issuer called stolen still ends (review of #4168, second round, MEDIUM): otherwise the next renewal charges it again.
  const charge = chargeOf(warning);
  // A charge not expanded or not readable: not acted on, read again next run.
  if (!charge) throw new Error("the warning's charge could not be read");
  if (!SUBSCRIPTION_ID.test(charge.subscriptionId)) {
    await remember(id, "unmatched");
    return "unmatched";
  }
  if (Date.now() > deadline) return "held";
  const subscription = objectOf(await onPlatformAt(WARNING_VERSION, "GET", `/subscriptions/${encodeURIComponent(charge.subscriptionId)}`));
  // Another subscription's reply decides nothing; read again next run.
  if (!subscription || idOf(subscription.id) !== charge.subscriptionId) throw new Error("Stripe answered for another subscription");
  if (!ours(subscription)) {
    await remember(id, "unmatched");
    return "unmatched";
  }
  // Written before any refund is asked for (ALTO 1 of the review of #4168).
  await remember(id, `act:${charge.subscriptionId}`);
  return settle(id, warning, charge.subscriptionId, budget, deadline);
}

/**
 * Reads the warnings of the last LOOKBACK_DAYS until `deadline`
 * (milliseconds since the epoch), newest first, then tries again to end the
 * subscriptions of payments already refunded that the list no longer shows.
 */
export async function syncPlanFraudWarnings(
  deadline: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  on: boolean = FRAUD_REFUNDS_ON,
): Promise<FraudWarningCounts> {
  const counts: FraudWarningCounts = { seen: 0, refunded: 0, ended: 0, unmatched: 0, skipped: 0, failed: 0, complete: false };
  if (!on) return { ...counts, off: true };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  // Read exactly (rule 24; review of #4168, second round, HIGH): a reply that is not an even list of strings is not
  // "nothing decided yet", which would let a decided warning be taken afresh; the run stops before acting on any.
  const read = repliesFor(await redisPipeline([["HGETALL", SEEN_KEY]]), 1);
  const pairs = read ? stringList(read[0]) : null;
  if (!pairs || pairs.length % 2 !== 0) {
    counts.failed += 1;
    console.error("early fraud warnings: what was decided could not be read; nothing is acted on this run");
    return counts;
  }
  const seen = new Map<string, string>();
  for (let i = 0; i < pairs.length; i += 2) seen.set(pairs[i], pairs[i + 1]);
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
        const outcome = await applyWarning(warning, seen.get(id), budget, deadline);
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
  // Decided, and no longer listed: their subscriptions are ended by id. Taken in a random order, so the same
  // MAX_RETRIES that keep failing never stand in front of the others on every run.
  const due = [...seen].filter(([id, what]) => what.startsWith("act:") && !listed.has(id));
  for (let i = due.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [due[i], due[j]] = [due[j], due[i]];
  }
  const stale = due.slice(0, MAX_RETRIES);
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
  // A finished field ("final", "unmatched") whose warning a complete read of the window no longer lists is older than
  // LOOKBACK_DAYS and is never listed again, so it is dropped, at most MAX_PRUNE a run (review of #4168, second round,
  // LOW): the field list stays bounded by the warnings of the window. "act:" fields are never dropped here.
  if (listDone && readable && Date.now() <= deadline) {
    const old = [...seen].filter(([id, what]) => (what === "final" || what === "unmatched") && !listed.has(id)).map(([id]) => id).slice(0, MAX_PRUNE);
    if (old.length) await redisPipeline([["HDEL", SEEN_KEY, ...old]]).catch((error) => console.error("early fraud warnings: dropping old fields failed", error));
  }
  counts.complete = listDone && readable && held === 0 && counts.failed === 0 && due.length <= MAX_RETRIES;
  return counts;
}
