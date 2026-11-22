/**
 * The "More from <store>" shelf on a course's front page, for its students
 * (628 [HN4](b), unit 2; owner's Hotmart audit). The rules of what a shelf
 * holds and what a student is shown are lib/course-shelf-rules.ts; here is the
 * one reading the page does, and what it costs.
 *
 * Who sees it: a student the course is open to, signed in, never its owner and
 * never a visitor who has not bought. What they see: the creator's own picks
 * the store lists now and sells today (by card or by PayPal), at the price on
 * their card, less the course and anything this address already has from the
 * store. Nothing is shown on a guess:
 *
 *   - what the address has is read as the next product after a purchase reads
 *     it (ownedHere in lib/next-offer.ts: the creator's own Stripe account,
 *     its offers after paying and what the creator brought over or gave), and
 *     where the store sells by PayPal, its PayPal purchases of each pick too
 *     (lib/paypal-sales.ts, ownKey), read exactly;
 *   - any of that unread, unreadable or past the store's month of requests is
 *     "not known": the shelf is not shown at all.
 *
 * Cost, at the most, with its ceiling taken before anything is read: one
 * reading is SHELF_REQUEST_UNITS of the store's public requests (lib/traffic.ts,
 * through takeBuyerRead), the same as the next product after a purchase, whose
 * reads (ownedHere, up to NEXT_OFFER_PRODUCTS + NEXT_OFFER_CHOICES listings)
 * hold this one's: ownedHere, at most MAX_SHELF listings and one pipeline of at
 * most MAX_SHELF counts (SHELF_READ in tests/plan-cost-registry.ts, held below
 * SHELF_REQUEST_UNITS requests in tests/plan-cost-registry.test.ts). A course
 * with no pick the store lists reads nothing and counts nothing. No supplier,
 * no model, no email, nothing written: the store's plan already pays for these
 * requests, and past them nothing is read.
 */
import { visibleIds, readListings } from "@/lib/catalog";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { ownedHere } from "@/lib/next-offer";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { ownKey, paypalReady, sellsThroughPayPal } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { canSellProduct } from "@/lib/store-checkout";
import { shelfFor } from "@/lib/course-shelf-rules";
import type { Listing, Store } from "@/lib/store";

/** Public requests one reading of the shelf counts as, before it reads: the next product after a purchase's own. */
export const SHELF_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS;

/** Whether a pick is on sale today, by card or by PayPal: a product nobody can buy is not put on a shelf. */
function onSale(store: Store, product: Listing): boolean {
  return !product.hidden && (canSellProduct(store, product) || paypalReady(store, product));
}

/**
 * The picks this address bought by PayPal, among `ids`, read exactly in one
 * pipeline; null when that cannot be read. Empty when the store does not sell
 * by PayPal: then there is nothing of it to read.
 */
async function paypalOwned(store: Store, email: string, ids: string[]): Promise<Set<string> | null> {
  if (!sellsThroughPayPal(store) || !ids.length) return new Set();
  if (!store.statsId || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline(ids.map((id) => ["SCARD", ownKey(store.statsId!, email, id)])), ids.length);
  if (!replies) return null;
  const owned = new Set<string>();
  for (const [at, reply] of replies.entries()) {
    const count = countOf(reply);
    if (count === null) return null;
    if (count > 0) owned.add(ids[at]);
  }
  return owned;
}

/**
 * What the course's shelf shows this student, in the creator's order: empty
 * when the course has no pick the store lists, when the store's month of
 * requests is used, or when what they have cannot be read in full.
 */
export async function shelfShown(store: Store, shelf: readonly string[] | undefined, courseProductId: string, email: string): Promise<Listing[]> {
  const listedNow = new Set(visibleIds(store));
  const picks = (shelf ?? []).filter((id) => id !== courseProductId && listedNow.has(id));
  if (!picks.length || !email) return [];
  if (!(await takeBuyerRead(store, SHELF_REQUEST_UNITS))) return [];
  try {
    const [stripeOwned, listings] = await Promise.all([ownedHere(store, email), readListings(store, picks)]);
    const paypal = stripeOwned ? await paypalOwned(store, email, picks) : null;
    const owned = stripeOwned && paypal ? new Set([...stripeOwned, ...paypal]) : null;
    const sold = listings.filter((p) => onSale(store, p));
    const byId = new Map(sold.map((p) => [p.id, p]));
    return shelfFor(picks, new Set(byId.keys()), owned, courseProductId).map((id) => byId.get(id)!);
  } catch (error) {
    console.error("reading a course's shelf failed", error);
    return [];
  }
}
