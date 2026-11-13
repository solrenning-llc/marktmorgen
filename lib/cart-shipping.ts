/**
 * Physical products in the cart (513 [PF1], unit 1; added 1 November 2026):
 * the rules, before the checkout uses them.
 *
 * A product shipped by the creator (lib/shipping.ts) is sold today on its
 * own. In a cart, with other physical products and with digital ones, it is
 * paid in one direct charge on the creator's Stripe account, and Stripe asks
 * for one address. So:
 *
 *   - The address may be in a country every physical product in the cart
 *     ships to, and only there: the countries Stripe offers are the ones they
 *     all share.
 *   - When they share none, the cart names the fewest products to take out
 *     (those that do not reach the one country most of them reach, the
 *     buyer's own when it is one of those), before anybody pays.
 *   - A physical product whose shipping cannot be read (or has no country,
 *     or an amount out of its bounds) is refused, never taken as digital.
 *   - Shipping is each physical product's own amount, as its creator set it
 *     ("one amount per order" on each), added together, so no product ships
 *     for less than its creator asked. Shipping by quantity, and combining
 *     amounts, is 515 [PF3]'s.
 *
 * Digital products in the cart ship nothing and change none of this.
 * Browser-safe: the cart shows the same answer the checkout acts on.
 *
 * Wired into the cart in unit 2b (2 November 2026): lib/cart-rules.ts lets a
 * physical product in, lib/cart-checkout.ts asks Stripe for the address and
 * the shipping from cartShipping, and the open cart says the same before the
 * buyer pays (app/api/store/cart/route.ts).
 */
import { MAX_SHIPPING_CENTS, type ShipCandidate, type Shipping, activeShipping } from "@/lib/shipping";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { type SafetyCandidate, shippingNow } from "@/lib/physical-legal-ship";
import type { Store } from "@/lib/store";

/**
 * A product as the cart has it. `physical` comes from the product itself, so
 * a physical product whose shipping cannot be read is refused, never taken
 * for a digital one (unknown fails).
 */
export type CartItem = { id: string; title: string; physical: boolean; shipping: Pick<Shipping, "cents" | "countries"> | null };

export type CartShipping =
  /** Nothing in the cart is shipped. */
  | { kind: "none" }
  /** One address, in one of `countries`; `cents` is the shipping for the order, made of each product's own `each`. */
  | { kind: "ships"; countries: string[]; cents: number; each: { id: string; cents: number }[] }
  /** No country is shared: take out `apart`, the fewest products, and the rest ship to `to`. */
  | { kind: "apart"; to: string; apart: { id: string; title: string }[] }
  /** A physical product whose shipping cannot be read or is out of its bounds: it cannot be bought in a cart. */
  | { kind: "unreadable"; items: { id: string; title: string }[] };

const readable = (cents: number) => Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_SHIPPING_CENTS;

/**
 * Where a cart can be sent and what shipping comes to, from its physical
 * products. `buyerCountry`, when known, is preferred when nothing is shared,
 * so the product the buyer can receive is never the one named.
 */
export function cartShipping(items: CartItem[], buyerCountry?: string): CartShipping {
  const physical = items.filter((item) => item.physical || item.shipping !== null);
  if (physical.length === 0) return { kind: "none" };
  const bad = physical.filter((item) => !item.shipping || !readable(item.shipping.cents) || item.shipping.countries.length === 0);
  if (bad.length > 0) return { kind: "unreadable", items: bad.map(({ id, title }) => ({ id, title })) };
  const shipped = physical.map((item) => ({ id: item.id, title: item.title, cents: item.shipping!.cents, countries: [...new Set(item.shipping!.countries)] }));

  let shared = new Set(shipped[0].countries);
  for (const item of shipped.slice(1)) shared = new Set(item.countries.filter((code) => shared.has(code)));
  if (shared.size > 0) {
    return {
      kind: "ships",
      countries: shipped[0].countries.filter((code) => shared.has(code)),
      cents: shipped.reduce((sum, item) => sum + item.cents, 0),
      each: shipped.map(({ id, cents }) => ({ id, cents })),
    };
  }
  // One country: the one most of them reach (the buyer's first, on a tie or when reached at all by the most),
  // then the first in the cart's own order. Taking out what does not reach it leaves the fewest to take out.
  const reach = new Map<string, number>();
  for (const item of shipped) for (const code of item.countries) reach.set(code, (reach.get(code) ?? 0) + 1);
  const most = Math.max(...reach.values());
  const order = shipped.flatMap((item) => item.countries).filter((code, i, all) => all.indexOf(code) === i);
  const best = order.filter((code) => reach.get(code) === most);
  const to = buyerCountry && best.includes(buyerCountry) ? buyerCountry : best[0];
  return { kind: "apart", to, apart: shipped.filter((item) => !item.countries.includes(to)).map(({ id, title }) => ({ id, title })) };
}

