/**
 * Reading what a bundle holds, for the pages that sell it and the pages that
 * hand it over. The rules themselves are in lib/bundle-rules.ts, which the
 * browser can import too; this file is the part that reads products.
 *
 * Two different lists, on purpose:
 *
 *   - What a bundle offers a buyer who has not paid yet is its list as the
 *     creator saved it, each product as it is now, leaving out anything that
 *     can no longer be handed over whole (deliverableItems).
 *   - What a buyer who paid gets is the list written on their order when
 *     they paid (lib/bundle-rules.ts, bundleFromMeta), each product as it is
 *     now — its current file, link or lessons, exactly as a buyer of that
 *     product on its own gets them. A product the creator has since removed
 *     from the store is gone for them too, as it is for its own buyers, and
 *     the pages say so rather than hiding it.
 */
import type { Listing, Store } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { MIN_BUNDLE_ITEMS, deliverableItems } from "@/lib/bundle-rules";

/** What an order's bundle hands over now, and how many of its products are gone. */
export type BundleContents = { items: Listing[]; missing: number };

/** The products of a list written on an order, as the store has them now, in order. */
export async function contentsOf(store: Store, ids: string[]): Promise<BundleContents> {
  if (ids.length === 0) return { items: [], missing: 0 };
  const items = await readListings(store, ids);
  return { items, missing: Math.max(0, ids.length - items.length) };
}

/**
 * The items the bundles among `listings` hold that offeredItems reads, those
 * not already in `listings`: what a page counts and pays for before calling
 * it (lib/page-read-rules.ts, bundleItemUnits).
 */
export function bundleItemsToRead(listings: Listing[]): string[] {
  const known = new Set(listings.map((p) => p.id));
  return [...new Set(listings.flatMap((p) => (p.bundle && p.bundle.length > 0 ? p.bundle : [])))].filter((id) => !known.has(id));
}

/**
 * The products each bundle among `listings` offers right now, read at once:
 * one read for a whole page of cards however many bundles it has, and none
 * at all for a page without any, so a store without bundles keeps its round
 * trips exactly as they were (lib/catalog.ts).
 */
export async function offeredItems(store: Store, listings: Listing[]): Promise<Map<string, Listing[]>> {
  const bundles = listings.filter((p) => p.bundle && p.bundle.length > 0);
  const out = new Map<string, Listing[]>();
  if (bundles.length === 0) return out;
  const missing = bundleItemsToRead(listings);
  const read = missing.length ? await readListings(store, missing) : [];
  const all = [...listings, ...read];
  for (const bundle of bundles) out.set(bundle.id, deliverableItems(bundle, all));
  return out;
}

/**
 * Whether a bundle holds a course. Such a bundle is not offered in one click
 * after paying: an offer after paying is a payment of its own, outside the
 * checkouts a course's door reads (lib/learn.ts), so its lessons could not be
 * closed again on a refund. It can be sold on its own and ticked at checkout.
 */
export async function holdsCourse(store: Store, bundle: Pick<Listing, "bundle">): Promise<boolean> {
  if (!bundle.bundle?.length) return false;
  return (await readListings(store, bundle.bundle)).some((p) => p.course !== null);
}

/**
 * The listings a one-click offer after paying may name, from `listings`: a
 * bundle only while it holds enough to hand over and no course (holdsCourse).
 * Everything else is passed through untouched, and a list without bundles is
 * returned as it came, with nothing read.
 */
export async function offerableAfterPaying(store: Store, listings: Listing[]): Promise<Listing[]> {
  if (!listings.some((p) => p.bundle && p.bundle.length > 0)) return listings;
  const inside = await offeredItems(store, listings);
  return listings.filter((p) => {
    if (!p.bundle?.length) return true;
    const items = inside.get(p.id) ?? [];
    return items.length >= MIN_BUNDLE_ITEMS && !items.some((item) => item.course !== null);
  });
}
