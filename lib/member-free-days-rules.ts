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
 *     subscription" in the API reference). Not read again on 6 November 2026:
 *     docs.stripe.com could not be reached from where this was built, so the
 *     source is cited as known, unverified that day.
 *
 * So the new trial_end is the next charge the creator saw plus the days,
 * exactly: the period already paid for, or the trial already running, is
 * kept whole, and the days come after it.
 *
 * "Trialing" is then not a free trial (Claude 6 on #2912). On a membership
 * already paid for, Stripe reads it "trialing" from the moment the days are
 * given, for the rest of the period paid and the days after it, and keeps
 * that trial_end once it runs again. Every reader that takes "trialing" for a
 * free trial would say the wrong thing: a switch of tier shown as nothing due,
 * a receipt without what was charged, a paying member counted as one in a
 * trial. So the same request that moves the date marks the membership
 * (FREE_DAYS_PAID: "1" paid before, "0" a free trial given more days; and,
 * when paid before, FREE_DAYS_TRIAL_WAS: the end of the real trial it had, or
 * "0"), and the readers ask inFreeTrial and paidFreeDays below, never the
 * status alone. Free days with no mark cannot be told apart: not a free trial.
 */

/** Metadata the free days write: whether the membership was paid for before them ("1") or in a free trial ("0"). */
export const FREE_DAYS_PAID = "free_days_paid";
/** Metadata, when paid before: the end of the membership's real trial, in seconds, or "0" when it had none. */
export const FREE_DAYS_TRIAL_WAS = "free_days_trial_was";

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

const metaOf = (sub: { metadata?: unknown }): Record<string, unknown> =>
  sub.metadata && typeof sub.metadata === "object" && !Array.isArray(sub.metadata) ? (sub.metadata as Record<string, unknown>) : {};
const isSet = (value: unknown) => value !== undefined && value !== null && value !== "";

/**
 * A member moved from another platform (lib/move-members.ts, lib/store-checkout.ts):
 * its checkout sets trial_end to the first charge here and marks it
 * metadata[moved] "yes", so Stripe reads it "trialing" until then, for a
 * period the member already paid on the other platform (Claude 5 on #2912).
 * It is paid for, never in a free trial, and never had one here.
 */
export function movedHere(sub: { metadata?: unknown }): boolean {
  return metaOf(sub).moved === "yes";
}

/**
 * Whether the membership's "trialing" is something other than a free trial:
 * a member moved from another platform (movedHere), or free days given here on
 * a membership paid for before ("1"), or given with no mark that says which
 * (unknown, so not a free trial). False only when it was not moved and no free
 * days were given, or they were given in a free trial ("0").
 */
export function paidFreeDays(sub: { metadata?: unknown }): boolean {
  if (movedHere(sub)) return true;
  const meta = metaOf(sub);
  if (meta[FREE_DAYS_PAID] === "0") return false;
  return isSet(meta[FREE_DAYS_PAID]) || isSet(meta.free_days);
}

/** Whether a membership is in a real free trial: Stripe says "trialing" and no free days given on a paid one say otherwise. */
export function inFreeTrial(sub: { status?: unknown; metadata?: unknown }): boolean {
  return sub.status === "trialing" && !paidFreeDays(sub);
}

/** Whether a membership is "trialing" only because it was moved here paid, or free days were given on it while paid (or it cannot be told). */
export function onPaidFreeDays(sub: { status?: unknown; metadata?: unknown }): boolean {
  return sub.status === "trialing" && paidFreeDays(sub);
}

/**
 * The end of a membership's real free trial, in seconds, or 0: Stripe's
 * trial_end, except after free days given on a paid membership, whose
 * trial_end is the days' own (then the end kept when they were given), and
 * on a moved member, whose trial_end is its first charge here (then 0, or the
 * end kept by free days given since, which is 0 too).
 */
export function realTrialEnd(sub: { trial_end?: unknown; metadata?: unknown }): number {
  if (!paidFreeDays(sub)) return num(sub.trial_end);
  return num(Number(metaOf(sub)[FREE_DAYS_TRIAL_WAS]));
}

/**
 * The marks the free days carry on the request that moves the date, read from
 * the membership as Stripe answered before it: a free trial stays one ("0"); a
 * paid membership, or one already on free days given while paid, is "1" with
 * its real trial's end.
 */
export function freeDaysMarks(sub: Raw): Record<string, string> {
  if (inFreeTrial(sub)) return { [`metadata[${FREE_DAYS_PAID}]`]: "0" };
  return { [`metadata[${FREE_DAYS_PAID}]`]: "1", [`metadata[${FREE_DAYS_TRIAL_WAS}]`]: String(realTrialEnd(sub)) };
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