/**
 * A product as the cart reads it: physical when it ships today, as on its own
 * checkout (lib/shipping.ts, activeShipping), to the countries it ships to now:
 * without the EU/EEA while its safety fields are not filled (618 [SZ2],
 * lib/physical-legal-ship.ts). One that ships nowhere now has no country and
 * cannot be paid for in a cart.
 */
export function cartItemOf(product: SafetyCandidate & { id: string; title: string }): CartItem {
  const shipping = shippingNow(product);
  return { id: product.id, title: product.title, physical: shipping !== null, shipping };
}

/**
 * Whether a cart holds both products the creator ships and products handed
 * over online. Such a cart is not paid for yet (513 [PF1], unit 2b, 2
 * November 2026): the order's own product is a shipped one (shippedFirst),
 * and the confirmation email (lib/purchase-email.ts) then shows the address
 * in place of the way to what was bought online. Until that email names both,
 * the open cart says so and the checkout refuses it, so nobody pays for
 * something whose way in is not sent to them.
 */
export function shipsWithOnline(products: (ShipCandidate & { shipping?: Shipping | null })[]): boolean {
  const shipped = products.filter((p) => activeShipping(p) !== null).length;
  return shipped > 0 && shipped < products.length;
}

/**
 * The cart's products with the shipped ones first, each group in the cart's
 * own order. The first product is the order's own (lib/cart-checkout.ts),
 * and the thanks page and the confirmation email show where an order is
 * going only under it; the others are handed over in their own boxes as
 * before.
 */
export function shippedFirst<P extends ShipCandidate & { shipping?: Shipping | null }>(products: P[]): P[] {
  return [...products.filter((p) => activeShipping(p) !== null), ...products.filter((p) => activeShipping(p) === null)];
}

/**
 * When the shipping is shown on its own line: the creator's line about when
 * it ships, when there is one physical product or they all say the same;
 * otherwise none, since each product's page and its line in the cart say its
 * own.
 */
export function sharedShipNote(notes: string[]): string {
  const said = [...new Set(notes.map((note) => note.trim()))];
  return said.length === 1 ? said[0] : "";
}

/**
 * What a cart's checkout sends Stripe when something in it ships, as one
 * product's checkout does (lib/store-checkout.ts): an address in one of the
 * shared countries, and the shipping, each product's own amount added
 * together, as its own line before paying. With Stripe Tax on, the shipping
 * is taxed as shipping and each shipped line, by its own place in the cart, as
 * goods rather than the account's default. Sent to Stripe's test mode every
 * day (lib/verify-stripe.ts, verifyCartShipping).
 */
export function applyCartShipping(
  body: URLSearchParams,
  store: Pick<Store, "language" | "currency" | "tax">,
  products: (ShipCandidate & { shipping?: Shipping | null })[],
  shipping: Extract<CartShipping, { kind: "ships" }>,
): void {
  const sw = shippingWords(store.language);
  shipping.countries.forEach((code, i) => body.set(`shipping_address_collection[allowed_countries][${i}]`, code));
  const rate = "shipping_options[0][shipping_rate_data]";
  body.set(`${rate}[type]`, "fixed_amount");
  body.set(`${rate}[fixed_amount][amount]`, String(shipping.cents));
  body.set(`${rate}[fixed_amount][currency]`, store.currency);
  const note = sharedShipNote(products.flatMap((product) => activeShipping(product)?.note ?? []));
  body.set(`${rate}[display_name]`, [shipping.cents > 0 ? sw.rate : sw.freeRate, note].filter(Boolean).join(" · ").slice(0, 100));
  if (store.tax.enabled) {
    body.set(`${rate}[tax_behavior]`, store.tax.included ? "inclusive" : "exclusive");
    body.set(`${rate}[tax_code]`, "txcd_92010001");
    products.forEach((product, i) => {
      if (activeShipping(product)) body.set(`line_items[${i}][price_data][product_data][tax_code]`, "txcd_99999999");
    });
  }
  body.set("metadata[ship]", "yes");
  body.set("payment_intent_data[metadata][ship]", "yes");
}
