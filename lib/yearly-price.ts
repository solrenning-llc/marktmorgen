/**
 * Paying yearly for a monthly membership (added 10 October 2026): the buyer
 * picks "Monthly, $20 a month" or "Yearly, $200 a year, save $40" in the buy
 * box, and the subscription is made at that price and schedule on the
 * creator's own Stripe account. The rules, which the browser can read too.
 *
 * Patreon, Skool and Kajabi offer a yearly price beside the monthly one;
 * creators sell it to keep members for a year at a time. What keeps it
 * honest and simple:
 *
 *   - The saving said is exactly twelve monthly payments less the yearly
 *     price, and a yearly price is only kept below that, so it always saves.
 *   - One membership, one product: whoever pays yearly gets what monthly
 *     members get, and the thank-you page and the confirmation say "a year".
 *   - Only on a monthly membership that runs until canceled, at one price,
 *     outside the plans members switch between, and not beside an
 *     introductory price (one offer at a time; a free trial is fine, before
 *     either). A product changed after it was set stops offering it.
 */
export type Yearly = {
  /** What one year costs, in the store currency's smallest unit. */
  cents: number;
};

export function parseYearly(raw: unknown): Yearly | null {
  if (!raw || typeof raw !== "object") return null;
  const cents = Number((raw as Record<string, unknown>).cents);
  return Number.isSafeInteger(cents) && cents > 0 ? { cents } : null;
}

export type YearlyCandidate = {
  id: string;
  priceCents: number;
  recurring: { interval: string; trialDays: number; payments: number; every?: number } | null;
  options: unknown[];
  pwyw: unknown;
  intro?: unknown;
};

export type YearlyProblem = "membership" | "month" | "payments" | "options" | "pwyw" | "tiers" | "intro" | "price";

/** Why this yearly price cannot go on this product, or null when it can. `minCents` is the least the currency may charge. */
export function yearlyProblem(product: YearlyCandidate, yearly: Yearly, minCents: number, tiers: readonly string[] = []): YearlyProblem | null {
  const recurring = product.recurring;
  if (!recurring || product.priceCents <= 0) return "membership";
  // Twelve monthly payments, so only beside one charged every month, never every few (609 [WP8]).
  if (recurring.interval !== "month" || (recurring.every ?? 1) > 1) return "month";
  if (recurring.payments > 0) return "payments";
  if (product.options.length > 0) return "options";
  if (product.pwyw) return "pwyw";
  if (tiers.includes(product.id)) return "tiers";
  if (product.intro) return "intro";
  if (yearly.cents < minCents || yearly.cents >= product.priceCents * 12) return "price";
  return null;
}

/** The yearly price a product offers now, or null. */
export function activeYearly(product: YearlyCandidate & { yearly?: Yearly | null }, tiers: readonly string[] = []): Yearly | null {
  const yearly = product.yearly ?? null;
  if (!yearly) return null;
  return yearlyProblem(product, yearly, 1, tiers) ? null : yearly;
}

/** What paying yearly saves against twelve monthly payments. */
export function yearlySaving(monthlyCents: number, yearly: Yearly): number {
  return Math.max(0, monthlyCents * 12 - yearly.cents);
}
