/**
 * The window every monthly allowance of a store is counted in (added 17
 * October 2026).
 *
 * Until then every allowance reset on the 1st (UTC), while a subscription's
 * period starts on whatever day the creator first paid. One payment then
 * covered the tail of one calendar month and the head of the next, so a
 * store could use two months of every allowance for the price of one, and
 * the per-plan worst month (tests/plan-cost-registry.ts) was a month that a
 * payment does not buy. Now:
 *
 *   - A store that pays us counts its allowances in its own billing month:
 *     the period Stripe last told us it paid for, for a monthly plan, and
 *     the same period cut into twelve months on the day it began, for a
 *     yearly one (a yearly plan's allowances are monthly, like the price it
 *     is ten of). One payment, one window: what tests/plan-cost-model.ts
 *     prices.
 *   - The window is named by the UTC day it starts ("2026-10-19"), so two
 *     windows of one subscription never share a name, and none of them shares
 *     one with a calendar month ("2026-10"). Two windows that start on the
 *     same day (a plan moved to yearly the day it renewed) share one: the
 *     store gets the rest of the same allowance, never a second one.
 *   - A store in its free trial counts the trial as one window, from the day
 *     it began (TRIAL_DAYS before it ends) to its end, so a trial that
 *     crosses the 1st is still one trial's allowance.
 *   - A store that pays nothing otherwise (no plan, a plan that ended), and
 *     a store given a plan with no subscription behind it (the demo store),
 *     keeps the calendar month: there is no payment to follow. What stores
 *     that pay nothing cost is a funded exposure with its own shared ceiling
 *     (lib/free-pool-rules.ts), not a plan's worst month.
 *   - Unknown is closed. A store that pays but whose period we do not have
 *     (a record from before this was kept) has no window, and every costly
 *     use that asks for one is refused until the studio or the daily job
 *     (lib/billing-sync.ts) reads the period from Stripe. Stripe moves a
 *     renewing subscription into its next period on the day the last one
 *     ends; the snapshot learns it when the studio is opened or the daily
 *     job runs, so for RENEW_GRACE_SECONDS after a period's end the next
 *     window (which starts exactly there) is used, and after that nothing.
 *     A period set to end with no renewal gets no such grace. A period whose
 *     cash proof was acknowledged (funded=true) also gets no inferred next
 *     allowance: another period needs its own acknowledged funding proof.
 *   - A change of billing interval does not open a window (9 November 2026).
 *     Stripe starts a new period on the day of the change (lib/billing.ts,
 *     switchPlan), so a window named by the period's first day would start
 *     every allowance again, once per switch: one switch a day gave 31 in a
 *     month paid once. When the period of the same subscription moves while a
 *     window is open (setSubscription, lib/store.ts), the store keeps that
 *     window as its allowance anchor, and from then on counts in it to its end
 *     and in whole months after it, the period deciding only whether the
 *     store pays at that moment. Never a short window between the open one and
 *     the new period's day, which would be a second allowance in one month;
 *     never a longer one, which would take allowance away. Only another
 *     subscription, or a skipped renewal (a later period paid after the
 *     record's own ended and its grace ran out, beginning on one of its
 *     renewals, whether or not the stop was recorded), leaves it behind; a
 *     switch written over a stale record begins off them and keeps it. An
 *     anchor that cannot be read lets in to
 *     nothing, like a period that is not known.
 *
 * Nothing here touches the network: pages that print when an allowance
 * opens again read the same window the counters do.
 */
import { type Cycle, TRIAL_DAYS } from "@/lib/plan";
import { type PlanFields, standingOf } from "@/lib/plan-standing";

/** What Stripe last said about the period a store paid for, in seconds (lib/store.ts). */
export type BillingPeriod = { start: number; end: number; renews: boolean; /** Only an acknowledged committed cash proof may set this. No inferred renewal. */ funded?: true };

/**
 * The window a store's allowances were counted in when its period moved without a renewal (an interval switch), in
 * milliseconds, and the subscription it belongs to (lib/store.ts, setSubscription). Its months go on from it.
 */
