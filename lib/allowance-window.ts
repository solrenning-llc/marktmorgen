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
 *
 * Nothing here touches the network: pages that print when an allowance
 * opens again read the same window the counters do.
 */
import { type Cycle, TRIAL_DAYS } from "@/lib/plan";
import { type PlanFields, standingOf } from "@/lib/plan-standing";

/** What Stripe last said about the period a store paid for, in seconds (lib/store.ts). */
export type BillingPeriod = { start: number; end: number; renews: boolean; /** Only an acknowledged committed cash proof may set this. No inferred renewal. */ funded?: true };

/** The fields of a store the window is worked out from. */
export type WindowFields = PlanFields & { cycle?: Cycle; period?: BillingPeriod | null };

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
 * The window a store's allowances are counted in right now, or null when it
 * pays and its period is not known: then nothing that costs money may start.
 */
export function allowanceWindow(store: WindowFields, now = Date.now()): AllowanceWindow | null {
  if (!Number.isFinite(now)) return null;
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
  // short while, when the period renews.
  if (period.funded === true || !period.renews || now < period.end * 1000 || now >= (period.end + RENEW_GRACE_SECONDS) * 1000) return null;
  const start = period.end * 1000;
  return { id: day(start), start, end: addMonthsMs(start, 1), billing: true };
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
  const known = allowanceWindow(store, atMs);
  if (known) return known;
  if (standingOf(store, atMs / 1000) !== "paid" || !store.subscriptionId) return null;
  const period = store.period;
  if (!isPeriod(period) || !period.renews || atMs < period.end * 1000) return null;
  const yearly = store.cycle === "year";
  const step = yearly ? 12 : 1;
  // Stripe counts every period from its anchor, not from the last period's end: an anchor on the 29th to the 31st
  // is cut to a short month's last day and comes back after it (31 January, 28 February, 31 March). Of the period's
  // two ends, the later day of the month is the anchor's (the other may have been cut), so the next ends are that one
  // moved by whole periods, each cut to its month as Stripe cuts it.
  const startMs = period.start * 1000;
  const endMs = period.end * 1000;
  const anchor = new Date(endMs).getUTCDate() >= new Date(startMs).getUTCDate() ? endMs : startMs;
  const offset = anchor === endMs ? 0 : step;
  // At most a year and a day ahead is ever asked (lib/broadcasts.ts, MAX_SCHEDULE_DAYS); bounded all the same.
  for (let k = 0; k < 40; k += 1) {
    const start = addMonthsMs(anchor, offset + k * step);
    const end = addMonthsMs(anchor, offset + (k + 1) * step);
    if (atMs < start) return null;
    if (atMs < end) return yearly ? monthOfPeriod({ start: start / 1000, end: end / 1000, renews: true }, "year", atMs) : { id: day(start), start, end, billing: true };
  }
  return null;
}

/** The window's name, or null: what a counter's key carries. */
export function windowId(store: WindowFields, now = Date.now()): string | null {
  return allowanceWindow(store, now)?.id ?? null;
}

/** The calendar month a window began in ("2026-10"): which monthly company ledger its spending is reserved in. */
export function ledgerMonthOf(window: AllowanceWindow): string {
  return window.id.slice(0, 7);
}

/** Seconds a counter of this window must be kept: to its end, and a day more. */
export function keepSecondsFor(window: AllowanceWindow, now = Date.now()): number {
  return Math.max(86_400, Math.ceil((window.end - now) / 1000) + 86_400);
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
