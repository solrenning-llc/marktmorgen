/**
 * Member and past-buyer prices (620 [SZ4]): the creator's own rule that
 * "whoever holds membership X (or bought Y) pays Z% less on products A and
 * B", taken off by Stripe on the creator's own account with no code to type.
 *
 * These are the creator's prices for their own products, never Marktmorgen's.
 * Off on every store until its creator switches it on.
 *
 * What a rule covers is what a sale across the store covers
 * (lib/store-sale.ts, `saleable`): a product bought once at one price the
 * store sets. When a sale, a fair price for the buyer's country
 * (lib/fair-price.ts) and a member price all apply, the largest is taken,
 * never two.
 *
 * Who holds what is never decided here: lib/member-price.ts reads it from
 * the creator's Stripe account and the purchases they brought over, for an
 * address proved the way courses are opened, and anything it cannot prove
 * is the normal price.
 *
 * Sizes are capped so the store's record stays small and one check reads at
 * most MAX_MEMBER_QUALIFYING listings: inside the read the next product
 * after a purchase is already counted at (tests/member-price.test.ts).
 *
 * Browser-safe: the studio can show the same numbers the checkout uses.
 */
import { type SaleCandidate, saleable } from "./store-sale";

export type MemberRule = {
  /** The rule's own name in the record, letters, digits, "_" and "-". */
  id: string;
  /** Off each product it covers, one of MEMBER_PERCENT_CHOICES. */
  percent: number;
  /** The products whose holder qualifies: a membership held now, or a one-off bought and kept. */
  by: string[];
  /** Every product it can cover, or only those in `products`. */
  all: boolean;
  products: string[];
};

export type MemberPrices = { on: boolean; rules: MemberRule[] };

/** 5% to 90% off, in steps of five. */
export const MEMBER_PERCENT_CHOICES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90] as const;
export const MAX_MEMBER_RULES = 5;
/** Products one rule can be limited to. */
export const MAX_MEMBER_PRODUCTS = 40;
/** Qualifying products across every rule of the store: what one check reads at most. */
export const MAX_MEMBER_QUALIFYING = 10;
export const NO_MEMBER_PRICES: MemberPrices = { on: false, rules: [] };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const ids = (raw: unknown, max: number): string[] =>
  Array.isArray(raw) ? [...new Set(raw.filter((v): v is string => typeof v === "string" && ID.test(v)))].slice(0, max) : [];

export function isMemberPercent(value: unknown): value is number {
  return (MEMBER_PERCENT_CHOICES as readonly number[]).includes(value as number);
}

export function parseMemberPrices(raw: unknown): MemberPrices {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...NO_MEMBER_PRICES, rules: [] };
  const value = raw as Record<string, unknown>;
  const rules: MemberRule[] = [];
  const seen = new Set<string>();
  const qualifying = new Set<string>();
  for (const item of Array.isArray(value.rules) ? value.rules : []) {
    if (rules.length >= MAX_MEMBER_RULES) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rule = item as Record<string, unknown>;
    const id = typeof rule.id === "string" && ID.test(rule.id) ? rule.id : "";
    const percent = Number(rule.percent);
    if (!id || seen.has(id) || !isMemberPercent(percent)) continue;
    // Qualifying products across the store stay within MAX_MEMBER_QUALIFYING: a product past it is left out of this rule.
    const by: string[] = [];
    for (const p of ids(rule.by, MAX_MEMBER_QUALIFYING)) {
      if (!qualifying.has(p) && qualifying.size >= MAX_MEMBER_QUALIFYING) continue;
      qualifying.add(p);
      by.push(p);
    }
    if (by.length === 0) continue;
    seen.add(id);
    rules.push({ id, percent, by, all: rule.all === true, products: ids(rule.products, MAX_MEMBER_PRODUCTS) });
  }
  return { on: value.on === true && rules.length > 0, rules };
}

/** The rules that cover this product, while the setting is on. */
export function memberRulesFor(setting: MemberPrices | undefined, product: SaleCandidate): MemberRule[] {
  if (!setting?.on || !saleable(product)) return [];
  return setting.rules.filter((rule) => rule.all || rule.products.includes(product.id));
}

/** Every product whose holder would pay less for this one, once each. */
export function qualifyingFor(setting: MemberPrices | undefined, product: SaleCandidate): string[] {
  return [...new Set(memberRulesFor(setting, product).flatMap((rule) => rule.by))];
}

/** The percentage off this product for someone proved to hold `held`: the largest rule they meet, never a sum; 0 for none. */
export function memberOffFrom(setting: MemberPrices | undefined, product: SaleCandidate, held: ReadonlySet<string>): number {
  let best = 0;
  for (const rule of memberRulesFor(setting, product)) {
    if (rule.percent > best && rule.by.some((id) => held.has(id))) best = rule.percent;
  }
  return best;
}

/** The coupon on the creator's own Stripe account that takes this percentage off. */
export function memberCouponId(percent: number): string {
  return `mm_member_${percent}`;
}
