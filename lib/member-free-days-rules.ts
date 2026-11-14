/**
 * Free days given to one member (641 [WG1]; owner's Whop audit, "manage
 * users"): the rules, browser-safe, read by the studio's form and by the
 * server (lib/member-free-days.ts).
 *
 * How the days are given. Stripe's two ways to skip a charge were weighed:
 *
 *   - pause_collection skips whole billing periods and, here, closes the
 *     membership's doors while it runs (lib/membership-pause-rules.ts: a pause
 *     is a membership not being paid for). Free days are a gift on top of
 *     what is open, not a door shut, and are counted in days, not periods.
 *   - trial_end set on the subscription, with proration_behavior "none",
 *     moves the next charge to that moment and charges and credits nothing
 *     for the days in between; the membership keeps running (its status reads
 *     "trialing", which every door here treats as running). This is the way
 *     Stripe documents for moving a subscription's billing date with a trial
 *     (docs.stripe.com/billing/subscriptions/billing-cycle, "Using a trial to
 *     change the billing cycle"; and the trial_end parameter of "Update a
 *     subscription" in the API reference). Read again on 7 November 2026
 *     (Claude 4, for Claude 5): the same page still documents it; setting
 *     billing_cycle_anchor to a chosen time is a private preview for flexible
 *     billing mode only, so it is not a way here.
 *
 * So the new trial_end is the next charge the creator saw plus the days,
 * exactly: the period already paid for, or the trial already running, is
 * kept whole, and the days come after it.
 *
 * A paid membership in its free days is not a free trial (Claude 4 team review
 * of #2912, A1 and M1). Stripe answers it "trialing", and keeps that trial_end
 * on it after the days end, so giving free days to one that was paid writes on
 * it, in the same request, which trial_end is free days (FREE_DAYS_UNTIL) and
 * the real trial it had before, 0 for none (TRIAL_END_BEFORE). Every reader
 * that takes "trialing" or trial_end for a free trial reads through
 * memberStatus and realTrialEnd: the member stays paying, in the numbers, the
 * MRR and the studio. Free days given inside a real trial leave it a trial.
 * Stripe prorates nothing inside a trial, so while paid free days run a tier
 * switch or a move to yearly would hand the new price over for nothing: both
 * are refused until the next charge (inPaidFreeDays).
 */

/**
 * The most days one press gives: one quarter. It covers a courtesy week, a
 * month lost to a problem, or a whole quarter of a quarterly plan; a longer
 * gift is a price, and a discount code (lib/member-discount.ts) says that
 * better. It also bounds the revenue one press can put off.
 */
export const FREE_DAYS_MAX = 90;
export const DAY_SECONDS = 86_400;

/** Why a running membership has no next charge to move. */
export type FreeDaysBlock = "ending" | "paused" | "behind" | "scheduled" | "unknown";

/** A whole number of days from 1 to FREE_DAYS_MAX, or null. */
export function parseFreeDays(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 1 && n <= FREE_DAYS_MAX ? n : null;
}

/** The next charge, `days` later. */
export function movedCharge(nextCharge: number, days: number): number {
  return nextCharge + days * DAY_SECONDS;
}

type Raw = Record<string, unknown>;
const num = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);

/** On a membership given free days while it was paid for: the trial_end that is free days, in seconds. */
export const FREE_DAYS_UNTIL = "mm_free_days_until";
/** And the end of the real free trial it had before, in seconds; "0" for none. */
export const TRIAL_END_BEFORE = "mm_trial_end_before";
const SECONDS = /^(0|[1-9]\d{0,11})$/;

function metaOf(sub: Raw): Record<string, unknown> {
  return sub.metadata && typeof sub.metadata === "object" ? (sub.metadata as Record<string, unknown>) : {};
}

/**
 * Whether the subscription's trial_end is free days given to a membership
 * already paid for, not a free trial: both marks written, and the first the
 * very trial_end Stripe holds. A trial set since in Stripe's dashboard has
 * another trial_end, so it reads as the trial it is.
 */
