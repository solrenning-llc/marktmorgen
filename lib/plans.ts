/**
 * Payment plans: ending them after the last payment.
 *
 * A plan is a subscription on the creator's own account that must stop by
 * itself after a fixed number of payments. Stripe cannot be told that when
 * the checkout is opened, so once the first payment is through the
 * subscription is given the exact moment it ends — the end of the period the
 * last payment covers — and Stripe then never charges again.
 *
 * That is done as soon as the buyer is back from paying, and a scheduled job
 * goes over every plan opened since, so a buyer who paid and closed the tab is
 * never charged one payment too many. Long before the second payment is due,
 * the plan knows when to stop.
 *
 * A membership the creator set to end after a number of payments ("12
 * monthly payments") goes through exactly the same door. The only difference
 * is where its count starts: after a free trial, the first payment is the one
 * at the trial's end, and that is where Stripe anchors the subscription, so
 * the arithmetic below is the same for both.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type Interval, isInterval } from "@/lib/product-recurring";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

const PENDING = "nl:plans:pending";
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,64}$/;

/**
 * Written down when a plan's checkout opens, so it is settled either way.
 * Only a SADD that answers it added the plan counts: the checkout is new, so
 * anything else (no reply, 0, a word) leaves it unknown whether the daily job
 * will ever find it, and the throw keeps the buyer from being sent to pay.
 */
export async function rememberPlan(account: string, session: string): Promise<void> {
  if (!isRedisConfigured() || !ACCOUNT_ID.test(account) || !SESSION_ID.test(session)) return;
  const replies = repliesFor(await redisPipeline([["SADD", PENDING, `${account}|${session}|${Math.floor(Date.now() / 1000)}`]]), 1);
  if (!replies || countOf(replies[0]) !== 1) throw new UnknownReplyError("the payment plan's SADD");
}

/**
 * The moment `n` periods after `anchor`, the way Stripe counts them: a month
 * later is the same day of the month, or the last day when the month is
 * shorter, at the same time of day.
 */
export function addPeriods(anchorSeconds: number, interval: Interval, n: number): number {
  if (interval === "day") return anchorSeconds + n * 86400;
  if (interval === "week") return anchorSeconds + n * 7 * 86400;
  const months = interval === "year" ? n * 12 : n;
  const start = new Date(anchorSeconds * 1000);
  const day = start.getUTCDate();
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return Math.floor(target.getTime() / 1000);
}

export type PlanState = "done" | "open" | "gone";

/** Stripe answered 200 in a shape that is not the documented one: what it holds is unknown, never "gone". */
export class UnknownStripeReplyError extends Error {
  constructor(what: string) {
    super(`Stripe answered ${what} in an unknown shape`);
    this.name = "UnknownStripeReplyError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A moment as Stripe sends it: whole seconds after 1970. */
const isMoment = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const CHECKOUT_STATUSES = new Set(["open", "complete", "expired"]);

/**
 * Gives a paid plan, or a membership that ends by itself, its end. "open"
 * means the checkout can still be paid; "gone" means it never will be, or is
 * neither.
 */
export async function finishPlan(account: string, session: string): Promise<PlanState> {
  if (!ACCOUNT_ID.test(account) || !SESSION_ID.test(session)) return "gone";
  let view: Record<string, unknown>;
  try {
    view = await onAccount("GET", account, `/checkout/sessions/${encodeURIComponent(session)}`);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return "gone";
    throw error;
  }
  // Read in its exact shape: only a checkout Stripe says is expired, or one
  // that is neither a plan nor a membership with an end, is let go. Anything
  // else throws, so the plan stays pending and is asked about again.
  if (!isRecord(view) || view.object !== "checkout.session" || view.id !== session || !isRecord(view.metadata) || typeof view.status !== "string" || !CHECKOUT_STATUSES.has(view.status)) {
    throw new UnknownStripeReplyError("a payment plan's checkout");
  }
  const meta = view.metadata as Record<string, string>;
  const isPlan = meta.kind === "plan";
  if (!isPlan && !meta.ends_after) return "gone";
  if (view.status === "open") return "open";
  if (view.status === "expired") return "gone";
  if (typeof view.subscription !== "string" || !view.subscription) throw new UnknownStripeReplyError("a paid plan's checkout");
  const subscriptionId = view.subscription;

  const subscription = await onAccount("GET", account, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (
    !isRecord(subscription) ||
    subscription.object !== "subscription" ||
    subscription.id !== subscriptionId ||
    typeof subscription.status !== "string" ||
    !isMoment(subscription.billing_cycle_anchor) ||
    (subscription.trial_end != null && !isMoment(subscription.trial_end)) ||
    (subscription.cancel_at != null && !isMoment(subscription.cancel_at))
  ) {
    throw new UnknownStripeReplyError("a payment plan's subscription");
  }
  if (isMoment(subscription.cancel_at)) return "done";
  if (subscription.status === "canceled") return "done";
  const payments = Number(isPlan ? meta.plan_payments : meta.ends_after);
  const named = isPlan ? meta.plan_interval : meta.ends_interval;
  const interval: Interval = isPlan ? (named === "week" ? "week" : "month") : isInterval(named) ? named : "month";
  // After a free trial the first payment is taken when it ends. Stripe anchors
  // the cycle there; the trial's end is read too, so the count can never
  // start before the first payment whichever way Stripe reports it.
  const anchor = Math.max(subscription.billing_cycle_anchor, isMoment(subscription.trial_end) ? subscription.trial_end : 0);
  // The plan's own terms say it is not one: nothing to end, whatever Stripe says.
  if (!Number.isInteger(payments) || payments < 2) return "gone";

  const end = addPeriods(anchor, interval, payments);
  const written = await onAccount(
    "POST",
    account,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    new URLSearchParams({ cancel_at: String(end), proration_behavior: "none" }),
  );
  // Done only when Stripe says the subscription now ends there; otherwise it
  // stays pending, and the next run reads it again (the same end is written
  // again, so a repeat changes nothing).
  if (!isRecord(written) || written.object !== "subscription" || written.id !== subscriptionId || written.cancel_at !== end) {
    throw new UnknownStripeReplyError("the end of a payment plan");
  }
  return "done";
}

/**
 * Settles every plan opened and not yet settled. Safe to run as often as it
 * is called: a plan already given its end is left as it is.
 */
export async function settlePlans(limit = 200): Promise<{ done: number; open: number; dropped: number; failed: number }> {
  const counts = { done: 0, open: 0, dropped: 0, failed: 0 };
  if (!isRedisConfigured()) return counts;
  // A pending list of unknown shape is not an empty one: the job says so
  // (app/api/cron/plans answers not ok) instead of settling nothing.
  const replies = repliesFor(await redisPipeline([["SMEMBERS", PENDING]]), 1);
  const list = replies ? stringList(replies[0]) : null;
  if (!list) throw new UnknownReplyError("the pending payment plans");
  const members = list.slice(0, limit);
  const now = Math.floor(Date.now() / 1000);
  for (const member of members) {
    const [account, session, opened] = member.split("|");
    try {
      const state = await finishPlan(account, session);
      if (state === "open" && now - Number(opened) < 2 * 86400) {
        counts.open += 1;
        continue;
      }
      if (state === "done") counts.done += 1;
      else counts.dropped += 1;
      await redisPipeline([["SREM", PENDING, member]]);
    } catch (error) {
      counts.failed += 1;
      console.error("settling a payment plan failed", error);
    }
  }
  return counts;
}
