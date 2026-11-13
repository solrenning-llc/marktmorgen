/**
 * Whether a bundle can be sold right now, by what its products are: the one
 * rule every way of buying a bundle asks before anything is charged
 * (Claude 3's ruling, 13 November 2026; nobody pays for something that does
 * not exist yet).
 *
 * A product on its own is never sold while it is coming soon (its page takes
 * a waitlist sign-up, lib/waitlist.ts) or while its pool of license keys is
 * empty (lib/licence-keys.ts, outOfKeys). Until now a bundle holding such a
 * product was sold all the same: a product not out yet was handed over early,
 * through the bundle, and a buyer was charged for a key that did not exist.
 * Now a bundle is sold only while every product it would hand over could be
 * sold on its own:
 *
 *   - the single checkout and PayPal answer with the store page's notice
 *     "bundleunready" (lib/buyer-words), before any checkout opens;
 *   - the cart goes back to the store with the same notice;
 *   - a box checked at checkout is left off, as one that holds too little is;
 *   - an offer after paying, from a product's funnel or a cart, is not shown
 *     and not answered.
 *
 * Unknown is never available (CX-123 rule 24): a coming-soon list or a key
 * count that cannot be read keeps the bundle off sale, and the next press
 * asks again. The studio is unchanged: it still lets a creator put a product
 * coming soon in a bundle; the bundle simply waits until it is out.
 */
import type { Listing, Store } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { deliverableItems } from "@/lib/bundle-rules";
import { soonProducts } from "@/lib/coming-soon-set";
import { outOfKeys } from "@/lib/licence-keys";

/**
 * Thrown before anything is charged when a bundle holds a product that cannot be sold on its own right now: coming
 * soon, out of license keys, or not readable. Its routes answer with the store page's
 * "bundleunready" notice.
 */
export class BundleUnavailable extends Error {
  constructor() {
    super("A product in this bundle is not ready yet");
    this.name = "BundleUnavailable";
  }
}

/**
 * Whether every one of `items` (what a bundle would hand over) could be sold
 * on its own right now: none coming soon, none out of keys. False when any
 * cannot be read. Asks nothing for an empty list; reads the coming-soon list
 * once, and a key count only for a product that gives keys from a pool.
 */
export async function bundleItemsAvailable(store: Store, items: readonly Listing[]): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    const soon = await soonProducts(store);
    if (items.some((item) => soon.has(item.id))) return false;
    for (const item of items) if (await outOfKeys(store, item)) return false;
    return true;
  } catch (error) {
    console.error("reading whether a bundle's products are available failed", error);
    return false;
  }
}

/** Whether a product that is a bundle can be sold now by what it holds; true for anything that is not a bundle. */
export async function bundleAvailable(store: Store, product: Listing): Promise<boolean> {
  if (!product.bundle?.length) return true;
  let listings: Listing[];
  try {
    listings = await readListings(store, product.bundle);
  } catch (error) {
    console.error("reading a bundle's products failed", error);
    return false;
  }
  return bundleItemsAvailable(store, deliverableItems(product, listings));
}

/** `listings` without the bundles that cannot be sold now (bundleAvailable); everything else as it came, in order. */
export async function withAvailableBundles(store: Store, listings: Listing[]): Promise<Listing[]> {
  if (!listings.some((p) => p.bundle?.length)) return listings;
  const keep = await Promise.all(listings.map((p) => bundleAvailable(store, p)));
  return listings.filter((_, i) => keep[i]);
}
