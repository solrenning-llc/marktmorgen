/**
 * The spaces a member sees locked (542 [CM1], added 6 November 2026): a
 * space kept for the buyers of some products, which the creator chose to
 * show "Visible and locked" (Space.shown, lib/community.ts), to a member who
 * holds none of them.
 *
 * What it hands the page is all the page may draw of such a space: its name,
 * its one line, and the product that lets them in. Never its id or address,
 * its posts, comments, files, events, members or a count of any of them:
 * nothing about what is inside is read here at all. Whether a member is let
 * in stays maySeeSpace's alone (lib/community-access.ts): the caller passes
 * the spaces it opened, and every other kept space shown locked is listed.
 * A member who buys one of the products is let in by the same rule on their
 * next page (holdsAnyOf), with nobody approving anything.
 *
 * The product named is the first of the space's products, in the creator's
 * order, that a buyer can get on its page now, by the store's own rule
 * (productsBuyableNow, lib/mail-product-sellable.ts): published, not coming
 * soon, not sold out, and a store that can sell it (or give it, when free).
 * With none, the space says access is not available yet; when the products
 * could not be read, it says so, and names nothing.
 *
 * The way in is worked out for every space shown locked at once (unlocksOf),
 * so the studio's "View as a member" (components/community-member-preview.tsx)
 * draws, for the products the creator checks, the very list this draws.
 *
 * What it reads is paid before it reads, as a collection page pays for its
 * cards (lib/page-read-rules.ts): at most MAX_UNLOCK_PRODUCTS listings with
 * their stock and keys (collectionUnits), then the items of any bundle among
 * them (bundleItemUnits), each through the `take` the page passes, which
 * takes the store's public requests (lib/traffic.ts). Refused, nothing is
 * read and the answer is null.
 */
import type { CommunityConfig } from "@/lib/community";
import { type LockedSpace, type Unlock, lockedList, lockedOf } from "@/lib/community-gate";
import { readListings } from "@/lib/catalog";
import { bundleItemsToRead } from "@/lib/bundles";
import { productsBuyableNow } from "@/lib/mail-product-sellable";
import { bundleItemUnits, collectionUnits } from "@/lib/page-read-rules";
import { MAX_COLLECTION_PRODUCTS } from "@/lib/store-collections";
import { productSegment } from "@/lib/product-slug";
import type { Listing, Store } from "@/lib/store";

export { type LockedSpace, type Unlock, lockedOf } from "@/lib/community-gate";

/** The most products read for one page's locked spaces: one collection page's worth, the figure its requests are held to. */
export const MAX_UNLOCK_PRODUCTS = MAX_COLLECTION_PRODUCTS;

/** The products to read for them: each space's in its order, once each, at most MAX_UNLOCK_PRODUCTS. */
export function unlockCandidates(locked: readonly { needs: string[] }[]): string[] {
  return [...new Set(locked.flatMap((entry) => entry.needs))].slice(0, MAX_UNLOCK_PRODUCTS);
}

/**
 * The way into every space shown locked, by space id, whoever is asking:
 * worked out once for all of them, so a member's page and the studio's
 * "View as a member" name the same product for a space (or none). Null when
 * `take` refused the reads; an empty answer when the products could not be
 * read, which each space then says ("unknown", lockedList).
 */
export async function unlocksOf(
  store: Store,
  config: CommunityConfig,
  take: (units: number) => Promise<boolean>,
): Promise<Record<string, Unlock> | null> {
  const locked = lockedOf(config, new Set());
  if (locked.length === 0) return {};
  const ids = unlockCandidates(locked);
  let listings: Listing[];
  let buyable: Set<string>;
  if (!(await take(collectionUnits(ids.length)))) return null;
  try {
    listings = await readListings(store, ids);
    const items = bundleItemsToRead(listings);
    if (items.length > 0 && !(await take(bundleItemUnits(items.length)))) return null;
    buyable = await productsBuyableNow(store, listings);
  } catch (error) {
    console.error("reading a locked space's products failed", error);
    return {};
  }
  const byId = new Map(listings.map((p) => [p.id, p]));
  return Object.fromEntries(
    locked.map(({ space, needs }) => {
      const product = needs.map((id) => byId.get(id)).find((p): p is Listing => Boolean(p && buyable.has(p.id)));
      const unlock: Unlock = product ? { title: product.title, href: `/@${store.handle}/p/${productSegment(product)}` } : "none";
      return [space.id, unlock];
    }),
  );
}

/**
 * The locked spaces one member sees, or null when the store's requests did
 * not cover reading their products (the caller shows the resting page).
 * `opened` is the ids of the spaces maySeeSpace let them into; `unchecked`
 * those whose answer was not known (spaceChecks), each said as such, and
 * `lasting` whether that will stay so however often it is asked.
 */
export async function lockedSpaces(
  store: Store,
  config: CommunityConfig,
  opened: ReadonlySet<string>,
  take: (units: number) => Promise<boolean>,
  unchecked: ReadonlySet<string> = new Set(),
  lasting = false,
): Promise<LockedSpace[] | null> {
  const locked = lockedOf(config, opened);
  if (locked.length === 0) return [];
  const unlocks = await unlocksOf(store, config, take);
  return unlocks === null ? null : lockedList(locked, unlocks, unchecked, lasting);
}