export type AllowanceAnchor = { subscriptionId: string; start: number; end: number };

/** The fields of a store the window is worked out from. */
export type WindowFields = PlanFields & { cycle?: Cycle; period?: BillingPeriod | null; allowanceAnchor?: AllowanceAnchor | null };

export type AllowanceWindow = {
  /** "2026-10-19" for a billing month, "2026-10" for a calendar month. Goes into every counter's key. */
  id: string;
  /** Milliseconds since the epoch: when the window began, and when it ends. */
  start: number;
  end: number;
  /** Whether it follows a payment (a billing month) or the calendar. */
  billing: boolean;
};

/** Every window's name, in a counter's key: a calendar month, or the day a billing month began. */
export const WINDOW_ID = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

/** How long after a period's end the next one is assumed to have begun, while the snapshot has not caught up. */
export const RENEW_GRACE_SECONDS = 2 * 86_400;

/** A period that started a little in the future, by the clock of whoever wrote it, still counts. */
const CLOCK_SKEW_SECONDS = 300;

/** Days a billing month can last, and so a counter of one must be kept for at the least. */
export const LONGEST_WINDOW_DAYS = 31;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The calendar month (UTC) around a moment. */
export function calendarWindow(now = Date.now()): AllowanceWindow {
  const at = new Date(now);
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return { id: new Date(start).toISOString().slice(0, 7), start, end, billing: false };
}

/** A moment plus whole calendar months, at the same time of day; a day past a month's end goes to its last day (how Stripe counts). */
export function addMonthsMs(atMs: number, months: number): number {
  const date = new Date(atMs);
  const dayOf = date.getUTCDate();
  const moved = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const last = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate();
  moved.setUTCDate(Math.min(dayOf, last));
  return moved.getTime();
}

/** Whether a period read from a store's record is one a window can be made from. */
export function isPeriod(value: unknown): value is BillingPeriod {
  if (!value || typeof value !== "object") return false;
  const { start, end, renews, funded } = value as Record<string, unknown>;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) > 0 && (end as number) > (start as number) && typeof renews === "boolean" && (funded === undefined || funded === true)
    // A billing period is at most a year and a day long.
    && (end as number) - (start as number) <= 367 * 86_400;
}

/** Whether two billing periods are the same one: a snapshot is written again when they differ. */
export function samePeriod(a: BillingPeriod | null, b: BillingPeriod | null): boolean {
  return a === b || (!!a && !!b && a.start === b.start && a.end === b.end && a.renews === b.renews && a.funded === b.funded);
}

/** Whether an anchor read from a store's record is one windows can be counted from: one window, at most a billing month long. */
export function isAllowanceAnchor(value: unknown): value is AllowanceAnchor {
  if (!value || typeof value !== "object") return false;
  const { subscriptionId, start, end } = value as Record<string, unknown>;
  return typeof subscriptionId === "string" && subscriptionId.length > 0 && subscriptionId.length <= 128
    && Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) > 0 && (end as number) > (start as number)
    && (end as number) - (start as number) <= LONGEST_WINDOW_DAYS * 86_400_000;
}

/** The billing month of a paid period around `now`: the period itself for a monthly plan, its month on the period's day for a yearly one. */
function monthOfPeriod(period: BillingPeriod, cycle: Cycle, now: number): AllowanceWindow | null {
  const start = period.start * 1000;
  const end = period.end * 1000;
  if (now < start - CLOCK_SKEW_SECONDS * 1000 || now >= end) return null;
  if (cycle !== "year") return { id: day(start), start, end, billing: true };
  // A yearly period, in months that start on the period's own day.
  let from = start;
  for (let k = 1; k <= 12; k += 1) {
    const next = Math.min(addMonthsMs(start, k), end);
    if (now < next || k === 12) return { id: day(from), start: from, end: k === 12 ? end : next, billing: true };
    from = next;
  }
  return null;
}

