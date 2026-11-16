/**
 * An introductory price for a membership (added 10 October 2026): "$5 the
 * first month, then $20 a month", or "$5 a month for the first 3 months,
 * then $20 a month". The rules, which the browser can read too; the coupon
 * that takes it off at checkout is made in lib/intro-coupon.ts.
 *
 * What keeps it honest and simple:
 *
 *   - It is said before anybody pays, everywhere the membership's price is
 *     said: the product's facts, its button, the line under the button, the
 *     course page, the renewal page and the reminder after an unpaid checkout.
 *     Stripe's own page shows the discount line too.
 *   - It is a price, not a percentage: the creator types what the first
 *     payments cost, always less than the regular price and never below what
 *     Stripe will charge. The regular price is what the member pays after.
 *   - One offer at a time. Not beside a yearly price (lib/yearly-price.ts), nor a free trial (a trial is the creator's
 *     other way to start a member off), not on a membership with a set number
 *     of payments or with several prices, and not on plans members switch
 *     between, where a fixed amount off could follow them to a cheaper plan.
 *   - Taken off by Stripe with a coupon on the creator's own account, for the
 *     first payment, or the first months of a monthly membership, so the
 *     regular price begins by itself.
 *   - A come-back offer (lib/winback.ts) replaces it: one discount at a time.
 */
import type { Interval } from "@/lib/product-recurring";

export type Intro = {
  /** What each of the first payments costs, in the store currency's smallest unit. */
  cents: number;
  /** How many payments cost that: 1, or up to MAX_INTRO_COUNT on a monthly membership. */
  count: number;
};

/** The most months a monthly membership's introductory price may last. */
export const MAX_INTRO_COUNT = 12;

/** Whatever came back from storage or from the studio, made safe to use; null is none. */
export function parseIntro(raw: unknown): Intro | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const cents = Number(value.cents);
  const count = Number(value.count);
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  if (!Number.isInteger(count) || count < 1 || count > MAX_INTRO_COUNT) return null;
  return { cents, count };
}

/** The facts about a product that decide whether it can have an introductory price. */
export type IntroCandidate = {
  id: string;
  priceCents: number;
  recurring: { interval: Interval; trialDays: number; payments: number; every?: number } | null;
  options: unknown[];
  pwyw: unknown;
  /** A yearly price beside the monthly one (lib/yearly-price.ts): one offer at a time. */
  yearly?: unknown;
};

export type IntroProblem = "membership" | "trial" | "payments" | "options" | "pwyw" | "tiers" | "yearly" | "price" | "count";

/**
 * Why this introductory price cannot go on this product, or null when it can.
 * `minCents` is the least the store's currency may charge (lib/money.ts);
 * `tiers` are the plans members switch between (lib/tier-switch.ts).
 */
export function introProblem(product: IntroCandidate, intro: Intro, minCents: number, tiers: readonly string[] = []): IntroProblem | null {
  const recurring = product.recurring;
  if (!recurring || product.priceCents <= 0) return "membership";
  if (recurring.trialDays > 0) return "trial";
  if (recurring.payments > 0) return "payments";
  if (product.options.length > 0) return "options";
  if (product.pwyw) return "pwyw";
  if (tiers.includes(product.id)) return "tiers";
  if (product.yearly) return "yearly";
  if (intro.cents < minCents || intro.cents >= product.priceCents) return "price";
  // Counted in single weeks or months, so never on one charged every few (609 [WP8]).
  if ((recurring.every ?? 1) > 1) return "count";
  if (intro.count < 1 || intro.count > (recurring.interval === "month" ? MAX_INTRO_COUNT : 1)) return "count";
  return null;
}

/**
 * The introductory price a product offers now, or null. Read on every page
 * and checkout, so a product changed after it was set (a trial added, the
 * price lowered below it) simply stops offering it, everywhere at once.
 */
export function activeIntro(product: IntroCandidate & { intro?: Intro | null }, tiers: readonly string[] = []): Intro | null {
  const intro = product.intro ?? null;
  if (!intro) return null;
  return introProblem(product, intro, 1, tiers) ? null : intro;
}

/** The id of the coupon that takes it off: one per currency, amount and length, made once per account. */
export function introCouponId(currency: string, offCents: number, count: number): string {
  return `mm_intro_${currency}_${offCents}_${count}`;
}

/** "$5 the first month, then $20 a month", in American English, for the studio and for answers. */
export function introLineEnglish(intro: string, count: number, interval: Interval, then: string): string {
  const first = count > 1 ? `a month for the first ${count} months` : `the first ${interval}`;
  return `${intro} ${first}, then ${then}`;
}
