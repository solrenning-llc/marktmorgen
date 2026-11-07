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
 * could not be read, it says so ("unknown"), and names nothing. Only what
 * was read is judged: a space reaching a product that was not read (past the
 * read cap) before one on sale is "capped", never "none".
 *
 * The way in is worked out for every space shown locked at once (unlocksOf),
 * so the studio's "View as a member" (components/community-member-preview.tsx)
 * draws, for the products the creator checks, the very list this draws.
 *
 * What it reads is paid before it reads, as a collection page pays for its
 * cards (lib/page-read-rules.ts): at most MAX_UNLOCK_PRODUCTS listings with
 * their stock and keys (collectionUnits), then the items of any bundle among
 * them (bundleItemUnits), each through the `take` the page passes, which
 * takes the store's public requests (lib/traffic.ts). Refused, nothing more
 * is read and the answer is null.
 */
import type { CommunityConfig } from "@/lib/community";
import { type LockedSpace, type Unlock, lockedList, lockedOf } from "@/lib/community-gate";
import { readListings } from "@/lib/catalog";
import { productsBuyableNow } from "@/lib/mail-product-sellable";
import { soonState } from "@/lib/preorders";
import { bundleItemUnits, collectionUnits } from "@/lib/page-read-rules";
import { MAX_COLLECTION_PRODUCTS } from "@/lib/store-collections";
import { productSegment } from "@/lib/product-slug";
import type { Listing, Store } from "@/lib/store";

export { type LockedSpace, type Unlock, lockedOf } from "@/lib/community-gate";

/** The most products read for one page's locked spaces: one collection page's worth, the figure its requests are held to. */
export const MAX_UNLOCK_PRODUCTS = MAX_COLLECTION_PRODUCTS;

/**
 * The products to read next for the spaces not settled yet, once each, at
 * most MAX_UNLOCK_PRODUCTS read in all: each space's next products not read,
 * at most `share` of them, taken in turns (each space's first, then each
 * one's second, and so on), so one space with many products cannot leave the
 * next with none read. A space settled by a product already read is not
 * passed in, so it takes nothing more from the cap.
 */
export function unlockCandidates(locked: readonly { needs: string[] }[], read: ReadonlySet<string> = new Set(), share = MAX_UNLOCK_PRODUCTS): string[] {
  const room = MAX_UNLOCK_PRODUCTS - read.size;
  const picked = new Set<string>();
  const pending = locked.map(({ needs }) => needs.filter((id) => !read.has(id)));
  const longest = Math.min(share, Math.max(0, ...pending.map((ids) => ids.length)));
  for (let turn = 0; turn < longest; turn++) {
    for (const ids of pending) {
      if (picked.size >= room) return [...picked];
      if (turn < ids.length) picked.add(ids[turn]);
    }
  }
  return [...picked];
}

/**
 * A space's way in from what was read: its first product on sale, in its
 * order. A product asked for and not returned is gone from the store (read,
 * not on sale); one reached before any on sale and not read yet leaves the
 * space "unread".
 */
function unlockOf(needs: readonly string[], read: ReadonlySet<string>, byId: ReadonlyMap<string, Listing>, buyable: ReadonlySet<string>): Listing | "none" | "unread" {
  for (const id of needs) {
    if (!read.has(id)) return "unread";
    const product = byId.get(id);
    if (product && buyable.has(id)) return product;
  }
  return "none";
}

/**
 * The way into every space shown locked, by space id, whoever is asking:
 * worked out once for all of them, so a member's page and the studio's
 * "View as a member" name the same product for a space (or none). Null when
 * `take` refused the reads; an empty answer when the products could not be
 * read, which each space then says ("unknown", lockedList).
 *
 * Read in rounds, one product per unsettled space first and twice as many
 * each round after, so a space settled by its first product leaves the rest
 * of the cap to the others. Each round pays before it reads, and nothing is
 * read twice: the pre-orders are read once, in the first round, and every
 * listing read (a space's product or a bundle's item) is kept and handed to
 * productsBuyableNow, so a bundle reached again in a later round, or an item
 * held by several bundles, is never read again. A round pays, before it
 * reads, for its products and for the items it reads for the first time, so
 * the rounds together pay at least what reading them at once would (an id
 * read as an item and later judged as a product is paid at both rates).
 * A failed read of the listings, the items,
 * the pre-orders, or a product's stock or keys (productsBuyableNow throws
 * for them when given what was read; review of #3007, L1) makes the answer
 * empty ("unknown"), never "none". A space still unread when the cap is
 * spent is "capped": reloading would read the same products again, so the
 * page says to ask the creator instead.
 */
