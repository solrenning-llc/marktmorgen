/**
 * A creator's own amount in other currencies, for one amount a product
 * carries (22 [E5], unit 1; added 2 November 2026; design in
 * docs/buyer-currency-and-language.md). Rules only: nothing writes, reads or
 * shows these yet, and no checkout uses them, so nothing pretends to work.
 *
 * What Stripe asks (Manual currency prices, read on 1 November 2026): a
 * Price may carry other currencies in `currency_options`, each with the
 * seller's own amount; Checkout picks one by the buyer's location only when
 * every line, shipping rate and discount of the session has that currency,
 * and otherwise charges the default one. It is not available with manual tax
 * rates or `payment_intent_data.application_fee_amount`. So a currency is
 * offered to a buyer only when every amount of the session holds it
 * (localizableIn), never converted, never guessed: an amount missing in a
 * currency means that currency is not offered, and the store's own is
 * charged, as today. Zero is the one amount that is the same in every
 * currency (free shipping, a free option), so it needs no entry.
 *
 * Each amount is held to the range the store already holds it to in its own
 * currency (lib/money.ts: priceInRange for a price, an intro price or an
 * amount off; at least minCharge for a charge on its own), and only to
 * currencies the creator's Stripe account is known to take; while that is
 * not known, none is taken (unknown is never room). The store's own
 * currency is the amount itself, so it is never repeated here.
 *
 * Two things stay unknown until proven in Stripe's test mode on a connected
 * account, before any checkout uses this (docs/buyer-currency-and-language.md,
 * unit 1): whether Checkout localizes by `currency_options` while Adaptive
 * Pricing is switched off, and whether it does on a direct charge on the
 * creator's account. Until then nothing reads this module.
 *
 * What it costs today: no Stripe request, no Redis key and no byte, since
 * nothing writes it. Once written (unit 3), each amount adds at most
 * currencyPricesMaxBytes() bytes to the product's record, inside the store's
 * data room; each localized Price is one Stripe request on the creator's
 * account and one Redis key, as pay what you want's prices already are
 * (lib/pay-what-you-want.ts), made only when its shape changes.
 *
 * Pure and browser-safe.
 */
import { CURRENCIES, type Currency, currencyRule, isCurrency, priceInRange } from "@/lib/money";

/** The creator's amount in each other currency, in that currency's smallest unit. */
export type CurrencyPrices = Partial<Record<Currency, number>>;

/**
 * What an amount is, by the range the store already holds it to in its own
 * currency: a price (priceInRange: a product, an option, an intro price, a
 * year, a package, a suggestion), an amount off (a fixed discount code,
 * priceInRange as its route checks it), or a charge on its own (at least
 * minCharge: a payment of a plan, a checkout box, an offer after paying, a
 * shipping rate when not free).
 */
export type AmountKind = "price" | "off" | "charge";

/**
 * Every amount a localized session would need in the buyer's currency (the
 * design's list). `onProduct` is false for what lives elsewhere: a discount
 * code is a coupon on the creator's Stripe account (lib/discount.ts), whose
 * `currency_options` carry `amount_off` and its minimum order. Pay what you
 * want's minimum is the product's own price (lib/pay-what-you-want.ts), so it
 * is not a second amount. An intro price is charged as a coupon of the
 * difference (lib/intro-coupon.ts), so it must stay below the price in each
 * currency too.
 */
export const AMOUNTS_WITH_CURRENCY_PRICES = [
  { where: "product price (also pay what you want's minimum)", kind: "price", onProduct: true },
  { where: "price option", kind: "price", onProduct: true },
  { where: "payment plan, each payment", kind: "charge", onProduct: true },
  { where: "checkout box (order bump)", kind: "charge", onProduct: true },
  { where: "offer after paying", kind: "charge", onProduct: true },
  { where: "intro price", kind: "price", onProduct: true },
  { where: "shipping rate", kind: "charge", onProduct: true },
  { where: "yearly price", kind: "price", onProduct: true },
  { where: "call package", kind: "price", onProduct: true },
  { where: "pay what you want, suggestion", kind: "price", onProduct: true },
  { where: "fixed-amount discount code", kind: "off", onProduct: false },
  { where: "discount code, minimum order", kind: "price", onProduct: false },
] as const satisfies readonly { where: string; kind: AmountKind; onProduct: boolean }[];

/** At most every other listed currency: one amount for each. */
export const MAX_CURRENCY_PRICES = CURRENCIES.length - 1;

export type CurrencyPricesRefusal =
  | { ok: false; why: "shape" }
  | { ok: false; why: "unknown-currency"; currency: string }
  | { ok: false; why: "own-currency" }
  | { ok: false; why: "not-offered"; currency: Currency }
  | { ok: false; why: "range"; currency: Currency }
  | { ok: false; why: "account-unknown" };

