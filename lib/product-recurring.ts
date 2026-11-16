/**
 * Selling the same thing every month, on the creator's own account.
 *
 * A membership is a product that charges on a schedule instead of once. The
 * important part is where the schedule lives: the subscription is created on
 * the creator's own connected Stripe account, as a direct charge with no
 * application fee, exactly like a single sale. So the member is the creator's
 * customer, in the creator's own Stripe dashboard, with the creator's name on
 * the statement — and if the creator ever leaves here, the paying members go
 * with them, because they were never ours to keep.
 *
 * That is the whole difference from a platform that holds the balance. It is
 * also why this file is small: the hard part was already decided by making
 * every charge a direct charge.
 *
 * Two things can be added to the schedule, both on the creator's own account
 * and both said on the store page in plain words before anybody pays:
 *
 *   A free trial. Stripe starts the subscription without charging, and the
 *   first payment is taken when the trial ends. The card is asked for at
 *   checkout, and the page says so, because "free" that quietly becomes a
 *   charge is the oldest trick there is.
 *
 *   A fixed number of payments. Twelve monthly payments, then it ends by
 *   itself. Stripe cannot be told that when the checkout opens, so once the
 *   member has joined the subscription is given the exact moment it stops —
 *   the same machinery a payment plan uses (lib/plans.ts), including the
 *   daily job for members who never came back from paying. Cancelling earlier
 *   is still the member's right, and works exactly as before.
 *
 * Without either, a membership runs until somebody cancels it.
 *
 * And how often it charges (609 [WP8]): once every interval, or every 2 weeks,
 * or every 2, 3 or 6 months (lib/recurring-every-rules.ts). Kept only when it
 * is more than one, so every membership written before reads as it did.
 */
import { everyPriceLine, parseEvery, readEvery } from "@/lib/recurring-every-rules";

/** The schedules Stripe bills on, and the ones a creator may choose. */
export const INTERVALS = ["day", "week", "month", "year"] as const;
export type Interval = (typeof INTERVALS)[number];

/** The shortest and longest free trial a membership may offer, in days. */
export const MIN_TRIAL_DAYS = 1;
export const MAX_TRIAL_DAYS = 90;

/** How many payments a membership that ends by itself may run for. */
export const MIN_MEMBER_PAYMENTS = 2;
export const MAX_MEMBER_PAYMENTS = 36;

/** How a membership charges. */
export type Recurring = {
  interval: Interval;
  /** Days free before the first payment. 0 is no trial. */
  trialDays: number;
  /** How many payments before it ends by itself. 0 is until cancelled. */
  payments: number;
  /** How many intervals one charge covers, when more than one: 3 with "month" is every 3 months (609 [WP8]). Absent is 1. */
  every?: number;
};

/** How many intervals one charge covers: 1 unless the membership says more (609 [WP8]). */
export function everyOf(recurring: { interval: Interval; every?: number }): number {
  return parseEvery(recurring.interval, recurring.every);
}

export function isInterval(value: unknown): value is Interval {
  return (
    typeof value === "string" && (INTERVALS as readonly string[]).includes(value)
  );
}

/** A whole number inside a range, or 0 when it is anything else. */
function within(raw: unknown, min: number, max: number): number {
  const n = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : 0;
}

export type RecurringProblem = "trial" | "payments" | "every";

/**
 * Reads what the editor sent and returns a schedule, nothing, or which part
 * was wrong. An empty trial or payment count means none; anything typed has
 * to be a whole number inside its range, because a trial of "7.5" days or
 * "forever" payments is a promise the page cannot keep.
 */
export function readRecurring(
  rawInterval: string,
  rawTrial: unknown = "",
  rawPayments: unknown = "",
  rawEvery: unknown = "",
): Recurring | null | RecurringProblem {
  if (!isInterval(rawInterval)) return null;
  const typed = (value: unknown) => value !== "" && value !== null && value !== undefined && value !== 0 && value !== "0";
  const trialDays = within(rawTrial, MIN_TRIAL_DAYS, MAX_TRIAL_DAYS);
  if (typed(rawTrial) && trialDays === 0) return "trial";
  const payments = within(rawPayments, MIN_MEMBER_PAYMENTS, MAX_MEMBER_PAYMENTS);
  if (typed(rawPayments) && payments === 0) return "payments";
  const every = readEvery(rawInterval, rawEvery);
  if (every === "every") return "every";
  return { interval: rawInterval, trialDays, payments, ...(every > 1 ? { every } : {}) };
}

/** Whatever came back from storage, made safe to use. */
export function parseRecurring(raw: unknown): Recurring | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Recurring>;
  if (!isInterval(value.interval)) return null;
  // Memberships written before trials and endings existed have neither.
  const every = parseEvery(value.interval, value.every);
  return {
    interval: value.interval,
    trialDays: within(value.trialDays, MIN_TRIAL_DAYS, MAX_TRIAL_DAYS),
    payments: within(value.payments, MIN_MEMBER_PAYMENTS, MAX_MEMBER_PAYMENTS),
    ...(every > 1 ? { every } : {}),
  };
}

/** "a month", "a week" — how the price is read aloud on the page. */
export function everyLabel(interval: Interval): string {
  return { day: "a day", week: "a week", month: "a month", year: "a year" }[
    interval
  ];
}

/** "Monthly", for a sentence that needs a name rather than a phrase. */
export function intervalName(interval: Interval): string {
  return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[
    interval
  ];
}

/** "monthly", as a word inside a sentence. */
export function intervalAdjective(interval: Interval): string {
  return { day: "daily", week: "weekly", month: "monthly", year: "yearly" }[interval];
}

/**
 * The whole price line of a membership: "$9 a month", "7-day free trial, then
 * $9 a month", "12 monthly payments of $9", "7-day free trial, then 12
 * monthly payments of $9". `price` is already written as a person reads it.
 */
export function membershipPrice(recurring: Recurring, price: string): string {
  // Said with how often it charges (609 [WP8]): "$90 every 3 months", never "$90 a month" for it.
  return everyPriceLine({ ...recurring, count: everyOf(recurring) }, price);
}
