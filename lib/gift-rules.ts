/**
 * Buying something for somebody else, as rules the browser can read too. The
 * part that keeps and delivers gifts is lib/gifts.ts.
 *
 * The buyer pays on Stripe's page as for anything else, and their receipt
 * says it was a gift and who it went to. The person they chose gets one
 * email: who it is from, their message, and a link to open it. From then on
 * it is theirs as if they had bought it — its download, its course, the
 * community it opens — on their own address, and the buyer does not get a
 * copy. A full refund takes it back.
 *
 * What can be given: a paid product bought once, that hands over a file, a
 * link, a course or a bundle. Not a membership or a payment plan (the
 * payments would be the buyer's for months), not a call (the time is the
 * buyer's to pick), not a price the buyer chooses or license keys.
 *
 * A product with price options can be given at any of them that hands
 * something over: the buyer picks which, pays that price, and that option is
 * what the recipient owns (its file or link, or the course at that option).
 * Not a private podcast sold at several prices: its feed is its buyer's own.
 */
import type { Listing } from "@/lib/catalog";
import type { ProductOption } from "@/lib/product-option";

export const GIFT_ID = /^gft_[0-9a-f]{24}$/;
export const MAX_GIFT_MESSAGE = 500;
export const MAX_GIFT_FROM = 60;
/** How long a gift waits for its checkout to be paid. */
export const GIFT_PENDING_SECONDS = 2 * 86_400;
/** How long a paid gift is remembered: for the receipt, the list of purchases and a refund. */
export const GIFT_KEPT_SECONDS = 400 * 86_400;

/** Whether this product can be bought as a gift. */
export function canGift(product: Listing): boolean {
  if (product.recurring || product.call || product.pwyw || product.keys) return false;
  // A bundle whose buyer chooses what is in it is chosen by whoever it is for (lib/bundle-rules.ts).
  if (product.bundle && product.pick) return false;
  if (product.options.length > 0) return givableOptions(product).length > 0;
  if (product.priceCents <= 0) return false;
  return Boolean(product.file || product.link || product.course || product.bundle);
}

/**
 * The price options of a product that can be bought for somebody else: on
 * sale (642 [WG2]: one the creator took off sale is never offered, even when
 * it is their pick), paid, and handing over a file or a link of their own, or
 * opening the course. Empty for a product sold at one price.
 */
export function givableOptions(product: Listing): ProductOption[] {
  if (product.recurring || product.call || product.pwyw || product.keys) return [];
  return product.options.filter((option) => !option.offSale && option.priceCents > 0 && Boolean(option.file || option.link || product.course));
}

/**
 * The option a purchase for somebody else is for. `ok: false` when the
 * product has options and the one named is not among those that can be
 * given: refused, never guessed, because the option decides the price.
 */
export function givenOption(product: Listing, optionId: unknown): { ok: true; option: ProductOption | null } | { ok: false } {
  if (product.options.length === 0) return { ok: true, option: null };
  const option = givableOptions(product).find((o) => o.id === optionId) ?? null;
  return option ? { ok: true, option } : { ok: false };
}
