/**
 * A cart (added 10 October 2026): several of a store's products in one
 * payment, as rules the browser can read too. The checkout is built in
 * lib/cart-checkout.ts.
 *
 * Gumroad and Payhip have one. Here a cart is the store's own: a visitor adds
 * products from their cards and pages, sees them with their prices as they
 * are now, and pays for all of them at once on the creator's own Stripe
 * account. Each is handed over exactly as if bought on its own, because the
 * order names them the way a checkout's added products are always named
 * (lib/bundle-rules.ts, BUMP_KEYS), and every page and email that hands
 * things over already reads that.
 *
 * What can go in one is what one plain payment can sell: a paid product at
 * one price, sold once, that nobody has to choose, book, hold or answer
 * questions for first, handed over digitally or shipped by the creator
 * (lib/cart-shipping.ts). Up to MAX_CART at a time, which is how many
 * products one order can name.
 */
import type { Listing } from "@/lib/store";
import { activeShipping } from "@/lib/shipping";

/** The most products one cart pays for: the product and the three an order can add to it. */
export const MAX_CART = 4;

/** The cart checkout's metadata field naming the product whose offers after paying follow it (lib/cart-offers.ts). */
export const CART_OFFER_META = "offer_from";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a product can go in a cart. Its checkout questions and whether it is coming soon are checked where it is paid for. */
export function cartable(product: Listing): boolean {
  if (product.priceCents <= 0 || product.hidden) return false;
  if (product.recurring || product.call || product.callPackage || product.podcast) return false;
  if (product.options.length > 0 || product.pwyw || product.stock !== null) return false;
  // A bundle its buyer builds is chosen on its own page (lib/bundle-rules.ts).
  if (product.bundle && product.pick) return false;
  if (product.bundle) return product.bundle.length >= 2;
  if (product.course) return product.course.lessons > 0;
  // A physical product the creator ships (513 [PF1], unit 2b): Stripe asks for
  // one address in a country every physical product in the cart ships to
  // (lib/cart-shipping.ts). A limited one waits for the cart to hold stock.
  if (activeShipping(product)) return true;
  return product.file !== null || product.link !== null;
}

/** The products a cart names, as sent: ids, each once, at most MAX_CART. */
export function readCartIds(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !SAFE_ID.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_CART) break;
  }
  return out;
}

/**
 * A store's deal for buying more (added 10 October 2026): every product in a
 * cart a percentage cheaper once it holds `min` or more. Off until the
 * creator switches it on; said on the cart and under every "Add to cart" while
 * it is, so the buyer knows before they choose, not only at the till.
 */
export type CartDeal = { on: boolean; min: number; percent: number };

export const NO_DEAL: CartDeal = { on: false, min: 2, percent: 10 };
export const DEAL_MIN_CHOICES = [2, 3, 4] as const;
export const DEAL_MIN_PERCENT = 5;
export const DEAL_MAX_PERCENT = 50;

export function parseCartDeal(raw: unknown): CartDeal {
  if (!raw || typeof raw !== "object") return { ...NO_DEAL };
  const v = raw as Record<string, unknown>;
  const min = Number(v.min);
  const percent = Number(v.percent);
  return {
    on: v.on === true,
    min: (DEAL_MIN_CHOICES as readonly number[]).includes(min) ? min : NO_DEAL.min,
    percent: Number.isInteger(percent) && percent >= DEAL_MIN_PERCENT && percent <= DEAL_MAX_PERCENT ? percent : NO_DEAL.percent,
  };
}

/** The percentage a cart of `count` products takes off each of them under the deal, or 0. */
export function dealOff(deal: CartDeal | undefined, count: number): number {
  return deal?.on && count >= deal.min ? deal.percent : 0;
}
