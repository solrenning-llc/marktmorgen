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
 * ordered by when it is next due, so it is tried again in turn and never
 * stands in front of a plan opened after it. It waits longer each time, and
 * after PLAN_GIVE_UP_DAYS with no good answer it is let go, written in the
 * log and marked in nl:plans:given-up. A plan the buyer stopped sooner waits
 * there too, until Stripe has canceled it: if that earlier end is taken away
 * first, the plan's own end is set again before it comes.
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
import { withCutoff } from "@/lib/fetch-timeout";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

const PENDING = "nl:plans:pending";
/**
 * Plans tried and not settled yet, scored by when they are next due (seconds), so the one due first comes first.
 * A member is `account|session|since`: `since` is when the checkout opened, or, for a plan watched for an earlier
 * end, when it was due to be read again, the moment its days without a good answer count from.
 */
const RETRY = "nl:plans:retry";
/** Plans let go after PLAN_GIVE_UP_DAYS with no good answer, scored by when (seconds); the newest GIVEN_UP_KEPT. */
const GIVEN_UP = "nl:plans:given-up";
/** Plans one run tries at the most (NOT_A_COST.PLANS_PER_RUN and PLAN_SETTLE_RUN in tests/plan-cost-registry.ts). */
export const PLANS_PER_RUN = 200;
/** Days a plan is tried with no good answer from Stripe (an account that answers 403) before it is let go. */
export const PLAN_GIVE_UP_DAYS = 30;
/** Marks of plans let go that are kept, the newest first. */
export const GIVEN_UP_KEPT = 1_000;
const DAY = 86_400;
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

export type PlanState = "done" | "open" | "gone" | "early" | "unread";

/** What one try found, and for a plan ending sooner, when it is read again (seconds). */
type Outcome = { state: PlanState; again?: number };

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
 * neither; "early" means it ends sooner than its last payment (the buyer
 * stopped it), so nothing is written, and the job reads it again before its
 * own end in case that sooner end is taken away; "unread" means Stripe
 * answered for something other than what was asked, or did not confirm the
 * end just set, so nothing is known and the job tries the plan again, as it
 * does a plan whose account refused the call.
 */
export async function finishPlan(account: string, session: string): Promise<PlanState> {
  return (await tryPlan(account, session)).state;
}

async function tryPlan(account: string, session: string): Promise<Outcome> {
  if (!ACCOUNT_ID.test(account) || !SESSION_ID.test(session)) return { state: "gone" };
  let view: Record<string, unknown>;
  try {
    view = await onAccount("GET", account, `/checkout/sessions/${encodeURIComponent(session)}`);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return { state: "gone" };
    throw error;
  }
  if (!isOwnReply(view, session)) return { state: "unread" };
  const meta = (view.metadata ?? {}) as Record<string, string>;
  const isPlan = meta.kind === "plan";
  if (!isPlan && !meta.ends_after) return { state: "gone" };
  if (view.status === "open") return { state: "open" };
  if (view.status !== "complete" || typeof view.subscription !== "string") return { state: "gone" };

  const subscription = await onAccount("GET", account, `/subscriptions/${encodeURIComponent(view.subscription)}`);
  // Read before cancel_at or status: another subscription's end is not this plan's.
  if (!isOwnReply(subscription, view.subscription)) return { state: "unread" };
  if (subscription.status === "canceled") return { state: "done" };
  const payments = Number(isPlan ? meta.plan_payments : meta.ends_after);
  const named = isPlan ? meta.plan_interval : meta.ends_interval;
  const interval: Interval = isPlan ? (named === "week" ? "week" : "month") : isInterval(named) ? named : "month";
  // After a free trial the first payment is taken when it ends. Stripe anchors
  // the cycle there; the trial's end is read too, so the count can never
  // start before the first payment whichever way Stripe reports it.
  const cycle = typeof subscription.billing_cycle_anchor === "number" ? subscription.billing_cycle_anchor : 0;
  const trialEnd = typeof subscription.trial_end === "number" ? subscription.trial_end : 0;
  const anchor = Math.max(cycle, trialEnd);
  if (!Number.isInteger(payments) || payments < 2 || !anchor) return { state: "gone" };
  const end = addPeriods(anchor, interval, payments);
  // An end already set is the plan's when it is the last payment's period's.
  // A later one (set by hand, or left from before) would charge more payments
  // than were agreed, so it is brought back. An earlier one (the buyer stopped
  // the plan) never charges more while it stays, but can be taken away (the
  // portal, the creator): the plan is read again at that end, or a day before
  // its own, whichever comes first, and is settled once Stripe has canceled
  // it, or once its own end has come with the earlier one still in place.
  const cancelAt = typeof subscription.cancel_at === "number" && subscription.cancel_at > 0 ? subscription.cancel_at : 0;
  if (cancelAt === end) return { state: "done" };
  if (cancelAt && cancelAt < end) {
    return Math.floor(Date.now() / 1000) >= end ? { state: "done" } : { state: "early", again: Math.min(cancelAt, end - DAY) };
  }

  const updated = await onAccount(
    "POST",
    account,
    `/subscriptions/${encodeURIComponent(view.subscription)}`,
    new URLSearchParams({ cancel_at: String(end), proration_behavior: "none" }),
  );
  // Settled only on the subscription's own answer carrying the end just set (Codex S on #3086: the id alone does
  // not prove the end was written); otherwise the next try reads it again and finds the end in place, or sets it.
  return { state: isOwnReply(updated, view.subscription) && updated.cancel_at === end ? "done" : "unread" };
}

