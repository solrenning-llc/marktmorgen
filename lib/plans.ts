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
 * A plan the job cannot settle yet (a checkout still open, an account that
 * refuses the call) leaves the line of new plans for a line of its own,
 * ordered by when it was last tried, so it is tried again in turn and never
 * stands in front of a plan opened after it.
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

const PENDING = "nl:plans:pending";
/** Plans tried and not settled yet, scored by when they were last tried (seconds), so the oldest try comes first. */
const RETRY = "nl:plans:retry";
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,64}$/;

/** Written down when a plan's checkout opens, so it is settled either way. */
export async function rememberPlan(account: string, session: string): Promise<void> {
  if (!isRedisConfigured() || !ACCOUNT_ID.test(account) || !SESSION_ID.test(session)) return;
  await redisPipeline([["SADD", PENDING, `${account}|${session}|${Math.floor(Date.now() / 1000)}`]]);
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
  const meta = (view.metadata ?? {}) as Record<string, string>;
  const isPlan = meta.kind === "plan";
  if (!isPlan && !meta.ends_after) return "gone";
  if (view.status === "open") return "open";
  if (view.status !== "complete" || typeof view.subscription !== "string") return "gone";

  const subscription = await onAccount("GET", account, `/subscriptions/${encodeURIComponent(view.subscription)}`);
  if (subscription.status === "canceled") return "done";
  const payments = Number(isPlan ? meta.plan_payments : meta.ends_after);
  const named = isPlan ? meta.plan_interval : meta.ends_interval;
  const interval: Interval = isPlan ? (named === "week" ? "week" : "month") : isInterval(named) ? named : "month";
  // After a free trial the first payment is taken when it ends. Stripe anchors
  // the cycle there; the trial's end is read too, so the count can never
  // start before the first payment whichever way Stripe reports it.
  const cycle = typeof subscription.billing_cycle_anchor === "number" ? subscription.billing_cycle_anchor : 0;
  const trialEnd = typeof subscription.trial_end === "number" ? subscription.trial_end : 0;
  const anchor = Math.max(cycle, trialEnd);
  if (!Number.isInteger(payments) || payments < 2 || !anchor) return "gone";
  const end = addPeriods(anchor, interval, payments);
  // An end already set is the plan's only when it comes no later than the
  // last payment's period: a later one (set by hand, or left from before)
  // would charge more payments than were agreed, so it is brought back. An
  // earlier one (the buyer stopped the plan) never charges more, and is kept.
  if (typeof subscription.cancel_at === "number" && subscription.cancel_at > 0 && subscription.cancel_at <= end) return "done";

  await onAccount(
    "POST",
    account,
    `/subscriptions/${encodeURIComponent(view.subscription)}`,
    new URLSearchParams({ cancel_at: String(end), proration_behavior: "none" }),
  );
  return "done";
}

const strings = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : []);

/**
 * Settles the plans opened and not yet settled, at most `limit` a run (each
 * at most three calls to Stripe). New plans come from the pending set; plans
 * already tried and not settled wait in RETRY, the longest-waiting first, and
 * are given at least half the run whenever they are due, so neither line can
 * keep the other waiting for ever. Safe to run as often as it is called: a
 * plan already given its end is left as it is.
 */
export async function settlePlans(limit = 200): Promise<{ done: number; open: number; dropped: number; failed: number }> {
  const counts = { done: 0, open: 0, dropped: 0, failed: 0 };
  if (!isRedisConfigured() || !Number.isSafeInteger(limit) || limit < 1) return counts;
  const now = Math.floor(Date.now() / 1000);
  const [rawNew, rawDue] = await redisPipeline([
    ["SRANDMEMBER", PENDING, limit],
    ["ZRANGEBYSCORE", RETRY, "-inf", now, "LIMIT", 0, limit],
  ]);
  const fresh = [...new Set(strings(rawNew))];
  // A plan in both (a run cut off between its two writes) is taken once, as new.
  const due = strings(rawDue).filter((member) => !fresh.includes(member));
  const retries = Math.min(due.length, Math.max(Math.ceil(limit / 2), limit - fresh.length));
  const members = [...fresh.slice(0, limit - retries), ...due.slice(0, retries)];
  for (const member of members) {
    const [account, session, opened] = member.split("|");
    try {
      const state = await finishPlan(account, session);
      // An open checkout waits two days from when it was opened; one with no readable time does not wait.
      if (state === "done" || state === "gone" || (state === "open" && !(now - Number(opened) < 2 * 86400))) {
        if (state === "done") counts.done += 1;
        else counts.dropped += 1;
        await redisPipeline([["SREM", PENDING, member], ["ZREM", RETRY, member]]);
        continue;
      }
      if (state === "open") counts.open += 1;
      else counts.failed += 1;
    } catch (error) {
      counts.failed += 1;
      console.error("settling a payment plan failed", error);
    }
    // Not settled: to the back of the line of plans tried, written there
    // before it leaves the new ones, so a cut-off run never loses it.
    await redisPipeline([["ZADD", RETRY, now, member], ["SREM", PENDING, member]]).catch((error: unknown) =>
      console.error("keeping a payment plan for the next run failed", error),
    );
  }
  return counts;
}
