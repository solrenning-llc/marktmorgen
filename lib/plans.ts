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

const PENDING = "nl:plans:pending";
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

export type PlanState = "done" | "open" | "gone" | "unread";

/**
 * A Stripe reply decides only when it is the object asked for (rule 30): it
 * holds its own id, equal to the one requested. A reply for another object,
 * or with no id, proves nothing about this plan. A reply that is not an
 * object at all (a JSON null, a string, a number) is not its own either: it
 * answers "unread", never a TypeError (Claude 6 on #3098).
 */
const isOwnReply = (reply: unknown, id: string): boolean =>
  reply !== null && typeof reply === "object" && Object.hasOwn(reply, "id") && (reply as { id?: unknown }).id === id;

/**
 * Gives a paid plan, or a membership that ends by itself, its end. "open"
 * means the checkout can still be paid; "gone" means it never will be, or is
 * neither; "unread" means Stripe answered for something other than what was
 * asked, so nothing is known and the plan stays pending for the next pass.
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
  if (!isOwnReply(view, session)) return "unread";
  const meta = (view.metadata ?? {}) as Record<string, string>;
  const isPlan = meta.kind === "plan";
  if (!isPlan && !meta.ends_after) return "gone";
  if (view.status === "open") return "open";
  if (view.status !== "complete" || typeof view.subscription !== "string") return "gone";

  const subscription = await onAccount("GET", account, `/subscriptions/${encodeURIComponent(view.subscription)}`);
  // Read before cancel_at or status: another subscription's end is not this plan's.
  if (!isOwnReply(subscription, view.subscription)) return "unread";
  if (typeof subscription.cancel_at === "number" && subscription.cancel_at > 0) return "done";
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

  const cancelAt = addPeriods(anchor, interval, payments);
  const updated = await onAccount(
    "POST",
    account,
    `/subscriptions/${encodeURIComponent(view.subscription)}`,
    new URLSearchParams({ cancel_at: String(cancelAt), proration_behavior: "none" }),
  );
  // Settled only on the subscription's own answer carrying the end just set (Codex S on #3086: the id alone does
  // not prove the end was written); otherwise the next pass reads it again and finds the end in place, or sets it.
  return isOwnReply(updated, view.subscription) && updated.cancel_at === cancelAt ? "done" : "unread";
}

/**
 * Settles every plan opened and not yet settled. Safe to run as often as it
 * is called: a plan already given its end is left as it is.
 */
export async function settlePlans(limit = 200): Promise<{ done: number; open: number; dropped: number; failed: number }> {
  const counts = { done: 0, open: 0, dropped: 0, failed: 0 };
  if (!isRedisConfigured()) return counts;
  const [raw] = await redisPipeline([["SMEMBERS", PENDING]]);
  const members = Array.isArray(raw) ? (raw as string[]).slice(0, limit) : [];
  const now = Math.floor(Date.now() / 1000);
  for (const member of members) {
    const [account, session, opened] = member.split("|");
    try {
      const state = await finishPlan(account, session);
      if (state === "open" && now - Number(opened) < 2 * 86400) {
        counts.open += 1;
        continue;
      }
      // Kept for the job's next run, never settled on a reply that was not its own.
      if (state === "unread") {
        counts.failed += 1;
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
