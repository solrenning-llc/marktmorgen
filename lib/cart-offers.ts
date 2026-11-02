/**
 * The offers after paying, after a cart (556 [CT1]; added 1 November 2026).
 *
 * A product bought on its own has always been followed by its funnel's
 * offers (lib/upsell.ts). A cart was not: its checkout never kept the card,
 * so whoever paid for two or more products at once met no offer at all. Here
 * is what a cart adds to that, and nothing else; the offers themselves, their
 * charge and every protection are lib/upsell.ts's own, unchanged:
 *
 *   - whose offers: the first product in the cart, in the cart's order, whose
 *     funnel is on (lib/funnel.ts activeFunnel), at most the same five offers;
 *     only when at least one of them is something not in the cart, or the
 *     card is not kept at all;
 *   - never offered: anything in the cart, anything the buyer already has
 *     from this store (their completed checkouts, the offers they took after
 *     paying and what the creator brought over or gave them: ownedHere in
 *     lib/next-offer.ts, the reading the next product after a purchase uses),
 *     and anything they turned down in this order, even when the funnel offers it
 *     again at a lower price after a "no thanks". Each is passed over to
 *     the funnel's next offer, as a "no" would be; when none is left, none is
 *     shown. What they own that cannot be read in full means nothing is
 *     offered: never on a guess;
 *   - the price is the offer's own: the cart's "Buy more, save more" deal is
 *     not taken off it again (takeUpsell charges the step's price, nothing else).
 *
 * Cost: what the buyer owns is read from the creator's own Stripe account and
 * the store's brought-over purchases, only for a cart order whose offers are
 * open to this browser, and every reading counts CART_OFFER_REQUEST_UNITS of
 * the store's public requests before it is made (lib/buyer-actions.ts), so it
 * stays inside the figure each plan already has; past it, nothing is offered.
 * No new supplier, nothing written, no key of its own. It is read again on
 * each opening of the page and each answer, inside that count, rather than
 * kept: keeping it needs a new kind of record, registered in
 * tests/store-data-registry.ts (on the queue). Both readings fail closed, so
 * the page and the answer can only disagree by showing nothing.
 *
 * Known gap: ownedHere gives up (nothing offered) for an address with more
 * than three of the creator's customers, so a buyer's fourth checkout with
 * offers is followed by none. Safe, not yet good.
 */
import { activeFunnel, funnelPosition, funnelProductIds, type Funnel } from "@/lib/funnel";
import { offerableAfterPaying } from "@/lib/bundles";
import { readListings } from "@/lib/catalog";
import { bumpsFromMeta, deliverableItems } from "@/lib/bundle-rules";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { ownedHere } from "@/lib/next-offer";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import type { Listing, Product, Store } from "@/lib/store";
import { CART_OFFER_META } from "@/lib/cart-rules";

/**
 * Public requests one reading of what a buyer owns counts as: the same reads
 * and Stripe calls as the next product after a purchase (ownedHere), priced
 * in tests/plan-cost-registry.ts (NEXT_OFFER_READ), which is more than they
 * cost without the model.
 */
export const CART_OFFER_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS;

/** A product's live funnel among the offers that can follow a payment, with those offers, or null. */
export async function liveFunnel(store: Store, product: Product): Promise<{ funnel: Funnel; offered: Listing[] } | null> {
  if (store.tax.enabled || !product.funnel) return null;
  const offered = await offerableAfterPaying(store, await readListings(store, funnelProductIds(product.funnel)));
  const funnel = activeFunnel(offered, product);
  return funnel ? { funnel, offered } : null;
}

/**
 * The cart product whose offers follow paying for the cart: the first, in the
 * cart's order, with a live funnel. Null when there is none, or when every
 * offer its funnel could lead to is already in the cart, the products a
 * bundle in it hands over included (556 [CT1], unit 2, 2 November 2026): the
 * buyer gets those too, and the offers after paying pass over them
 * (deliveredIds in lib/upsell.ts), so a card kept for them would be kept for
 * nothing. Read as the checkout writes them (deliverableItems), one read per
 * bundle, at most MAX_CART.
 */
export async function cartOfferOwner(store: Store, products: Product[]): Promise<Product | null> {
  if (store.tax.enabled) return null;
  // A bundle's products as the cart's checkout writes them onto the order (lib/cart-checkout.ts): what it hands over today.
  const inside = await Promise.all(products.map(async (p) => (p.bundle ? deliverableItems(p, await readListings(store, p.bundle)).map((item) => item.id) : [])));
  const inCart = new Set([...products.map((p) => p.id), ...inside.flat()]);
  for (const product of products) {
    const live = await liveFunnel(store, product);
    if (!live) continue;
    // The first product with a funnel decides; the next one's is never used instead.
    return funnelPosition(live.funnel, live.offered, new Map(), inCart).kind === "offer" ? product : null;
  }
  return null;
}

/**
 * The product whose offers follow a paid cart, read from its checkout: only
 * when the checkout was a cart's and the product named is one of its own
 * lines (the first, or one that went in with it), never anything else.
 */
export function cartOfferFrom(meta: Record<string, string | undefined> | null | undefined): string | null {
  if (meta?.cart !== "yes") return null;
  const from = meta[CART_OFFER_META];
  if (typeof from !== "string" || !from) return null;
  const lines = [meta.product, ...bumpsFromMeta(meta).map((b) => b.id)];
  return lines.includes(from) ? from : null;
}

/**
 * Everything this buyer already has from the store, for a cart's offers to
 * pass over. Null when it cannot be read in full or the store's month of
 * requests is used: then nothing is offered.
 */
export async function ownedBeforeCart(store: Store, email: string | null): Promise<Set<string> | null> {
  if (!email) return null;
  if (!(await takeBuyerRead(store, CART_OFFER_REQUEST_UNITS))) return null;
  return ownedHere(store, email);
}
