/**
 * Payment plans: ending them after the last payment.
 *
 * A plan is a subscription on the creator's own account that must stop by
 * itself after a fixed number of payments. Stripe cannot be told that when
 * the checkout is opened, so once the first payment is through the
 * subscription is given the exact moment it ends — the end of the period the
 * last payment covers — and Stripe then never charges again. A plan reached
 * only after its end has its subscription ended at once and every payment
 * taken after the end given back (lib/plan-late-refunds.ts), since that end
 * was promised to the buyer.
 *
 * That is done as soon as the buyer is back from paying, and a scheduled job
 * goes over every plan opened since, so a buyer who paid and closed the tab is
 * never charged one payment too many. Long before the second payment is due,
 * the plan knows when to stop.
 *
 * A plan the job cannot settle yet (a checkout still open, an account that
 * refuses the call, Stripe down) leaves the line of new plans for a line of
 * its own, ordered by when it is next due, so it is tried again in turn and
 * never stands in front of a plan opened after it. Only the creator's own
 * account refusing us (isAccountRefusal, or a reply that is not its own)
 * counts toward PLAN_GIVE_UP_DAYS: a failure that is not the plan's (Stripe
 * down or busy, our own key refused or missing, a request cut off) starts the
 * count again, so a long outage on our side never slows or flags a plan. A
 * refused plan waits longer each time, and after PLAN_GIVE_UP_DAYS it is never
 * let go: it is tried once every PLAN_STUCK_RETRY_DAYS, settled as soon as the
 * account answers again, and its creator is told once by email
 * (lib/plan-stuck-notice.ts), since only they can let us back in and until
 * then Stripe may keep charging the buyer. A plan the buyer stopped sooner
 * waits there too, until Stripe has canceled it: if that earlier end is taken
 * away first, the plan's own end is set again before it comes.
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
import { tellPlanOwed, tellPlanStuck } from "@/lib/plan-stuck-notice";
import { refundLatePayments } from "@/lib/plan-late-refunds";
import { tellLateRefunds } from "@/lib/plan-late-notice";

const PENDING = "nl:plans:pending";
/**
 * Plans tried and not settled yet, scored by when they are next due (seconds), so the one due first comes first.
 * A member is `account|session|since[|store|product[|told[|owed|owedTold]]]` (Entry): `since` is when the checkout
 * opened, or, for a plan watched for an earlier end or one whose last try failed for a reason not its account's, when
 * that was, the moment its days of refusals by the account count from; `owed` is when a payment after its end was
 * first found owed (seconds, empty when none is), and `owedTold` marks its creator told about it.
 */
const RETRY = "nl:plans:retry";
/** Plans one run tries at the most (NOT_A_COST.PLANS_PER_RUN and PLAN_SETTLE_RUN in tests/plan-cost-registry.ts). */
export const PLANS_PER_RUN = 200;
/** Days a plan's account refuses us before the plan is tried once a week and its creator is told. */
export const PLAN_GIVE_UP_DAYS = 30;
/** Days between tries of a plan its account has refused for PLAN_GIVE_UP_DAYS. */
export const PLAN_STUCK_RETRY_DAYS = 7;
/**
 * Days a payment taken after a plan's end may stay owed (the creator's balance short, or Stripe refusing the refund)
 * before the creator is told, once. Three: the plan is tried every day, and a balance short for a day usually fills as
 * the next sales settle (Stripe settles card payments in about two business days), so three daily tries tell apart a
 * passing shortfall from one only the creator can end, while the buyer, charged past a date promised to them, waits
 * no longer than that for anyone to act.
 */
export const PLAN_OWED_TELL_DAYS = 3;
const DAY = 86_400;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,64}$/;
const STORE_ID = /^[0-9a-f]{32}$/;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One plan in a line: whose it is, since when its account has refused us, whether its creator was told, and since
 * when a payment after its end has been owed and whether its creator was told about that.
 */
