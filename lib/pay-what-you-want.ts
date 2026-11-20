/**
 * Pay what you want: the buyer chooses the price, above a floor the creator
 * sets.
 *
 * The creator's price becomes the minimum, and they add the amount they
 * suggest, which Stripe's checkout shows first in the box the buyer types
 * into. Nothing about the amount is ever read from our own form: Stripe's
 * page takes it, and Stripe refuses anything under the minimum or over the
 * ceiling, so a buyer cannot pay a cent for a $10 floor by editing a page.
 *
 * Stripe only lets a buyer choose the amount of a Price that exists on the
 * account — it cannot be described inline the way every other price here is
 * — so the first checkout creates one on the creator's own account and the
 * id is kept, keyed by everything that shapes it. Changing the title, the
 * floor, the suggestion or the tax setting simply leads to a new one.
 *
 * What it cannot be combined with, and why, is decided here once and read by
 * the studio, the server and the store page alike:
 *
 *   a membership       Stripe lets a buyer choose the amount of a one-off
 *                      payment only, never of a subscription;
 *   price options      the buyer would be choosing twice;
 *   a payment plan     instalments of an amount nobody has chosen yet;
 *   an order bump      the chosen amount has to be the checkout's only line;
 *   a paid call        a call is booked for a time at a set price;
 *   discount codes     not offered: the buyer already names the price.
 *
 * A one-click offer after paying, a limited quantity, sales tax, a course,
 * the questions at checkout and a product the creator ships (514 [PF2], 16
 * November 2026: the shipping is its own line on Stripe's page, not a second
 * line item) all work with it. Stripe's limits for it, read on
 * docs.stripe.com/payments/checkout/pay-what-you-want on 16 November 2026:
 * no other line item and a quantity of 1, no promotion codes or discounts,
 * no recurring payment and no optional items; shipping is not among them.
 */
import type { Listing, Store } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { type Currency, currencyRule } from "@/lib/money";
import { activeShipping } from "@/lib/shipping";

/**
 * Stripe Tax's code for tangible goods, the one the checkout gives a product
 * the creator ships (lib/store-checkout.ts). A choose-your-price line cannot
 * carry it inline, so its Price is made with it (product_data[tax_code],
 * Stripe's API for creating a Price, read on 16 November 2026).
 */
export const GOODS_TAX_CODE = "txcd_99999999";

export type PayWhatYouWant = {
  /** What the buyer's box starts at on Stripe's page, in the currency's smallest unit. */
  suggestedCents: number;
};

/**
 * The ceiling a buyer can type: the same ceiling every other price in the
 * store's currency has ($5,000 for a store in dollars, lib/money.ts).
 */
export function pwywMaximum(currency: Currency): number {
  return currencyRule(currency).maxPrice;
}

/**
 * Whatever came back from storage, made safe to use. The bounds here are the
 * widest any currency allows; the store's own are checked when it is saved.
 */
export function parsePwyw(raw: unknown): PayWhatYouWant | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>).suggestedCents;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 100 || value > 10_000_000) return null;
  return { suggestedCents: value };
}

export type PwywProblem = "free" | "recurring" | "options" | "call" | "plan" | "bump" | "suggested";

/**
 * Why this product cannot be sold at a price the buyer chooses, or null when
 * it can. `suggestedCents` is checked against the product's own price, which
 * is the floor, and the ceiling of the store's currency.
 */
export function pwywProblem(product: Listing, suggestedCents: number, currency: Currency): PwywProblem | null {
  if (product.priceCents === 0) return "free";
  if (product.recurring) return "recurring";
  if (product.options.length > 0) return "options";
  if (product.call) return "call";
  if (product.plan) return "plan";
  if (product.bumps.length) return "bump";
  if (suggestedCents < product.priceCents || suggestedCents > pwywMaximum(currency)) return "suggested";
  return null;
}

/** The choose-your-price setting a buyer meets on this product, or null. */
export function activePwyw(product: Listing): PayWhatYouWant | null {
  const pwyw = product.pwyw;
  if (!pwyw) return null;
  if (product.priceCents === 0 || product.recurring || product.call || product.options.length > 0) return null;
  // A suggestion under the floor would be refused by Stripe; the floor wins.
  return { suggestedCents: Math.max(pwyw.suggestedCents, product.priceCents) };
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const priceKey = (account: string, print: string) => `nl:pwyw:${account}:${print}`;

/** A year: long enough that a steady seller never waits for Stripe twice. */
const KEEP_SECONDS = 365 * 24 * 60 * 60;

/**
 * The id of the Price on the creator's account that lets a buyer choose the
 * amount of this product, made the first time it is needed.
 *
 * `fresh` skips the kept id, for the one retry after Stripe says the kept
 * Price can no longer be used (the creator archived it in their dashboard).
 */
export async function pwywPriceId(
  store: Store,
  product: Listing,
  pwyw: PayWhatYouWant,
  fresh = false,
): Promise<string> {
  const account = store.stripeAccountId;
  if (!account) throw new Error("This store has no account");
  // The currency is part of what shapes the Price: a store that changes it
  // is given a new one rather than a Price in the old currency.
  const shape = {
    product: product.id,
    title: product.title,
    minimum: product.priceCents,
    preset: pwyw.suggestedCents,
    maximum: Math.max(pwywMaximum(store.currency), pwyw.suggestedCents),
    tax: store.tax.enabled ? (store.tax.included ? "inclusive" : "exclusive") : "",
    ...(store.currency === "usd" ? {} : { currency: store.currency }),
    // Only where the store collects tax on a product it ships, so every Price made before keeps its fingerprint.
    ...(store.tax.enabled && activeShipping(product) ? { goods: GOODS_TAX_CODE } : {}),
  };
  const print = await fingerprint(JSON.stringify(shape));
  const key = priceKey(account, print);
  const cache = isRedisConfigured();

  if (cache && !fresh) {
    const [kept] = await redisPipeline([["GET", key]]);
    if (typeof kept === "string" && /^price_[A-Za-z0-9]{6,64}$/.test(kept)) return kept;
  }

  const body = new URLSearchParams({
    currency: store.currency,
    "custom_unit_amount[enabled]": "true",
    "custom_unit_amount[minimum]": String(shape.minimum),
    "custom_unit_amount[preset]": String(shape.preset),
    "custom_unit_amount[maximum]": String(shape.maximum),
    "product_data[name]": product.title,
    "product_data[metadata][store]": store.handle,
    "product_data[metadata][product]": product.id,
    "metadata[store]": store.handle,
    "metadata[product]": product.id,
  });
  if (shape.tax) body.set("tax_behavior", shape.tax);
  if (shape.goods) body.set("product_data[tax_code]", shape.goods);
  // Two buyers pressing buy at the same moment make one Price, not two.
  const price = await onAccount("POST", account, "/prices", body, undefined, `pwyw-${print}${fresh ? `-${Date.now()}` : ""}`);
  if (typeof price.id !== "string" || !price.id) throw new Error("Stripe did not return a price");
  if (cache) await redisPipeline([["SET", key, price.id, "EX", KEEP_SECONDS]]).catch(() => {});
  return price.id;
}
