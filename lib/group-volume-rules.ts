/**
 * Less per place when a team buys more of them (624 [SZ8](48), unit 1; owner's
 * Shopify audit of 1 November 2026): the rules, pure and browser-safe.
 *
 * A product bought for several people at once (lib/group-rules.ts) may say,
 * for example, "10% off each place from 10 people, 20% off from 25". The buyer
 * sees it before paying, and the checkout charges exactly that. Nothing here
 * is wired yet: the product's setting, the studio, the box on the page and the
 * checkout come in the next units, and they will all read this file, so the
 * page and the charge can never disagree.
 *
 * What it holds to:
 *
 *   - At most MAX_TIERS tiers, each "from N people, P% off": N from
 *     MIN_TIER_PEOPLE to MAX_PEOPLE, P a whole percent from MIN_TIER_PERCENT
 *     to MAX_TIER_PERCENT. Tiers go up in both: more people never pay more per
 *     place. Anything else is refused with its reason, never rounded or
 *     reordered into something the creator did not type.
 *   - The tier that applies is the highest one the number of people reaches;
 *     below the first, the price is the product's own.
 *   - One place's price is the product's price less the percent, rounded to
 *     the cent as a store-wide sale rounds it (lib/store-sale.ts salePrice),
 *     and never below the least the currency may charge; the total is that
 *     times the people, and is refused past what one payment may be.
 *   - It is never added to a store-wide sale: the buyer gets whichever of the
 *     two takes more off, said as that one.
 *
 * Cost: none. It changes the amount of the one checkout a purchase for a team
 * already opens on the creator's own Stripe account; no read, write, email or
 * supplier is added. The discount is the creator's own, on their own sale, and
 * never touches what Marktmorgen charges the creator.
 */
import { MAX_PEOPLE, MIN_PEOPLE, payable } from "@/lib/group-rules";

/** The most tiers one product may have. */
export const MAX_TIERS = 3;
/** The fewest people a tier may start from: two is just a purchase for several, at the product's price. */
export const MIN_TIER_PEOPLE = MIN_PEOPLE + 1;
/** The least and most a tier may take off each place, in whole percent. */
export const MIN_TIER_PERCENT = 1;
export const MAX_TIER_PERCENT = 75;

/** "From `from` people, `percent`% off each place." */
export type VolumeTier = { from: number; percent: number };

export type VolumeProblem = "tiers" | "from" | "percent" | "order";

const whole = (raw: unknown): number | null => {
  const n = typeof raw === "string" && /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
};

/**
 * The tiers as the studio sends them: a list of { from, percent }, typed or as
 * numbers. Empty is none. Refused, with its reason, when there are too many,
 * a number is outside its range or not whole, or a tier does not start at
 * more people and take more off than the one before it.
 */
export function readVolumeTiers(raw: unknown): VolumeTier[] | VolumeProblem {
  if (raw === undefined || raw === null || raw === "") return [];
  if (!Array.isArray(raw) || raw.length > MAX_TIERS) return "tiers";
  const tiers: VolumeTier[] = [];
  for (const one of raw) {
    const row = one && typeof one === "object" ? (one as Record<string, unknown>) : {};
    const from = whole(row.from);
    const percent = whole(row.percent);
    if (from === null || from < MIN_TIER_PEOPLE || from > MAX_PEOPLE) return "from";
    if (percent === null || percent < MIN_TIER_PERCENT || percent > MAX_TIER_PERCENT) return "percent";
    const last = tiers.at(-1);
    if (last && (from <= last.from || percent <= last.percent)) return "order";
    tiers.push({ from, percent });
  }
  return tiers;
}

/** Tiers as kept: anything that would not be read from the studio today is none, never a guess. */
export function parseVolumeTiers(raw: unknown): VolumeTier[] {
  const read = readVolumeTiers(raw);
  return Array.isArray(read) ? read : [];
}

/** The tier this many people reach, the highest one; null below the first. */
export function tierFor(tiers: readonly VolumeTier[], people: number): VolumeTier | null {
  let reached: VolumeTier | null = null;
  for (const tier of tiers) if (people >= tier.from) reached = tier;
  return reached;
}

/** One place's price less `percent`, rounded as a store-wide sale rounds it (lib/store-sale.ts salePrice). */
function less(cents: number, percent: number): number {
  return percent <= 0 ? cents : cents - Math.round((cents * percent) / 100);
}

export type TeamPrice = {
  /** One place, after what comes off. */
  eachCents: number;
  /** Every place together: what the one payment charges. */
  totalCents: number;
  /** What came off each place, and why: the team's tier, the store's sale, or nothing. */
  percent: number;
  by: "tier" | "sale" | "none";
};

/**
 * What a team of `people` pays: the product's price, less the better of its
 * tier and the store's sale (`salePercent`, 0 for none), never both. Null when
 * it cannot be charged: fewer than two people, a place below `minCents` (the
 * least the currency may charge), or a total past what one payment may be.
 */
export function teamPrice(priceCents: number, people: number, tiers: readonly VolumeTier[], salePercent = 0, minCents = 1): TeamPrice | null {
  if (!Number.isInteger(people) || people < MIN_PEOPLE || people > MAX_PEOPLE || !(priceCents > 0)) return null;
  const tier = tierFor(tiers, people)?.percent ?? 0;
  const sale = salePercent > 0 ? salePercent : 0;
  const by = tier === 0 && sale === 0 ? "none" : tier >= sale ? "tier" : "sale";
  const percent = by === "tier" ? tier : by === "sale" ? sale : 0;
  const eachCents = less(priceCents, percent);
  if (eachCents < minCents || !payable(eachCents, people)) return null;
  return { eachCents, totalCents: eachCents * people, percent, by };
}

/** "10% off each place from 10 people, 20% off from 25", in the studio's plain English; "" for none. */
export function tiersLine(tiers: readonly VolumeTier[]): string {
  return tiers
    .map((tier, at) => (at === 0 ? `${tier.percent}% off each place from ${tier.from} people` : `${tier.percent}% off from ${tier.from}`))
    .join(", ");
}

/** What the studio says for each refusal, in plain words. */
export const VOLUME_PROBLEM_WORDS: Readonly<Record<VolumeProblem, string>> = {
  tiers: `Add up to ${MAX_TIERS} steps.`,
  from: `Each step starts at ${MIN_TIER_PEOPLE} to ${MAX_PEOPLE} people, as a whole number.`,
  percent: `Each step takes ${MIN_TIER_PERCENT}% to ${MAX_TIER_PERCENT}% off each place, as a whole number.`,
  order: "Each step needs more people and more off than the one before it.",
};
