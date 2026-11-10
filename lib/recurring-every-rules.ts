/**
 * Billing every N weeks or months (609 [WP8], unit 1; owner's Whop audit of
 * 1 November 2026): the rules, pure and browser-safe. A membership may charge
 * every 2 weeks, or every 2, 3 or 6 months, instead of once each week or
 * month; the price line always says the exact interval ("$90 every 3
 * months"), never a monthly figure the member is not charged.
 *
 * Nothing here is wired yet: the editor, the stored product, the checkout and
 * the buyer's words come in the next units. This file fixes what they will all
 * read, so they cannot disagree:
 *
 *   - which counts each interval may take (EVERY_CHOICES), inside Stripe's own
 *     ceiling for one subscription interval, three years (STRIPE_MAX_EVERY);
 *   - how a count sent by the editor is read (an empty one is 1; anything else
 *     that is not a choice is refused, never rounded to a near one), and how a
 *     kept one is made safe (anything not a choice is 1, as before WP8);
 *   - the exact words of the interval and of the whole price line;
 *   - the two fields Stripe is sent, the count only when it is not 1;
 *   - what a count above 1 cannot go with yet: an introductory price (counted
 *     in months, lib/intro-price.ts), a yearly option (twelve monthly payments,
 *     lib/yearly-price.ts), a pause (whole months, lib/membership-pause-rules.ts)
 *     and plan switching (lib/tier-switch.ts). Each is refused with its reason
 *     rather than charged on a schedule the page did not say.
 *
 * What a member pays a month, for the store's numbers, is already read from
 * Stripe's interval_count (monthly in lib/membership-numbers.ts, perMonth in
 * lib/mrr-movements.ts): $90 every 3 months is $30 of MRR there, not $90.
 *
 * Official source, read 10 November 2026: Stripe API reference, "Create a
 * Checkout Session", line_items.price_data.recurring.interval_count (API
 * version 2026-10-28): "The number of intervals between subscription billings.
 * For example, interval=month and interval_count=3 bills every 3 months.
 * Maximum of three years interval allowed (3 years, 36 months, or 156 weeks)."
 * https://docs.stripe.com/api/checkout/sessions/create
 *
 * Cost: none. The count is one more field on the checkout the store already
 * opens on the creator's own Stripe account; no read, write, email or supplier
 * is added, and a member billed every 3 months makes fewer charges, not more.
 */
import type { Interval } from "@/lib/product-recurring";

/** The counts a creator may choose for each interval; 1 is the interval itself. */
export const EVERY_CHOICES: Readonly<Record<Interval, readonly number[]>> = {
  day: [1],
  week: [1, 2],
  month: [1, 2, 3, 6],
  year: [1],
};

/**
 * Stripe's ceiling for one subscription interval (three years), as a count of each interval, as the source below
 * states it (3 years, 36 months or 156 weeks). Stripe states no count of days: a day is held to 1, the only choice.
 */
export const STRIPE_MAX_EVERY: Readonly<Record<Interval, number>> = { day: 1, week: 156, month: 36, year: 3 };

/** Whether `count` is one of the choices for `interval`. */
export function isEvery(interval: Interval, count: unknown): count is number {
  return typeof count === "number" && EVERY_CHOICES[interval].includes(count);
}

/**
 * A count as the editor sent it: empty, 0 or absent is 1 (the interval
 * itself); a choice is kept; anything else is "every", for the editor to say
 * which counts there are. A typed "3" is read as 3; "3.5", "4" or "-3" never.
 */
export function readEvery(interval: Interval, raw: unknown): number | "every" {
  if (raw === undefined || raw === null || raw === "" || raw === 0 || raw === "0") return 1;
  const n = typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return isEvery(interval, n) ? n : "every";
}

/** A count as kept: one that is not a choice for the interval (or missing, from before WP8) is 1. */
export function parseEvery(interval: Interval, raw: unknown): number {
  return isEvery(interval, raw) ? raw : 1;
}