export async function unlocksOf(
  store: Store,
  config: CommunityConfig,
  take: (units: number) => Promise<boolean>,
): Promise<Record<string, Unlock> | null> {
  const locked = lockedOf(config, new Set());
  if (locked.length === 0) return {};
  // `read`: the spaces' products judged so far, the cap's count. `asked`: every id read, as a product or an item;
  // `known`: what those reads found (an id asked and not here is gone from the store). `items`: the items read, paid.
  const read = new Set<string>();
  const asked = new Set<string>();
  const known = new Map<string, Listing>();
  const buyable = new Set<string>();
  const items = new Set<string>();
  let soon: ReadonlySet<string> | null = null;
  const pay = async (units: number) => units <= 0 || (await take(units));
  const readOnce = async (ids: readonly string[]): Promise<boolean> => {
    const fresh = ids.filter((id) => !asked.has(id));
    if (fresh.length === 0) return true;
    try {
      for (const listing of await readListings(store, fresh)) known.set(listing.id, listing);
    } catch (error) {
      console.error("reading a locked space's products failed", error);
      return false;
    }
    for (const id of fresh) asked.add(id);
    return true;
  };
  for (let share = 1; ; share *= 2) {
    const open = locked.filter(({ needs }) => unlockOf(needs, read, known, buyable) === "unread");
    const ids = unlockCandidates(open, read, share);
    if (ids.length === 0) break;
    if (!(await pay(collectionUnits(read.size + ids.length) - collectionUnits(read.size)))) return null;
    if (!(await readOnce(ids))) return {};
    const listings = ids.map((id) => known.get(id)).filter((listing): listing is Listing => Boolean(listing));
    const fresh = [...new Set(listings.flatMap((p) => (p.bundle && p.bundle.length > 0 ? p.bundle : [])))].filter((id) => !asked.has(id));
    if (!(await pay(bundleItemUnits(items.size + fresh.length) - bundleItemUnits(items.size)))) return null;
    if (!(await readOnce(fresh))) return {};
    for (const id of fresh) items.add(id);
    try {
      soon ??= (await soonState(store)).soon;
      for (const id of await productsBuyableNow(store, listings, Date.now(), { soon, listings: known })) buyable.add(id);
    } catch (error) {
      console.error("reading a locked space's products failed", error);
      return {};
    }
    for (const id of ids) read.add(id);
  }
  return Object.fromEntries(
    locked.map(({ space, needs }) => {
      const way = unlockOf(needs, read, known, buyable);
      const unlock: Unlock = way === "unread" ? "capped" : way === "none" ? "none" : { title: way.title, href: `/@${store.handle}/p/${productSegment(way)}` };
      return [space.id, unlock];
    }),
  );
}

/**
 * The locked spaces one member sees, or null when the store's requests did
 * not cover reading their products (the caller shows the resting page).
 * `opened` is the ids of the spaces the member was let into, and `unchecked`
 * those whose answer could not be read just now (answeredSpaces,
 * lib/community-access.ts): each of those shown locked is listed as
 * "unchecked", with no way in offered and nothing read for it, since the
 * member may already hold its product (review of #3007, M1).
 */
export async function lockedSpaces(
  store: Store,
  config: CommunityConfig,
  opened: ReadonlySet<string>,
  take: (units: number) => Promise<boolean>,
  unchecked: ReadonlySet<string> = new Set(),
): Promise<LockedSpace[] | null> {
  const notChecked: LockedSpace[] = lockedOf(config, opened)
    .filter(({ space }) => unchecked.has(space.id))
    .map(({ space }) => ({ name: space.name, about: space.about, unlock: "unchecked" }));
  const locked = lockedOf(config, new Set([...opened, ...unchecked]));
  if (locked.length === 0) return notChecked;
  const unlocks = await unlocksOf(store, config, take);
  return unlocks === null ? null : [...lockedList(locked, unlocks), ...notChecked];
}