/**
 * Where the periods after a renewing one are counted from. Stripe counts every period from its anchor, not from the
 * last period's end: an anchor on the 29th to the 31st is cut to a short month's last day and comes back after it
 * (31 January, 28 February, 31 March). The next period always begins at this one's end, the boundary Stripe gave.
 * Only a whole period (exactly a step from its start, as Stripe cuts it) whose end fell on an earlier day than its
 * start proves a cut end, and then the anchor is the start's day; any other period, a partial first one included
 * (31 January to 15 February, before the first whole invoice), is anchored on its end (Codex H, #2269: inferring the
 * anchor from the later day of either end put the next window on 28 February, after now, and a second allowance
 * opened once the real period came). So the k-th period after this one starts at addMonthsMs(anchor, offset + k *
 * step), the first of them at this one's end, and ends a step later, each cut to its month as Stripe cuts it.
 */
function anchorOf(period: BillingPeriod, yearly: boolean): { anchor: number; offset: number; step: number } {
  const step = yearly ? 12 : 1;
  const startMs = period.start * 1000;
  const endMs = period.end * 1000;
  const cutEnd = addMonthsMs(startMs, step) === endMs && new Date(startMs).getUTCDate() > new Date(endMs).getUTCDate();
  return cutEnd ? { anchor: startMs, offset: step, step } : { anchor: endMs, offset: 0, step };
}

/**
 * The months of an anchor: the anchored window itself up to its end, then whole months from it, cut to a month's last
 * day as Stripe cuts a period and counted from the anchor (anchorOf), so 31 January is followed by 28 February and
 * then 31 March. Null before the anchor began.
 */
function anchoredWindow(anchor: AllowanceAnchor, now: number): AllowanceWindow | null {
  if (now < anchor.start - CLOCK_SKEW_SECONDS * 1000) return null;
  if (now < anchor.end) return { id: day(anchor.start), start: anchor.start, end: anchor.end, billing: true };
  const { anchor: from, offset } = anchorOf({ start: anchor.start / 1000, end: anchor.end / 1000, renews: true }, false);
  const ends = new Date(anchor.end), at = new Date(now);
  // The month that holds `now`, found from the calendar months between, then stepped to exactly.
  let k = Math.max(0, (at.getUTCFullYear() - ends.getUTCFullYear()) * 12 + at.getUTCMonth() - ends.getUTCMonth() - 1);
  while (k > 0 && addMonthsMs(from, offset + k) > now) k -= 1;
  for (let guard = 0; guard < 4; guard += 1, k += 1) {
    const start = addMonthsMs(from, offset + k);
    const end = addMonthsMs(from, offset + k + 1);
    if (now >= start && now < end) return { id: day(start), start, end, billing: true };
  }
  return null;
}

/**
 * A window worked out from the period (or the trial, or the calendar), read through the store's allowance anchor:
 * a paying store with one counts in its months instead, while the period says it pays; one that cannot be read
 * lets in to nothing; one of another subscription is not this plan's.
 */
function throughAnchor(store: WindowFields, window: AllowanceWindow | null, now: number): AllowanceWindow | null {
  if (!window || !window.billing) return window;
  const anchor = store.allowanceAnchor;
  if (anchor === undefined || anchor === null) return window;
  if (!isAllowanceAnchor(anchor)) return null;
  if (anchor.subscriptionId !== store.subscriptionId) return window;
  return anchoredWindow(anchor, now);
}

/**
 * The window a store's allowances are counted in right now, or null when it
 * pays and its period is not known: then nothing that costs money may start.
 */
export function allowanceWindow(store: WindowFields, now = Date.now()): AllowanceWindow | null {
  if (!Number.isFinite(now)) return null;
  return throughAnchor(store, periodWindow(store, now), now);
}