/** Whether a write of one member (ZADD) answered 0 or 1 exactly: anything else, or a refusal, is unknown. */
async function wrote(commands: (string | number)[][]): Promise<boolean> {
  try {
    const replies = repliesFor(await redisPipeline(commands), commands.length);
    const added = replies ? countOf(replies[0]) : null;
    return added === 0 || added === 1;
  } catch (error) {
    console.error("keeping a payment plan for the next run failed", error);
    return false;
  }
}

/** Takes a plan out of both lines; one that stays is only settled again (a plan given its end is left as it is). */
async function leave(member: string): Promise<void> {
  await redisPipeline([["SREM", PENDING, member], ["ZREM", RETRY, member]]).catch((error: unknown) =>
    console.error("taking a settled payment plan out of its line failed", error),
  );
}

/**
 * Settles the plans opened and not yet settled, at most `limit` a run (each
 * at most three calls to Stripe and four Redis commands of its own) and none
 * started after `deadline` (milliseconds since the epoch), every request
 * given up by then; a plan not reached stays where it is for the next run.
 * New plans come from the pending set; plans already tried and not settled
 * wait in RETRY, the one due first first, and are given at least half the
 * run whenever they are due, so neither line can keep the other waiting for
 * ever. Safe to run as often as it is called: a plan already given its end
 * is left as it is. A reply of unknown shape throws UnknownReplyError: it is
 * not an empty line.
 */
export async function settlePlans(
  limit = PLANS_PER_RUN,
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ done: number; open: number; dropped: number; failed: number; watched: number; givenUp: number }> {
  const counts = { done: 0, open: 0, dropped: 0, failed: 0, watched: 0, givenUp: 0 };
  if (!isRedisConfigured() || !Number.isSafeInteger(limit) || limit < 1) return counts;
  const now = Math.floor(Date.now() / 1000);
  const read = repliesFor(
    await redisPipeline([
      ["SRANDMEMBER", PENDING, limit],
      ["ZRANGEBYSCORE", RETRY, "-inf", now, "LIMIT", 0, limit],
    ]),
    2,
  );
  const rawNew = read ? stringList(read[0]) : null;
  const rawDue = read ? stringList(read[1]) : null;
  if (!rawNew || !rawDue) throw new UnknownReplyError("the payment plans waiting");
  const fresh = [...new Set(rawNew)];
  // A plan in both (a run cut off between its two writes) is taken once, as new.
  const taken = new Set(fresh);
  const due = rawDue.filter((member) => !taken.has(member));
  const retries = Math.min(due.length, Math.max(Math.ceil(limit / 2), limit - fresh.length));
  const members = [...fresh.slice(0, limit - retries), ...due.slice(0, retries)];
  for (const member of members) {
    if (Date.now() >= deadline) break;
    const [account, session, sinceText] = member.split("|");
    const since = Number(sinceText);
    let outcome: Outcome | null = null;
    try {
      outcome = await withCutoff(deadline, () => tryPlan(account, session));
    } catch (error) {
      console.error("settling a payment plan failed", error);
    }
    const state = outcome?.state;
    // An open checkout waits two days from when it was opened; one with no readable time does not wait.
    if (state === "done" || state === "gone" || (state === "open" && !(now - since < 2 * 86400))) {
      if (state === "done") counts.done += 1;
      else counts.dropped += 1;
      await leave(member);
      continue;
    }
    if (state === "early" && outcome?.again !== undefined) {
      // Read again when it is due, its days without a good answer counted from then. Written before the old
      // entry leaves, and only once the write answered, so a cut-off run or a refused write never loses it.
      const at = Math.max(now + 1, outcome.again);
      const next = `${account}|${session}|${at}`;
      counts.watched += 1;
      if (!(await wrote([["ZADD", RETRY, at, next]]))) continue;
      await redisPipeline(next === member ? [["SREM", PENDING, member]] : [["SREM", PENDING, member], ["ZREM", RETRY, member]]).catch(
        (error: unknown) => console.error("moving a payment plan in its line failed", error),
      );
      continue;
    }
    // From here the plan is not settled: a checkout still open, or no good answer ("unread", a refusal, an error),
    // which is never settled on a reply that was not its own.
    if (state === "open") counts.open += 1;
    else if (!(now - since < PLAN_GIVE_UP_DAYS * DAY)) {
      // No good answer for PLAN_GIVE_UP_DAYS (or no readable time): let go, said in the log and marked first, so a
      // plan whose mark could not be written is tried again rather than lost without a trace.
      counts.givenUp += 1;
      console.error(`a payment plan was not given its end in ${PLAN_GIVE_UP_DAYS} days and is no longer tried (${GIVEN_UP})`, account);
      if (await wrote([["ZADD", GIVEN_UP, now, member], ["ZREMRANGEBYRANK", GIVEN_UP, 0, -(GIVEN_UP_KEPT + 1)]])) await leave(member);
      continue;
    } else counts.failed += 1;
    // Not settled: to the line of plans tried, due again after half the time it has waited (so each wait is longer
    // than the last) and never after its last day; written there before it leaves the new ones, and only once the
    // ZADD answered, so a refused or cut-off write never loses it.
    const at = now + Math.max(0, Math.min(Math.floor((now - since) / 2), since + PLAN_GIVE_UP_DAYS * DAY - now));
    if (!(await wrote([["ZADD", RETRY, at, member]]))) continue;
    await redisPipeline([["SREM", PENDING, member]]).catch((error: unknown) => console.error("keeping a payment plan for the next run failed", error));
  }
  return counts;
}
