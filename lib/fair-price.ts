/**
 * A fair price for each buyer's country: the same product, cheaper where
 * money buys less, so a buyer in India or Brazil pays what a buyer in the
 * United States pays in effort rather than in dollars.
 *
 * Measured before it was built (8 October 2026). Gumroad has it, as
 * "purchasing power parity", and this site's comparison page said so as one
 * of the things Gumroad is ahead on. Kajabi has it only through an outside
 * app (ParityDeals sells one), and neither Stan's nor Hotmart's help pages
 * mention it. Gumroad's code is public (github.com/antiwork/gumroad), and the
 * rules here follow the same sense:
 *
 *   - the price level is the World Bank's (lib/fair-price-data.ts);
 *   - a country whose prices are above 80% of the US level gets nothing off,
 *     and nor does any high-income country on the list below, whatever its
 *     prices: the point is buyers who earn less, not cheap shopping;
 *   - nothing goes below the creator's own floor: they pick the deepest
 *     discount they accept, at most 60% off, as Gumroad's floor of 0.4 is.
 *
 * The creator decides all of it, for their own store only: whether it is on
 * at all (off on every store until they switch it on), whether the World
 * Bank's numbers suggest the discount for every country or only the
 * countries they list get one, and, country by country, how much — a level
 * of their own, from 5% to 90% off, or none at all, which takes a country
 * the numbers would lower off the list. And which products: every one it
 * can cover, or only those they pick, as a sale does — a $9 file can stay at
 * its price while a $199 course is lowered, as Gumroad lets a seller switch
 * it off product by product.
 *
 * Percentages are whole multiples of five, rounded down, so a buyer is never
 * given more off than the numbers say and the creator's Stripe account holds
 * at most eighteen coupons for it, one per level.
 *
 * What it covers is what a sale across the store covers (lib/store-sale.ts,
 * `saleable`): a product bought once at one price the store sets. When both
 * apply, the larger of the two is taken, never both.
 *
 * Said plainly to the creator, because it is true: the country is read from
 * the buyer's internet connection. Somebody using a VPN can be shown another
 * country's price, and the card's country is not checked before paying,
 * because Stripe's own payment page does not let a platform look at the card
 * first. The floor is how the creator limits what that can cost.
 *
 * Browser-safe: the studio shows the same numbers the store charges.
 */
import { PRICE_LEVELS } from "./fair-price-data";
import { type SaleCandidate, saleable } from "./store-sale";

export type FairPricing = {
  on: boolean;
  /**
   * True: every country gets what the World Bank's numbers suggest, up to
   * `maxOff`, except where `levels` says otherwise. False: only the
   * countries in `levels` get anything.
   */
  auto: boolean;
  /** The deepest percentage off the suggestion gives any country. */
  maxOff: number;
  /** The creator's own level for a country, by its two-letter code; 0 is none. */
  levels: Record<string, number>;
  /** Every product it can cover, or only those in `products`. */
  all: boolean;
  products: string[];
};

export const FAIR_MAX_CHOICES = [20, 30, 40, 50, 60] as const;
/** What the creator can set for one country: none, or 5% to 90% off. */
export const FAIR_LEVEL_CHOICES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90] as const;
/** As many countries as there are. */
export const MAX_FAIR_COUNTRIES = 250;
/** As many products as a sale can be limited to (lib/store-sale.ts). */
export const MAX_FAIR_PRODUCTS = 200;
export const DEFAULT_FAIR: FairPricing = { on: false, auto: true, maxOff: 50, levels: {}, all: true, products: [] };

/** Above this price level, nothing is taken off. */
export const FAIR_FROM_LEVEL = 0.8;

/**
 * High-income countries that are never given a lower price, whatever their
 * price level: the same list Gumroad keeps, for the same reason.
 */
export const NEVER_LOWER = new Set([
  "AE", "QA", "KW", "BH", "OM", "SA",
  "SG", "HK", "MO", "BN",
  "JP", "KR", "TW",
  "SE", "NO", "DK", "FI", "IS",
  "CH", "LI", "LU",
  "IE", "NL", "BE", "AT", "DE", "FR",
  "GB",
  "AU", "NZ",
  "US", "CA",
  "IL",
  "IT", "ES", "PT",
]);

export function parseFair(raw: unknown): FairPricing {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_FAIR };
  const value = raw as Record<string, unknown>;
  const maxOff = Number(value.maxOff);
  const levels: Record<string, number> = {};
  if (value.levels && typeof value.levels === "object" && !Array.isArray(value.levels)) {
    for (const [code, raw] of Object.entries(value.levels as Record<string, unknown>)) {
      const percent = Number(raw);
      if (!/^[A-Z]{2}$/.test(code) || !(FAIR_LEVEL_CHOICES as readonly number[]).includes(percent)) continue;
      if (Object.keys(levels).length >= MAX_FAIR_COUNTRIES) break;
      levels[code] = percent;
    }
  }
  return {
    on: value.on === true,
    // A setting saved before countries could be chosen used the suggestion for all of them.
    auto: value.auto !== false,
    maxOff: (FAIR_MAX_CHOICES as readonly number[]).includes(maxOff) ? maxOff : DEFAULT_FAIR.maxOff,
    levels,
    // A setting saved before products could be picked covered every one.
    all: value.all !== false,
    products: Array.isArray(value.products)
      ? [...new Set(value.products.filter((p): p is string => typeof p === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p)))].slice(0, MAX_FAIR_PRODUCTS)
      : [],
  };
}

/** A two-letter country code as a request carries it, or "". */
export function readCountry(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

/** What the World Bank's numbers suggest for a country, capped at `maxOff`. */
export function countryOff(country: string, maxOff: number): number {
  const level = PRICE_LEVELS[country];
  if (!level || NEVER_LOWER.has(country) || level > FAIR_FROM_LEVEL) return 0;
  // In whole percents (the levels have two places), so 1 - 0.55 is 45, never 44.999...
  const off = Math.floor((100 - Math.round(level * 100)) / 5) * 5;
  return Math.max(0, Math.min(off, maxOff, 60));
}

/** The percentage off for a buyer in this country, as the creator set it, before the product is looked at. */
export function storeCountryOff(setting: FairPricing | undefined, country: string): number {
  if (!setting?.on || !country) return 0;
  // The creator's own level for this country wins, whatever the numbers say.
  if (Object.hasOwn(setting.levels, country)) return setting.levels[country];
  return setting.auto ? countryOff(country, setting.maxOff) : 0;
}

/** The percentage off this product for a buyer in this country, or 0. */
export function fairOff(setting: FairPricing | undefined, product: SaleCandidate, country: string): number {
  if (!saleable(product)) return 0;
  if (setting && !setting.all && !setting.products.includes(product.id)) return 0;
  return storeCountryOff(setting, country);
}

/** Every country a creator can set a level for, by name. */
export function allCountries(): string[] {
  return [...new Set([...Object.keys(PRICE_LEVELS), ...NEVER_LOWER])].sort((a, b) => countryName(a).localeCompare(countryName(b)));
}

/** "India", "Brazil": the country's name in English, or its code when the browser has no name for it. */
export function countryName(country: string): string {
  try {
    return new Intl.DisplayNames(["en-US"], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

/** The coupon on the creator's own Stripe account that takes this percentage off. */
export function fairCouponId(percent: number): string {
  return `mm_fair_${percent}`;
}