/** The window as the period alone tells it (allowanceWindow before the anchor is read). */
function periodWindow(store: WindowFields, now: number): AllowanceWindow | null {
  const standing = standingOf(store, now / 1000);
  // A free trial: the trial itself, one window from the day it began.
  if (standing === "trial") {
    const end = store.trialEnds * 1000;
    const start = end - TRIAL_DAYS * 86_400_000;
    return { id: day(start), start, end, billing: false };
  }
  // Not paying, or a plan with nothing behind it: the calendar month.
  if (standing !== "paid" || !store.subscriptionId) return calendarWindow(now);
  const period = store.period;
  if (!isPeriod(period)) return null;
  const cycle: Cycle = store.cycle === "year" ? "year" : "month";
  const current = monthOfPeriod(period, cycle, now);
  if (current) return current;
  // Past the period's end: the next one, which begins exactly there, for a
  // short while, when the period renews. It ends where Stripe ends it, counted
  // from the anchor, not a month after a cut day: a period of 31 January to 28
  // February is followed by 28 February to 31 March, never to 28 March, or a
  // counter made for it would lapse on 29 March and open a second allowance
  // for the three days left (review of #2205, C3-112).
  if (period.funded === true || !period.renews || now < period.end * 1000 || now >= (period.end + RENEW_GRACE_SECONDS) * 1000) return null;
  const { anchor, offset, step } = anchorOf(period, cycle === "year");
  const start = addMonthsMs(anchor, offset);
  const end = addMonthsMs(anchor, offset + step);
  // It begins at the period's end, by construction; a window that would begin after now is never answered (Codex H, #2269).
  if (start !== period.end * 1000 || now < start || now >= end) return null;
  if (cycle === "year") return monthOfPeriod({ start: start / 1000, end: end / 1000, renews: true }, "year", now);
  return { id: day(start), start, end, billing: true };
}

/**
 * The window a store's allowances will be counted in at `atMs`, as its plan
 * stands now: allowanceWindow when that already tells it (the window running
 * then, a trial, the calendar month), and past a renewing period's end the
 * periods that follow it (a monthly plan's next months, a yearly plan's next
 * year cut into months on its own day). Null when, as the plan stands, nothing
 * pays for that moment: the plan set to end before it, or its period unknown.
 * What a use written down now and made then holds in (lib/broadcasts.ts, a
 * scheduled email's reading of its buyers). Only a projection: whoever holds in
 * it checks, when the moment comes, that the window running then is this one.
 */
export function windowAt(store: WindowFields, atMs: number): AllowanceWindow | null {
  if (!Number.isFinite(atMs)) return null;
  return throughAnchor(store, periodWindowAt(store, atMs), atMs);
}

/** windowAt as the period alone tells it. */
function periodWindowAt(store: WindowFields, atMs: number): AllowanceWindow | null {
  const known = periodWindow(store, atMs);
  if (known) return known;
  if (standingOf(store, atMs / 1000) !== "paid" || !store.subscriptionId) return null;
  const period = store.period;
  if (!isPeriod(period) || !period.renews || atMs < period.end * 1000) return null;
  const yearly = store.cycle === "year";
  // The periods that follow, each from the anchor as Stripe counts them (anchorOf).
  const { anchor, offset, step } = anchorOf(period, yearly);
  // At most a year and a day ahead is ever asked (lib/broadcasts.ts, MAX_SCHEDULE_DAYS); bounded all the same.
  for (let k = 0; k < 40; k += 1) {
    const start = addMonthsMs(anchor, offset + k * step);
    const end = addMonthsMs(anchor, offset + (k + 1) * step);
    if (atMs < start) return null;
    if (atMs < end) return yearly ? monthOfPeriod({ start: start / 1000, end: end / 1000, renews: true }, "year", atMs) : { id: day(start), start, end, billing: true };
  }
  return null;
}

/**
 * The allowance anchor a store's record must carry once `next` is written over `previous` at `now`
 * (lib/store.ts, setSubscription, in the same write as the period). One already kept for the same subscription stays
 * as it is, readable or not, through a plan seen stopped (keptThroughStop decides when it runs again), except that a
 * readable one is left behind when a renewal was skipped (skippedRenewal), stop recorded or not. Otherwise, when
 * the period of the same subscription moves so that it begins inside the paid window open now (an interval switch:
 * Stripe begins the new period at the moment of the change), the open window becomes the anchor, whether or not the
 * new period already counts (a period a little in the future does too). The open window is what the snapshot says,
 * or, when it has missed a renewal, the window that renewal opened (windowAt). A switch written only after that window
 * turned (a 3DS confirmation, the next day's job, a write that failed and is made again) begins after the record's
 * own period and before the open window: the old record's window that holds its first day becomes the anchor, so the
 * window open now, perhaps already used, keeps its name. A renewal, a trial's end, a change that keeps the period, a
 * plan not running, an older period written late and another subscription write none.
 */
