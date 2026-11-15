/**
 * The products the studio's ready cart link builder offers (624 [SZ8](23),
 * components/cart-link-builder.tsx), read at a cost the studio admitted first.
 *
 * Codex G2 on #1928: the first version read every paid product's listing,
 * drafts included, before filtering them, so a store of 200 drafts and two
 * published products read 198 listings (about 320 kB) on a page admitted at
 * STUDIO_PAGE_UNITS. Now:
 *
 *   - the store record's index rules out, without a read, everything a cart
 *     can never take (free, a call, a membership, a limited one, a draft, one
 *     with price options), as offersCart does;
 *   - at most CART_LINK_CHOICES of what is left are read, in the store's
 *     order;
 *   - listings already in the store record (its head) cost nothing more; the
 *     others are weighed first from the data room (one HMGET, what each
 *     product's records weigh, the ceiling MAX_PRODUCT_BYTES when it is not
 *     known exactly) and paid for in studio requests at the studio request's
 *     shape (tests/plan-cost-registry.ts, line studio) before a single one is
 *     read. Refused, nothing is read and nothing is offered.
 */
import { KIND, MAX_PRODUCT_BYTES, STORE_PAGE_SIZE, listingSizes, readListingsMeasured } from "@/lib/catalog";
import { cartable } from "@/lib/cart-rules";
import { knownNotSoon, soonState } from "@/lib/preorders";
import { redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { forceAllowance } from "@/lib/store-allowance";
import { countStudio } from "@/lib/studio-route";

/** The most products the builder lists, in the store's order: the first page of the store, which a cart of MAX_CART is chosen from. */
export const CART_LINK_CHOICES = STORE_PAGE_SIZE;

/** What one studio request pays for (tests/plan-cost-registry.ts, the studio request's shape): its commands and the bytes through the database. */
export const CART_LINK_UNIT_COMMANDS = 20;
export const CART_LINK_UNIT_BYTES = 50_000;

/** What can never go in a cart, read from the index alone. */
const NEVER = KIND.free | KIND.call | KIND.recurring | KIND.limited | KIND.hidden;

/** The products a cart may hold as far as the store record's index can tell, in the store's order, with no read. Pure. */
export function cartLinkCandidates(store: Pick<Store, "catalog">): string[] {
  return store.catalog.items.filter((item) => (item.kind & KIND.paid) !== 0 && (item.kind & NEVER) === 0 && item.options.length === 0).map((item) => item.id);
}

/** The studio requests a read of these many listings weighing these many bytes takes. Pure. */
export function cartLinkUnits(listings: number, bytes: number): number {
  // The weighing command and `listings` more (one STRLEN and one GET per listing read); bytes at what they weigh.
  return Math.max(1, Math.ceil((listings + 1) / CART_LINK_UNIT_COMMANDS), Math.ceil(bytes / CART_LINK_UNIT_BYTES));
}

/**
 * What these products' records weigh together, from the data room: a weight
 * counts only when Redis answered exactly (one reply, an array of one value per product)
 * and the value is a positive whole number; every other product is weighed at
 * MAX_PRODUCT_BYTES.
 */
async function weigh(store: Store, ids: string[]): Promise<number[]> {
  const key = dataKey(store);
  // Exactly one reply for the one command (Codex G on #1928): an answer with more or fewer is not known, and every
  // product is then weighed at its ceiling.
  const replies: unknown = key ? await redisPipeline([["HMGET", key, ...ids.map((id) => `p:${id}`)]]) : null;
  const reply = Array.isArray(replies) && replies.length === 1 ? replies[0] : null;
  const exact = Array.isArray(reply) && reply.length === ids.length ? reply : null;
  return ids.map((_id, i) => {
    const raw = exact?.[i];
    const n = typeof raw === "string" && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : typeof raw === "number" && Number.isSafeInteger(raw) ? raw : NaN;
    return n > 0 && n <= MAX_PRODUCT_BYTES ? n : MAX_PRODUCT_BYTES;
  });
}

/**
 * The products a ready cart link may hold, for the studio's builder: what
 * the cart route takes today, listed and paid, sold once at one price, not
 * coming soon; at most CART_LINK_CHOICES. Anything not known, a read that
 * fails or studio requests that are used up list nothing.
 */
export async function cartLinkProducts(store: Store): Promise<{ id: string; title: string }[]> {
  try {
    const ids = cartLinkCandidates(store).slice(0, CART_LINK_CHOICES);
    if (ids.length < 2) return [];
    const held = new Set(store.catalog.head.map((listing) => listing.id));
    const toRead = store.catalog.inline ? [] : ids.filter((id) => !held.has(id));
    let taken = 0;
    let counted: Store = store;
    if (toRead.length) {
      // The data room's weights, raised to what each listing record weighs now (Codex G on #1928: a record that grew
      // after it was weighed is paid at its new size before it is read); one that cannot be measured at its ceiling.
      const weights = await weigh(store, toRead);
      const sizes = await listingSizes(store, toRead);
      const bytes = weights.reduce((sum, weight, i) => sum + Math.min(MAX_PRODUCT_BYTES, sizes ? Math.max(weight, sizes[i]) : MAX_PRODUCT_BYTES), 0);
      // One STRLEN and one GET per listing, and the weighing.
      const units = cartLinkUnits(2 * toRead.length, bytes);
      const admitted = await countStudio(store, null, units);
      if (!admitted.ok) return [];
      if (admitted.store) counted = admitted.store;
      taken = units;
    }
    const coming = await soonState(store);
    const { listings: listed, bytes: read } = await readListingsMeasured(store, ids);
    // Settled at what was really read (Claude 4, C4-20261106-1740-C3-104 and 1810-C3-107): a record that grew between
    // its STRLEN and its GET has its difference counted in the same figure, with no new read, past the figure if it
    // must, because it was already spent; the next opening is then refused as usual. A count that is not confirmed
    // lists nothing.
    const due = toRead.length ? cartLinkUnits(2 * toRead.length, read) - taken : 0;
    if (due > 0 && !(await forceAllowance(counted, "studio", due))) return [];
    // Only a product known not to be coming soon: with the reading in part, one outside it is unknown and left out.
    return listed.filter((p) => cartable(p) && knownNotSoon(coming, p.id)).map((p) => ({ id: p.id, title: p.title }));
  } catch {
    return [];
  }
}