type Entry = { account: string; session: string; since: number; sid: string; product: string; told: boolean; owed: number; owedTold: boolean };

/** Reads a member; a store or product that is not one of ours is left out, and a member written before them reads. */
function entryOf(member: string): Entry {
  const [account = "", session = "", since = "", sid = "", product = "", told = "", owed = "", owedTold = ""] = member.split("|");
  return {
    account,
    session,
    since: Number(since),
    sid: STORE_ID.test(sid) ? sid : "",
    product: PRODUCT_ID.test(product) ? product : "",
    told: told === "told",
    owed: /^[0-9]{1,12}$/.test(owed) ? Number(owed) : 0,
    owedTold: owedTold === "told",
  };
}

/** The member for an entry: one with nothing but its time is written as before, one never owed as before too. */
function memberOf(entry: Entry): string {
  const head = `${entry.account}|${entry.session}|${entry.since}`;
  if (!entry.sid && !entry.product && !entry.told && !entry.owed && !entry.owedTold) return head;
  const base = `${head}|${entry.sid}|${entry.product}`;
  if (!entry.owed && !entry.owedTold) return `${base}${entry.told ? "|told" : ""}`;
  return `${base}|${entry.told ? "told" : ""}|${entry.owed || ""}|${entry.owedTold ? "told" : ""}`;
}

/**
 * Written down when a plan's checkout opens, so it is settled either way. `about` names the store and the product,
 * so the creator can be told if their account refuses us for PLAN_GIVE_UP_DAYS.
 */
export async function rememberPlan(account: string, session: string, about?: { sid: string; product: string }): Promise<void> {
  if (!isRedisConfigured() || !ACCOUNT_ID.test(account) || !SESSION_ID.test(session)) return;
  const sid = about && STORE_ID.test(about.sid) ? about.sid : "";
  const product = about && PRODUCT_ID.test(about.product) ? about.product : "";
  await redisPipeline([["SADD", PENDING, memberOf({ account, session, since: Math.floor(Date.now() / 1000), sid, product, told: false, owed: 0, owedTold: false })]]);
}

/**
 * Whether Stripe refused a call because of the creator's own account: our access to it revoked, or the account
 * closed or unknown (`account_invalid`, a 403 from the account, a 401 that names the account). Only this, and a
 * reply that is not the account's own, counts toward PLAN_GIVE_UP_DAYS. Stripe down or busy, our own key refused
 * (a 401 that does not name the account), our restricted key short of a permission (a 403 that names "required
 * permissions", the same for every account), no key at all, a request cut off: none is the plan's, and none counts.
 */