export function paidFreeDays(sub: Raw): boolean {
  const end = num(sub.trial_end);
  const meta = metaOf(sub);
  return end > 0 && meta[FREE_DAYS_UNTIL] === String(end) && typeof meta[TRIAL_END_BEFORE] === "string" && SECONDS.test(meta[TRIAL_END_BEFORE] as string);
}

/** The end of the membership's real free trial, in seconds, 0 for none: never paid free days. */
export function realTrialEnd(sub: Raw): number {
  return paidFreeDays(sub) ? Number(metaOf(sub)[TRIAL_END_BEFORE]) : num(sub.trial_end);
}

/** Stripe's status read as what the member is: a paid membership in its free days is "active", not in a trial. */
export function memberStatus(sub: Raw): string {
  const status = typeof sub.status === "string" ? sub.status : "";
  return status === "trialing" && paidFreeDays(sub) ? "active" : status;
}

/** Whether a paid membership's free days are running now: no switch of its price until they end (Stripe prorates nothing in a trial). */
export function inPaidFreeDays(sub: Raw): boolean {
  return sub.status === "trialing" && paidFreeDays(sub);
}

/**
 * The marks giving free days writes, from the membership as read before:
 * paid (running, or already in paid free days) keeps saying so, with its real
 * trial carried over; a real trial made longer stays a trial, both marks
 * removed (an empty value removes a key on Stripe).
 */
export function freeDaysMarks(sub: Raw, nextCharge: number): Record<string, string> {
  if (sub.status === "active" || inPaidFreeDays(sub)) return { [FREE_DAYS_UNTIL]: String(nextCharge), [TRIAL_END_BEFORE]: String(realTrialEnd(sub)) };
  return { [FREE_DAYS_UNTIL]: "", [TRIAL_END_BEFORE]: "" };
}

/** When the period already paid for ends: on the item since 2025, on the subscription before. */
function periodEnd(sub: Raw): number {
  const items = sub.items && typeof sub.items === "object" ? (sub.items as Raw).data : null;
  const first = Array.isArray(items) && items[0] && typeof items[0] === "object" ? (items[0] as Raw) : {};
  return num(first.current_period_end) || num(sub.current_period_end);
}

/**
 * A membership's next charge, in seconds, and why it may not be moved. Only
 * one running normally, paid or in a trial: not one set to end (there is no
 * next charge), paused (Stripe is already skipping it), behind on a payment
 * (that is settled first, by its own reminders), or on a schedule of changes
 * in Stripe, whose next phase would put the old date back.
 */
export function freeDaysState(sub: Raw, nowSeconds: number): { nextCharge: number; blocked: FreeDaysBlock | null } {
  const status = sub.status;
  if (status !== "active" && status !== "trialing") return { nextCharge: 0, blocked: "behind" };
  const nextCharge = status === "trialing" ? num(sub.trial_end) : periodEnd(sub);
  if (sub.cancel_at_period_end === true || num(sub.cancel_at)) return { nextCharge, blocked: "ending" };
  if (sub.pause_collection && typeof sub.pause_collection === "object") return { nextCharge, blocked: "paused" };
  if (sub.schedule) return { nextCharge, blocked: "scheduled" };
  if (nextCharge <= nowSeconds) return { nextCharge, blocked: "unknown" };
  return { nextCharge, blocked: null };
}

/** One of the member's running memberships here, as the studio's form shows it. */
export type FreeDaysSub = {
  id: string;
  product: string;
  amount: number;
  currency: string;
  interval: string;
  /** In seconds; 0 when it has none. */
  nextCharge: number;
  blocked: FreeDaysBlock | null;
};

/** What the studio says of a membership whose next charge cannot be moved. */
export const BLOCK_WORDS: Record<FreeDaysBlock, string> = {
  ending: "set to end, so there is no next charge to move",
  paused: "paused, so Stripe is already skipping its charges",
  behind: "behind on a payment: that is settled first",
  scheduled: "on a schedule of changes in Stripe, which would put the old date back",
  unknown: "its next charge date could not be read",
};
