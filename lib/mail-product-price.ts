/**
 * The price on a product's card in an email (546 [EB1], unit 1; added
 * 4 November 2026): pure and browser-safe, so the studio's preview and the
 * email that goes say the same words.
 *
 * The card never takes a price as typed text. It takes the facts the server
 * read from the store (PriceFacts, built by mailPriceFacts in
 * lib/mail-product-sellable.ts) and writes them here, in the store's language
 * and currency, as the store page does (pricePill in
 * components/store-product.tsx):
 *
 *   - Free: the store's word for it.
 *   - Pay what you want: "$5 or more", from the floor the creator set.
 *   - A membership: "$9 a month", from its lowest option ("from $9 a month").
 *     Never an introductory price or the yearly price beside it: those are
 *     offers with their own terms, said on the product's page.
 *   - Several options: "from $9", the lowest one a buyer can pick.
 *   - A call with several lengths: "from $45", the lowest length's price.
 *   - One price under a running store sale: "Sale price: $20, until Oct 9,
 *     3:00 PM UTC", only while the sale still has more than a day to run
 *     (MAIL_SALE_MARGIN_SECONDS). An email is read hours or days after it
 *     goes, so a sale closer to its end is not promised: the regular price
 *     is shown, and the page takes the sale off if it is still on.
 *   - Tax added on top at checkout (Stripe Tax on, prices without it): the
 *     price says so ("+ tax where it applies"), right after the amount, so
 *     it never reads as part of a sale's end date.
 *
 * Never the price for a visitor's country (lib/fair-price.ts): an email has
 * no visitor, and its readers live anywhere.
 */
import { everyPhrase, speech } from "@/lib/buyer-words";
import { salePrice } from "@/lib/store-sale";

/** A sale is shown in an email only while it has more than this left to run: a day. */
export const MAIL_SALE_MARGIN_SECONDS = 86_400;

export type PriceInterval = "day" | "week" | "month" | "year";

/** What decides a card's price, read from the store on the server. */
export type PriceFacts = {
  free: boolean;
  /** The product's own price, in the smallest unit of the store's currency. */
  priceCents: number;
  /** The lowest price a buyer can pick: the product's own with no options. */
  fromCents: number;
  /** How many options a buyer can pick (sellableOptions); 0 with none. */
  optionCount: number;
  /** How many lengths a call offers a buyer (listedLengths, lib/call-lengths.ts); 0 or left out with one. */
  lengthCount?: number;
  /** A membership's interval, or null for something bought once. */
  interval: PriceInterval | null;
  /** How many intervals one charge covers, when more than one (609 [WP8]). */
  every?: number;
  /** Whether the buyer chooses the amount, from priceCents up. */
  pwyw: boolean;
  /** A store sale running on this product now (saleOff), with when it ends, in seconds. */
  sale: { percent: number; ends: number } | null;
  /** Whether tax is added on top at checkout. */
  taxOnTop: boolean;
};

/** The card's price in the store's language and currency. `nowSeconds` is when the email is drawn. */
export function mailPriceLabel(store: { language?: unknown; currency: string }, f: PriceFacts, nowSeconds: number): string {
  const { w, money, dateTime } = speech(store);
  if (f.free) return w.free;
  const tax = f.taxOnTop ? ` ${w.plusTax}` : "";
  if (f.pwyw) return `${w.orMore(money(f.priceCents))}${tax}`;
  // A call with several lengths: from the lowest of their prices, as the store's card says it (pricePill).
  if ((f.lengthCount ?? 0) > 1) return `${w.fromPrice(money(f.fromCents))}${tax}`;
  if (f.interval) {
    // How often, as charged (609 [WP8]): "every 3 months" for one charged every few months.
    const every = `${money(f.fromCents)} ${everyPhrase(store, f.interval, f.every)}`;
    return `${f.optionCount > 1 ? w.fromPrice(every) : every}${tax}`;
  }
  if (f.optionCount > 1) return `${w.fromPrice(money(f.fromCents))}${tax}`;
  if (f.optionCount === 0 && f.sale && f.sale.percent > 0 && f.sale.ends - nowSeconds > MAIL_SALE_MARGIN_SECONDS) {
    return w.salePriceUntil(`${money(salePrice(f.priceCents, f.sale.percent))}${tax}`, dateTime(f.sale.ends * 1000));
  }
  return `${money(f.fromCents)}${tax}`;
}