export function anchorAfter(previous: WindowFields, next: WindowFields, now = Date.now()): AllowanceAnchor | null {
  if (!next.subscriptionId || previous.subscriptionId !== next.subscriptionId) return null;
  const kept = previous.allowanceAnchor;
  if (kept !== undefined && kept !== null && (!isAllowanceAnchor(kept) || kept.subscriptionId === next.subscriptionId)) {
    // A stop written after the record's period and its grace, with the overdue period never written: no window could be
    // open since the grace ended, so the anchor is left behind and a later payment opens one window, its own.
    if (isAllowanceAnchor(kept) && !next.subscriptionActive && isPeriod(previous.period) && now > (previous.period.end + RENEW_GRACE_SECONDS) * 1000) return null;
    return isAllowanceAnchor(kept) && (skippedRenewal(previous, next) || !keptThroughStop(previous, next, kept, now)) ? null : kept;
  }
  if (!Number.isFinite(now)) return null;
  if (standingOf(next, now / 1000) !== "paid" || !isPeriod(next.period)) return null;
  const old = { ...previous, allowanceAnchor: null };
  const open = windowAt(old, now);
  if (!open || !open.billing) return null;
  // Only a period that begins inside the open window, after it began, moved without a renewal: one that begins at its
  // end or later is the next payment's, and one that begins at its start is the same month.
  const begins = next.period.start * 1000;
  if (open.start < begins && begins < open.end) return anchorFrom(next.subscriptionId, open);
  // One that begins before the open window is a switch written late only when it also begins after the record's own
  // period began: one that begins before that is an older snapshot written late, no switch.
  if (!(begins < open.start) || !isPeriod(previous.period) || !(previous.period.start * 1000 < begins)) return null;
  const held = windowAt(old, begins);
  if (!held || !held.billing || !(held.start < begins && begins < held.end)) return null;
  const anchor = anchorFrom(next.subscriptionId, held);
  // Its months must bring back the open window exactly, or the window counted now would change its name; when they
  // do not, the open window itself is the anchor.
  const at = anchor && anchoredWindow(anchor, now);
  return at && at.start === open.start && at.end === open.end ? anchor : anchorFrom(next.subscriptionId, open);
}

/** An anchor of one window, or null when the window is not one an anchor can be (isAllowanceAnchor). */
function anchorFrom(subscriptionId: string, window: AllowanceWindow): AllowanceAnchor | null {
  const anchor = { subscriptionId, start: window.start, end: window.end };
  return isAllowanceAnchor(anchor) ? anchor : null;
}

/**
 * Whether the new period begins after the record's own period ended and its renewal's grace ran out, exactly on one of
 * the renewals that follow it (anchorOf, the boundary Stripe gives, to the millisecond as periodWindow reads it): a
 * renewal was skipped (not paid, and a later period paid), whatever the record says about a stop. The stop may never
 * have reached the record (a lost webhook, the daily job not run), or a Stripe read made before it may have landed after
 * it and wiped its day (setSubscription clears planEndedAt on an active write). The anchor's months after that end were
 * never paid for: the period's own months come back, one window for one payment. A renewal written in its grace, a
 * period that begins inside the record's own, and one that begins off the renewals' chain (a switch made after a
 * renewal that was paid but not written, Stripe beginning the new period at the moment of the change) are no skip:
 * the anchor goes on, so the window open then, perhaps already used, is never opened whole again days after it
 * (focal review of #3396).
 */
function skippedRenewal(previous: WindowFields, next: WindowFields): boolean {
  if (!isPeriod(previous.period) || !isPeriod(next.period) || !(next.period.start > previous.period.end + RENEW_GRACE_SECONDS)) return false;
  return onRenewalChain(previous.period, previous.cycle === "year", next.period.start * 1000);
}