export function isAccountRefusal(error: unknown): boolean {
  if (!(error instanceof StripeError)) return false;
  if (error.code === "account_invalid") return true;
  if (error.status === 403) return !/required permissions/i.test(error.stripeMessage);
  return error.status === 401 && /access to account/i.test(error.stripeMessage);
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

export type PlanState = "done" | "open" | "gone" | "early" | "unread" | "owed" | "untold";

/**
 * What one try found, and for a plan ending sooner, when it is read again (seconds); for a plan owed a refund, the
 * invoices its creator alone can put right (`short`).
 */
type Outcome = { state: PlanState; again?: number; short?: string[] };

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
 * does a plan whose account refused the call; "owed" means a payment taken
 * after the plan's own end is still to be given back (lib/plan-late-refunds.ts:
 * the creator's balance did not cover it, Stripe refused it, or more are left
 * than one try gives back), so the job tries the plan again; "untold" means every late payment is given back but
 * a buyer is still to be told by email (lib/plan-late-notice.ts), so the job tries the plan again for that. A try
 * that names no store (`about`, as the thanks page's does not) refunds and leaves the telling to the job's pass.
 */
export async function finishPlan(account: string, session: string, about?: { sid: string; product: string }): Promise<PlanState> {
  return (await tryPlan(account, session, about)).state;
}

/**
 * Gives back what a plan took after its end and tells each buyer whose payment was given back: "owed" while a
 * payment is still to be given back, "untold" while a buyer is still to be told, "done" once both are.
 */
async function settleLate(account: string, subscription: string, end: number, about?: { sid: string; product: string }): Promise<Outcome> {
  const late = await refundLatePayments(account, subscription, end);
  const told = about ? await tellLateRefunds(about, end, late.given) : { told: 0, untold: 0 };
  if (late.state === "owed") return { state: "owed", short: late.short };
  return { state: told.untold > 0 ? "untold" : "done" };
}

async function tryPlan(account: string, session: string, about?: { sid: string; product: string }): Promise<Outcome> {
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
  const canceled = subscription.status === "canceled";
  const payments = Number(isPlan ? meta.plan_payments : meta.ends_after);
  const named = isPlan ? meta.plan_interval : meta.ends_interval;
  const interval: Interval = isPlan ? (named === "week" ? "week" : "month") : isInterval(named) ? named : "month";
  // After a free trial the first payment is taken when it ends. Stripe anchors
  // the cycle there; the trial's end is read too, so the count can never
  // start before the first payment whichever way Stripe reports it.
  const cycle = typeof subscription.billing_cycle_anchor === "number" ? subscription.billing_cycle_anchor : 0;
  const trialEnd = typeof subscription.trial_end === "number" ? subscription.trial_end : 0;
  const anchor = Math.max(cycle, trialEnd);
  if (!Number.isInteger(payments) || payments < 2 || !anchor) return { state: canceled ? "done" : "gone" };
  const end = addPeriods(anchor, interval, payments);
  const now = Math.floor(Date.now() / 1000);
  if (canceled) {
    // Ended at or before its own end, or with its end still to come: it never charged past it. Otherwise (Stripe
    // canceled it later, or a pass ended it and could not give everything back) its late payments are given back
    // first (the owner's decision of 9 November 2026, item 12). An end Stripe does not state is read as late.
    const endedAt = typeof subscription.ended_at === "number" && subscription.ended_at > 0 ? subscription.ended_at : 0;
    if (now < end || (endedAt && endedAt <= end)) return { state: "done" };
    return settleLate(account, view.subscription, end, about);
  }
  // An end already set is the plan's when it is the last payment's period's.
  // A later one (set by hand, or left from before) would charge more payments
  // than were agreed, so it is brought back. An earlier one (the buyer stopped
  // the plan) never charges more while it stays, but can be taken away (the
  // portal, the creator): the plan is read again at that end, or two days
  // before its own, whichever comes first, and is settled once Stripe has canceled
  // it, or once its own end has come with the earlier one still in place.
  const cancelAt = typeof subscription.cancel_at === "number" && subscription.cancel_at > 0 ? subscription.cancel_at : 0;
  if (cancelAt === end) return { state: "done" };
  // Two days before its own end, so two daily runs come before it, never only one that may fall minutes before.
  if (cancelAt && cancelAt < end) {
    return now >= end ? { state: "done" } : { state: "early", again: Math.min(cancelAt, end - 2 * DAY) };
  }

  // Its own end already past (a plan stuck longer than its term, or a short one): an end in the past is not a time
  // Stripe documents for cancel_at, and the buyer agreed to no payment after it, so the subscription is ended now,
  // with nothing prorated or invoiced (the review of #3367, item 3), and every payment Stripe took at or after that
  // end is given back (lib/plan-late-refunds.ts; the owner's decision of 9 November 2026, item 12). Settled only on
  // its own answer saying canceled and every late payment given back; a pass that ended it and could not give them
  // all back finds it canceled next time, and gives back what is left.
  if (now >= end) {
    const ended = await onAccount("DELETE", account, `/subscriptions/${encodeURIComponent(view.subscription)}`, undefined, undefined, `plan-ended:${view.subscription}`);
    if (!(isOwnReply(ended, view.subscription) && ended.status === "canceled")) return { state: "unread" };
    return settleLate(account, view.subscription, end, about);
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
 * at most three calls to Stripe, LATE_REFUND_CALLS more when it is past its
 * end and has payments to give back, and four Redis commands of its own, and,
 * once a plan, telling its creator it is stuck) and none started after `deadline`
 * (milliseconds since the epoch), every request given up by then; a plan not
 * reached stays where it is for the next run. New plans come from the pending
 * set; plans already tried and not settled wait in RETRY, the one due first
 * first, and are given at least half the run whenever they are due, the two
 * lines taken in turn (one due, one new), so neither can keep the other
 * waiting for ever, under the run's deadline too. Safe to run as often as it is
 * called: a plan already given its end is left as it is. No plan leaves the
 * lines without its end, its checkout unpaid or gone, or Stripe having
 * canceled it. A reply of unknown shape throws UnknownReplyError: it is not an
 * empty line.
 */
export async function settlePlans(
  limit = PLANS_PER_RUN,
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ done: number; open: number; dropped: number; failed: number; watched: number; stuck: number; told: number; owed: number; owedTold: number; untold: number }> {
  const counts = { done: 0, open: 0, dropped: 0, failed: 0, watched: 0, stuck: 0, told: 0, owed: 0, owedTold: 0, untold: 0 };
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
  // Taken in turn, the one due first first, so under the run's deadline too neither line keeps the other waiting
  // (the review of #3367, item 1: new plans first could fill the whole time budget, every run).
  const firstNew = fresh.slice(0, limit - retries);
  const firstDue = due.slice(0, retries);
  const members: string[] = [];
  for (let i = 0; i < Math.max(firstNew.length, firstDue.length); i += 1) {
    if (i < firstDue.length) members.push(firstDue[i]);
    if (i < firstNew.length) members.push(firstNew[i]);
  }
  for (const member of members) {
    if (Date.now() >= deadline) break;
    const entry = entryOf(member);
    const { account, session, since } = entry;
    let outcome: Outcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await withCutoff(deadline, () => tryPlan(account, session, { sid: entry.sid, product: entry.product }));
    } catch (error) {
      failure = error;
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
      // Read again when it is due, its days of refusals counted from then.
      counts.watched += 1;
      await moveTo(member, Math.max(now + 1, outcome.again), memberOf({ ...entry, since: Math.max(now + 1, outcome.again) }));
      continue;
    }
    if (state === "untold") {
      // Every late payment given back, a buyer still to be told: tried again the next day, nothing owed any more.
      counts.untold += 1;
      await moveTo(member, now + DAY, memberOf({ ...entry, since: now + DAY, owed: 0 }));
      continue;
    }
    if (state === "owed") {
      // A payment after its end still to give back (the balance did not cover it, Stripe refused it, or more were
      // left than one try gives back): its account answered, so no day of refusals counts; tried again the next day.
      counts.owed += 1;
      const owed = entry.owed || now;
      const next = memberOf({ ...entry, since: now + DAY, owed });
      // Owed for PLAN_OWED_TELL_DAYS for a reason only the creator can end (their balance, Stripe refusing the
      // refund): the creator is told once, the mark written before the email and given back when it was not sent.
      const short = outcome?.short ?? [];
      if (entry.owedTold || !short.length || now - owed < PLAN_OWED_TELL_DAYS * DAY) {
        await moveTo(member, now + DAY, next);
        continue;
      }
      const marked = memberOf({ ...entry, since: now + DAY, owed, owedTold: true });
      if (!(await moveTo(member, now + DAY, marked))) continue;
      const said = await withCutoff(deadline, () => tellPlanOwed({ sid: entry.sid, product: entry.product, days: PLAN_OWED_TELL_DAYS, invoices: short })).catch((error: unknown) => {
        console.error("telling a creator about a plan's payment owed back failed", error);
        return "unsent" as const;
      });
      if (said === "unsent") {
        await moveTo(marked, now + DAY, next);
        console.error(`a plan's payment after its end has been owed for ${PLAN_OWED_TELL_DAYS} days; its creator could not be emailed now, tried again the next day`, account);
        continue;
      }
      if (said === "told") counts.owedTold += 1;
      console.error(`a plan's payment after its end has been owed for ${PLAN_OWED_TELL_DAYS} days: its creator ${said === "told" ? "emailed" : "not found to tell"}`, account);
      continue;
    }
    if (state === "open") {
      counts.open += 1;
      await moveTo(member, now + Math.max(0, Math.min(Math.floor((now - since) / 2), since + PLAN_GIVE_UP_DAYS * DAY - now)), member);
      continue;
    }
    // From here the plan has no good answer. Only its own account refusing us ("unread", a refusal of the
    // account's) counts toward PLAN_GIVE_UP_DAYS; anything else (Stripe down or busy, our key refused or missing,
    // a run cut off) is not the plan's: its count starts again and it is tried at the next run.
    if (!(state === "unread" || isAccountRefusal(failure))) {
      counts.failed += 1;
      await moveTo(member, now, memberOf({ ...entry, since: now }));
      continue;
    }
    if (now - since < PLAN_GIVE_UP_DAYS * DAY) {
      counts.failed += 1;
      // Due again after half the time it has been refused (so each wait is longer than the last), never after its
      // last day of the count.
      await moveTo(member, now + Math.max(0, Math.min(Math.floor((now - since) / 2), since + PLAN_GIVE_UP_DAYS * DAY - now)), member);
      continue;
    }
    // Refused for PLAN_GIVE_UP_DAYS (or no readable time): never let go. Tried once every PLAN_STUCK_RETRY_DAYS,
    // and its creator, who alone can let us back in, told once.
    counts.stuck += 1;
    const at = now + PLAN_STUCK_RETRY_DAYS * DAY;
    if (entry.told) {
      await moveTo(member, at, member);
      continue;
    }
    // The "told" mark is written before the email, so a plan is never told twice; an email that could not be sent
    // gives the mark back, so it is tried again at the plan's next try.
    const told = memberOf({ ...entry, told: true });
    if (!(await moveTo(member, at, told))) continue;
    // Inside the run's deadline: an email cut off by it is "unsent", its mark given back.
    const said = await withCutoff(deadline, () => tellPlanStuck({ sid: entry.sid, product: entry.product, account, days: PLAN_GIVE_UP_DAYS })).catch((error: unknown) => {
      console.error("telling a creator about a stuck payment plan failed", error);
      return "unsent" as const;
    });
    if (said === "unsent") {
      await moveTo(told, at, member);
      console.error(`a payment plan's account refused us for ${PLAN_GIVE_UP_DAYS} days: tried once a week from now on; its creator could not be emailed now, tried again at the next try`, account);
      continue;
    }
    if (said === "told") counts.told += 1;
    console.error(`a payment plan's account refused us for ${PLAN_GIVE_UP_DAYS} days: tried once a week from now on, its creator ${said === "told" ? "emailed" : "not found to tell"}`, account);
  }
  return counts;
}

/**
 * Puts a plan in the line of plans tried, due at `at`, as `next` (the same member, or one with another time or
 * mark), and only once that ZADD answered takes out what it was, so a refused or cut-off write never loses it.
 * True when it moved.
 */
async function moveTo(member: string, at: number, next: string): Promise<boolean> {
  if (!(await wrote([["ZADD", RETRY, at, next]]))) return false;
  await redisPipeline(next === member ? [["SREM", PENDING, member]] : [["SREM", PENDING, member], ["ZREM", RETRY, member]]).catch(
    (error: unknown) => console.error("moving a payment plan in its line failed", error),
  );
  return true;
}