const SINGULAR: Record<Interval, string> = { day: "day", week: "week", month: "month", year: "year" };

/** "a month", "every 2 weeks", "every 3 months": how the interval is read aloud on the page. */
export function everyWords(interval: Interval, count: number): string {
  const n = parseEvery(interval, count);
  return n === 1 ? `a ${SINGULAR[interval]}` : `every ${n} ${SINGULAR[interval]}s`;
}

/** "Monthly", "Every 2 weeks", "Every 3 months": the interval as a name, for a choice in a list. */
export function everyName(interval: Interval, count: number): string {
  const n = parseEvery(interval, count);
  if (n === 1) return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[interval];
  return `Every ${n} ${SINGULAR[interval]}s`;
}

/**
 * The whole price line of a membership on its schedule: "$90 every 3 months",
 * "7-day free trial, then $90 every 3 months", "4 payments of $90, one every 3
 * months". With a count of 1 it is word for word what lib/product-recurring.ts
 * membershipPrice says today, so nothing already on sale reads differently.
 */
export function everyPriceLine(input: { interval: Interval; count: number; trialDays: number; payments: number }, price: string): string {
  const n = parseEvery(input.interval, input.count);
  const trial = input.trialDays > 0 ? `${input.trialDays}-day free trial, then ` : "";
  if (input.payments > 0) {
    if (n === 1) {
      const adjective = { day: "daily", week: "weekly", month: "monthly", year: "yearly" }[input.interval];
      return `${trial}${input.payments} ${adjective} payments of ${price}`;
    }
    return `${trial}${input.payments} payments of ${price}, one ${everyWords(input.interval, n)}`;
  }
  return `${trial}${price} ${everyWords(input.interval, n)}`;
}

/**
 * The fields of a recurring price Stripe is sent, under `prefix` (for a
 * checkout, "line_items[0][price_data][recurring]"): the interval, and the
 * count only when it is not 1, so a checkout for a weekly or monthly
 * membership is exactly the one sent today. A count that is not a choice is
 * never sent: it throws, rather than bill on a schedule the page did not say.
 */
export function stripeEveryFields(prefix: string, interval: Interval, count: number): [string, string][] {
  if (!isEvery(interval, count)) throw new Error(`not a billing interval a membership may have: every ${String(count)} ${interval}`);
  if (count > STRIPE_MAX_EVERY[interval]) throw new Error("past Stripe's three-year ceiling for one billing interval");
  const fields: [string, string][] = [[`${prefix}[interval]`, interval]];
  if (count > 1) fields.push([`${prefix}[interval_count]`, String(count)]);
  return fields;
}

/** What a membership billed every N cannot go with yet, each said to the creator by its reason. */
export type EveryProblem = "intro" | "yearly" | "pause" | "tiers";

/**
 * Why a count above 1 cannot go on this membership, or null when it can.
 * Each of these is counted in single weeks or months today, so it would charge
 * or pause on a schedule the page does not say.
 */
export function everyProblem(count: number, product: { intro?: unknown; yearly?: unknown; pauseOn?: boolean; inTiers?: boolean }): EveryProblem | null {
  if (count <= 1) return null;
  if (product.intro) return "intro";
  if (product.yearly) return "yearly";
  if (product.pauseOn) return "pause";
  if (product.inTiers) return "tiers";
  return null;
}

/** What the editor says for each refusal, in plain words. */
export const EVERY_PROBLEM_WORDS: Readonly<Record<EveryProblem | "every", string>> = {
  every: "Choose how often it charges from the list: every 1 or 2 weeks, or every 1, 2, 3 or 6 months.",
  intro: "An introductory price works only on a membership that charges every week or every month. Remove it, or charge every month.",
  yearly: "A yearly option works only on a membership that charges every month. Remove it, or charge every month.",
  pause: "Members can pause only a membership that charges every month. Turn off pausing, or charge every month.",
  tiers: "Switching plans works only between memberships that charge every week or every month. Take it out of the plans, or charge every month.",
};