/**
 * Reads what a form or a record holds into a CurrencyPrices, or says why it
 * cannot be kept. Checked in this order: the shape, then every currency and
 * amount, then the account. `offered` is the currencies the creator's Stripe
 * account is known to take; null while that is not known, which refuses any
 * amount (an empty map is always fine: nothing to localize).
 */
export function parseCurrencyPrices(raw: unknown, own: Currency, kind: AmountKind, offered: readonly Currency[] | null): { ok: true; prices: CurrencyPrices } | CurrencyPricesRefusal {
  if (raw === undefined || raw === null) return { ok: true, prices: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "shape" };
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return { ok: false, why: "shape" };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: true, prices: {} };
  if (entries.length > MAX_CURRENCY_PRICES) return { ok: false, why: "shape" };
  const prices: CurrencyPrices = {};
  for (const [code, amount] of entries) {
    if (!isCurrency(code)) return { ok: false, why: "unknown-currency", currency: code };
    if (code === own) return { ok: false, why: "own-currency" };
    if (typeof amount !== "number" || !amountFits(amount, code, kind)) return { ok: false, why: "range", currency: code };
    prices[code] = amount;
  }
  if (offered === null) return { ok: false, why: "account-unknown" };
  const missing = (Object.keys(prices) as Currency[]).find((code) => !offered.includes(code));
  if (missing) return { ok: false, why: "not-offered", currency: missing };
  return { ok: true, prices };
}

/** Whether an amount may stand in this currency, held to the range its kind has in the store's own. */
export function amountFits(amount: number, currency: Currency, kind: AmountKind): boolean {
  if (!Number.isSafeInteger(amount)) return false;
  if (kind === "price" || kind === "off") return priceInRange(amount, currency);
  const rule = currencyRule(currency);
  return amount >= rule.minCharge && amount <= rule.maxPrice;
}

/** The creator's amount in a currency: the amount itself in the store's own, zero for zero, the one kept for another, or null when there is none (never converted). */
export function amountIn(amount: number, own: Currency, prices: CurrencyPrices | undefined, currency: Currency): number | null {
  if (currency === own || amount === 0) return amount;
  const other = prices?.[currency];
  return typeof other === "number" ? other : null;
}

/**
 * Whether a session whose every amount is listed may be offered in this
 * currency: only when each one has the creator's own amount in it, as
 * Stripe asks. With no amounts there is nothing to charge, so no.
 */
export function localizableIn(amounts: readonly { amount: number; prices?: CurrencyPrices }[], own: Currency, currency: Currency): boolean {
  return amounts.length > 0 && amounts.every((a) => amountIn(a.amount, own, a.prices, currency) !== null);
}

/** The currencies a session may be offered in besides the store's own, in the list's order. */
export function sessionCurrencies(amounts: readonly { amount: number; prices?: CurrencyPrices }[], own: Currency): Currency[] {
  return CURRENCIES.map((rule) => rule.code).filter((code) => code !== own && localizableIn(amounts, own, code));
}

/**
 * What Stripe's `currency_options` would carry for one fixed-amount Price:
 * every other currency with the creator's own amount and its tax setting,
 * which Stripe Tax needs set per currency. Only for a fixed-amount Price: pay
 * what you want's Price carries `custom_unit_amount`, a shipping rate
 * `fixed_amount.currency_options.<currency>.amount` and a coupon
 * `amount_off`, each built in its own unit. Not sent anywhere yet.
 */
export function fixedPriceCurrencyOptions(prices: CurrencyPrices, taxBehavior: "exclusive" | "inclusive"): Record<string, { unit_amount: number; tax_behavior: "exclusive" | "inclusive" }> {
  const out: Record<string, { unit_amount: number; tax_behavior: "exclusive" | "inclusive" }> = {};
  for (const rule of CURRENCIES) {
    const amount = prices[rule.code];
    if (typeof amount === "number") out[rule.code] = { unit_amount: amount, tax_behavior: taxBehavior };
  }
  return out;
}

/** The most bytes one amount's currencyPrices adds to a record, written as JSON: every currency but the store's own at its dearest amount, for the store's currency that leaves the most. */
export function currencyPricesMaxBytes(): number {
  return Math.max(...CURRENCIES.map((own) => {
    const all: Record<string, number> = {};
    for (const rule of CURRENCIES) if (rule.code !== own.code) all[rule.code] = rule.maxPrice;
    return `,"currencyPrices":${JSON.stringify(all)}`.length;
  }));
}
