/**
 * The buyer's own currency at checkout (22 [E5] unit 3a; added 15 November
 * 2026; design and Stripe's answers in docs/buyer-currency-and-language.md).
 *
 * The owner's decision of 14 November 2026, 22h (Fortaleza): a creator's
 * buyers may pay in their own currency, in one of two ways the creator
 * chooses between.
 *
 *   (a) automatic, the default: Stripe's Adaptive Pricing converts the price,
 *       and the buyer pays the conversion charge (2–4%, inside the converted
 *       price; "Neither you nor your connected accounts directly pay any
 *       additional Stripe fees for Adaptive Pricing", Stripe's Connect page,
 *       read on 15 November 2026). The creator does nothing.
 *   (b) manual, an option: the creator's own price per currency, in a Price's
 *       `currency_options` (lib/currency-prices.ts). Stripe uses it before the
 *       automatic one in that currency ("Manually defined multi-currency
 *       prices override Adaptive Pricing for those currencies, even if it's
 *       enabled").
 *
 * Everything here is off: BUYER_CURRENCY_LIVE is false, so every checkout
 * keeps `adaptive_pricing[enabled]=false` (inTheCurrencyShown,
 * lib/instant-pay.ts) and charges in the store's currency, as before. It is
 * turned on only after the test-mode proofs listed in the design, and after
 * the account read below has its cache and request units; never to make a
 * test pass.
 *
 * What decides one session (buyerCurrencyPlan), in this order:
 *
 *   - the key off: the store's currency;
 *   - the creator's choice unknown: the store's currency (unknown is never
 *     room);
 *   - any application fee on the session (the commission, lib/platform-share.ts,
 *     off while COMMISSION_LIVE is false): the store's currency. Stripe says a
 *     manual price does not localize with `application_fee_amount`, and says
 *     nothing of Adaptive Pricing with a fee or of the fee's currency then, so
 *     the session is not left to Stripe's silent fallback and the platform
 *     takes no exchange it cannot see;
 *   - the store's currency not known to be the creator's account's settlement
 *     currency: the store's currency ("Adaptive Pricing requires your
 *     integration currency to be the settlement currency of the merchant of
 *     record on the charge"; on a direct charge that is the creator's
 *     account);
 *   - otherwise Adaptive Pricing on, and, for (b), the creator's own prices
 *     before it in their currencies, unless the session uses manual tax rates
 *     (Stripe: no price localization with manual tax rates).
 *
 * The buyer always meets the currency and the final amount before paying, on
 * Stripe's page. Nothing here converts an amount, and no report reads it.
 */
import { onAccount } from "@/lib/stripe-account";
import type { Store } from "@/lib/store";

/** Off until the test-mode proofs in docs/buyer-currency-and-language.md. */
export const BUYER_CURRENCY_LIVE: boolean = false;

/** The creator's two ways, (a) and (b). */
export type BuyerCurrencyMode = "automatic" | "manual";

/** What a store does when its creator chose nothing: (a). */
export const DEFAULT_BUYER_CURRENCY_MODE: BuyerCurrencyMode = "automatic";

export type BuyerCurrencyWhy = "off" | "mode-unknown" | "fee" | "settlement" | "automatic" | "manual" | "manual-none";

/** What one session does: Stripe's conversion on or off, and whether the creator's own prices go on it. */
export type BuyerCurrencyPlan = { adaptive: boolean; manual: boolean; why: BuyerCurrencyWhy };

const STORE_CURRENCY = (why: BuyerCurrencyWhy): BuyerCurrencyPlan => ({ adaptive: false, manual: false, why });

/**
 * The plan for one session. `fee` is whether the session carries any
 * application fee (hasApplicationFee), `settles` whether the store's
 * currency is known to be the account's settlement currency (null when
 * unknown), `manualPrices` whether every line has the creator's own amount
 * in at least one other currency (lib/currency-prices.ts sessionCurrencies),
 * and `taxRates` whether the session uses manual tax rates. Pure.
 */
export function buyerCurrencyPlan(input: {
  live: boolean;
  mode: BuyerCurrencyMode | "unknown";
  fee: boolean;
  settles: boolean | null;
  manualPrices: boolean;
  taxRates: boolean;
}): BuyerCurrencyPlan {
  if (!input.live) return STORE_CURRENCY("off");
  if (input.mode !== "automatic" && input.mode !== "manual") return STORE_CURRENCY("mode-unknown");
  if (input.fee) return STORE_CURRENCY("fee");
  if (input.settles !== true) return STORE_CURRENCY("settlement");
  if (input.mode === "automatic") return { adaptive: true, manual: false, why: "automatic" };
  return input.manualPrices && !input.taxRates ? { adaptive: true, manual: true, why: "manual" } : { adaptive: true, manual: false, why: "manual-none" };
}

/** Every field by which a session or a payment can carry an application fee, or an amount kept back by the platform. */
export const FEE_FIELDS = [
  "payment_intent_data[application_fee_amount]",
  "payment_intent_data[transfer_data][amount]",
  "subscription_data[application_fee_percent]",
  "subscription_data[application_fee_amount]",
  "application_fee_amount",
  "application_fee_percent",
] as const;

/** Whether the session being made carries any application fee (set by applyShare, lib/platform-share.ts). Pure. */
export function hasApplicationFee(body: URLSearchParams): boolean {
  return FEE_FIELDS.some((field) => body.has(field));
}

/** Whether the session uses manual tax rates on any line or for the whole session. Pure. */
export function hasTaxRates(body: URLSearchParams): boolean {
  return [...body.keys()].some((key) => /(^|\[)(dynamic_|default_)?tax_rates(\]\[|\[)/.test(key));
}

/**
 * Writes the plan on the session: Adaptive Pricing on only when the plan
 * says so, and off otherwise, whatever was written before. Called after
 * inTheCurrencyShown and after the share is set, so it judges the session
 * as it will be sent.
 */
export function applyBuyerCurrency(body: URLSearchParams, plan: BuyerCurrencyPlan): void {
  body.set("adaptive_pricing[enabled]", plan.adaptive ? "true" : "false");
}

/**
 * Whether the store's currency is the creator's account's settlement
 * currency, read from the account's `default_currency` (the currency its
 * balance settles in). False when it is another, null when the account
 * cannot be read or says nothing. Asked only while BUYER_CURRENCY_LIVE is
 * true; before that key turns on, this read gets its cache and its request
 * units (docs/buyer-currency-and-language.md, unit 3b).
 */
export async function settlesInStoreCurrency(store: Pick<Store, "stripeAccountId" | "currency">): Promise<boolean | null> {
  if (!store.stripeAccountId) return null;
  try {
    const account = (await onAccount("GET", store.stripeAccountId, "/account")) as { default_currency?: unknown };
    const settles = typeof account.default_currency === "string" ? account.default_currency.toLowerCase() : "";
    if (!/^[a-z]{3}$/.test(settles)) return null;
    return settles === store.currency;
  } catch (error) {
    console.error("reading the account's settlement currency failed", error);
    return null;
  }
}