/** Whether `startMs` is exactly the start of one of the periods that follow a renewing `period` (anchorOf). */
function onRenewalChain(period: BillingPeriod, yearly: boolean, startMs: number): boolean {
  const { anchor, offset, step } = anchorOf(period, yearly);
  const from = new Date(anchor), at = new Date(startMs);
  // addMonthsMs keeps the month it lands in, so the only candidate is the calendar months between.
  const months = (at.getUTCFullYear() - from.getUTCFullYear()) * 12 + at.getUTCMonth() - from.getUTCMonth();
  return months >= offset && (months - offset) % step === 0 && addMonthsMs(anchor, months) === startMs;
}

/**
 * Whether an anchor kept through a plan seen stopped still counts once it runs again. Only when the window of the
 * anchor that holds the new period's first day began before the plan was seen stopped: that window may already have
 * been counted in, and going on in it opens nothing again. Otherwise a period was skipped (a renewal never paid, and
 * a later one paid): the anchor's months after the stop were never paid for, and counting the new period in them would
 * give one payment two windows, so the period's own months come back. A stop whose day cannot be read is taken as late
 * as it can be (now): the anchor is kept, so nothing already used opens again. A plan that was not stopped, or that
 * does not run yet, keeps it as it is.
 */
function keptThroughStop(previous: WindowFields, next: WindowFields, kept: AllowanceAnchor, now: number): boolean {
  if (standingOf(previous, now / 1000) !== "ended") return true;
  if (!Number.isFinite(now) || standingOf(next, now / 1000) !== "paid" || !isPeriod(next.period)) return true;
  const read = Date.parse(previous.planEndedAt);
  const stopped = Number.isFinite(read) ? Math.min(read, now) : now;
  const holds = anchoredWindow(kept, next.period.start * 1000);
  return !holds || holds.start <= stopped;
}

/** The window's name, or null: what a counter's key carries. */
export function windowId(store: WindowFields, now = Date.now()): string | null {
  return allowanceWindow(store, now)?.id ?? null;
}

/** The calendar month a window began in ("2026-10"): which monthly company ledger its spending is reserved in. */
export function ledgerMonthOf(window: AllowanceWindow): string {
  return window.id.slice(0, 7);
}

/**
 * Seconds a counter of this window must be kept: to its end, and a day more. A
 * billing month's counter is kept, besides, at least LONGEST_WINDOW_DAYS from
 * its start: a counter made ahead for a window worked out before the period
 * that holds it was known (a scheduled email's hold) never lapses while that
 * month still runs, which would open a second allowance in it, and a give-back
 * (lib/store-allowance.ts, giveAllowanceIn) still finds it (C3-112).
 */
export function keepSecondsFor(window: AllowanceWindow, now = Date.now()): number {
  const until = window.billing ? Math.max(window.end, window.start + LONGEST_WINDOW_DAYS * 86_400_000) : window.end;
  return Math.max(86_400, Math.ceil((until - now) / 1000) + 86_400);
}

/** "November 19" (or "November 19, 2027" in another year): the day an allowance opens again. */
export function opensAgainWords(window: AllowanceWindow, now = Date.now()): string {
  const at = new Date(window.end);
  const sameYear = at.getUTCFullYear() === new Date(now).getUTCFullYear();
  return at.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * The sentence a refused use ends with: when the allowance opens again, or how to get it back when no window is known.
 * In a trial, a kind that a store whose plan ended has none of (`endedNone`, e.g. API requests) never opens again
 * when the trial ends without a plan, so it says the trial's end and what comes after.
 */
export function resetWords(store: WindowFields, now = Date.now(), endedNone = false): string {
  const window = allowanceWindow(store, now);
  if (!window) return "Open your studio so we can read your plan's billing month from Stripe, then try again.";
  if (endedNone && standingOf(store, now / 1000) === "trial") return `The trial ends on ${opensAgainWords(window, now)} (UTC); after that, these need a paid plan.`;
  return window.billing
    ? `This opens again with your next billing month, on ${opensAgainWords(window, now)} (UTC).`
    : `This opens again on ${opensAgainWords(window, now)} (UTC).`;
}
