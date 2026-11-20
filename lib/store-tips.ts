/**
 * "Support my work": a visitor gives the creator an amount of their own
 * choosing, with nothing bought and nothing to deliver (added 9 October 2026).
 *
 * What Ko-fi and Buy Me a Coffee are built on, and what Linktree and Beacons
 * sell as a tip jar: a fan who has nothing they need to buy today still wants
 * to say thank you, and a box with three amounts and one button lets them.
 *
 * The rules, browser-safe: what the creator keeps on the store's record and
 * which amounts a visitor may give. The payment itself is one Stripe checkout
 * on the creator's own account (lib/store-tip-checkout.ts), like every sale
 * here, so the money is theirs from the first second and none of it is ours.
 *
 * What it is not: a product. Nothing is handed over for it, so it earns no
 * affiliate or partner share, takes no discount code and no sales tax, and is
 * never "refunded" by taking anything back. It is listed with the store's
 * sales as "Support", with whatever message the visitor left.
 */
import { type Currency, currencyRule, readMoney } from "@/lib/money";
import { SHIP_COUNTRIES } from "@/lib/shipping";

export type StoreTips = {
  on: boolean;
  /** The creator's own heading; "" for the store language's (lib/buyer-words/tips.ts). */
  heading: string;
  /** The creator's own line under it; "" for the store language's. */
  line: string;
  /** The amounts offered as buttons, in the store currency's smallest unit; [] for the usual three. */
  amounts: number[];
};

export const MAX_TIPS_HEADING = 60;
export const MAX_TIPS_LINE = 160;
export const MAX_TIP_AMOUNTS = 3;
/** What a visitor may write to the creator on Stripe's page, which allows no more than 255. */
export const MAX_TIP_MESSAGE = 255;

export const NO_TIPS: StoreTips = { on: false, heading: "", line: "", amounts: [] };

/**
 * The least and the most one gift may be. The least is the smallest price a
 * product may have in that currency (lib/money.ts), comfortably above what
 * Stripe will charge at all; the most is a tenth of the dearest price, which
 * is far beyond any thank-you and short of what makes a stolen card worth
 * trying here.
 */
export function tipBounds(currency: Currency): { min: number; max: number } {
  const rule = currencyRule(currency);
  return { min: rule.minPrice, max: Math.floor(rule.maxPrice / 10) };
}

export function tipInRange(amount: number, currency: Currency): boolean {
  const { min, max } = tipBounds(currency);
  return Number.isSafeInteger(amount) && amount >= min && amount <= max;
}

/** The three amounts every store offers until its creator chooses: three, five and ten times the least. */
export function usualTipAmounts(currency: Currency): number[] {
  const { min } = tipBounds(currency);
  return [3 * min, 5 * min, 10 * min];
}

/**
 * The amounts the box offers now: the creator's, those still in range for the
 * store's currency (it may have changed since they were chosen), in rising
 * order — or the usual three when none are left.
 */
export function tipAmounts(tips: StoreTips, currency: Currency): number[] {
  const kept = [...new Set(tips.amounts.filter((amount) => tipInRange(amount, currency)))].sort((a, b) => a - b);
  return kept.length ? kept.slice(0, MAX_TIP_AMOUNTS) : usualTipAmounts(currency);
}

/**
 * An amount a visitor typed: "5", "5.50", or "5,50" as most of Europe writes
 * it. Null when it is not one plain amount, or is outside the bounds.
 */
export function readTipAmount(raw: string, currency: Currency): number | null {
  const text = (raw ?? "").trim().replace(/^(\d+),(\d{1,2})$/, "$1.$2");
  const amount = readMoney(text, currency);
  return amount !== null && tipInRange(amount, currency) ? amount : null;
}

/** Whatever came back from storage, made safe to use. */
export function parseTips(raw: unknown): StoreTips {
  if (!raw || typeof raw !== "object") return { ...NO_TIPS };
  const value = raw as Record<string, unknown>;
  const words = (input: unknown, max: number) => (typeof input === "string" ? input.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const amounts = Array.isArray(value.amounts)
    ? value.amounts.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0).slice(0, MAX_TIP_AMOUNTS)
    : [];
  return { on: value.on === true, heading: words(value.heading, MAX_TIPS_HEADING), line: words(value.line, MAX_TIPS_LINE), amounts };
}

/** What the support box puts back after a notice (WCAG 3.3.7): the amount chosen, the amount typed and the country. */
export type TipKept = { chose: string; other: string; from: string };

const KEPT_COUNTRIES: ReadonlySet<string> = new Set(SHIP_COUNTRIES);
const KEPT_TYPED = /^\d{1,7}(?:[.,]\d{1,2})?$/;

/**
 * Only what the box itself offers, so nothing else is ever drawn back (app/api/store/tip sends it, the store page reads
 * it): one of the store's amounts or "other", a plain typed amount, and a country the billing field lists (a two-letter
 * code, nothing more about the person). Anything else, a list or nothing is dropped.
 */
export function tipKept(store: { tips: StoreTips; currency: Currency }, given: { chose?: unknown; other?: unknown; from?: unknown }): TipKept {
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 20).trim() : "");
  const chose = text(given.chose);
  const other = text(given.other);
  const from = text(given.from).toUpperCase();
  return {
    chose: chose === "other" || tipAmounts(store.tips, store.currency).map(String).includes(chose) ? chose : "",
    other: KEPT_TYPED.test(other) ? other : "",
    from: KEPT_COUNTRIES.has(from) ? from : "",
  };
}
