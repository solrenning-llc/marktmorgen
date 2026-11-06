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
import { KIND, MAX_PRODUCT_BYTES, STORE_PAGE_SIZE, readListings } from "@/lib/catalog";
import { cartable } from "@/lib/cart-rules";
import { soonState } from "@/lib/preorders";
import { redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
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
  // The weighing command and one GET per listing; bytes at what the data room says they weigh.
  return Math.max(1, Math.ceil((listings + 1) / CART_LINK_UNIT_COMMANDS), Math.ceil(bytes / CART_LINK_UNIT_BYTES));
}

/**
 * What these products' records weigh together, from the data room: a weight
 * counts only when Redis answered exactly (one reply, an array of one value per product)
 * and the value is a positive whole number; every other product is weighed at
 * MAX_PRODUCT_BYTES.
 */
async function weigh(store: Store, ids: string[]): Promise<number> {
  const key = dataKey(store);
  // Exactly one reply for the one command (Codex G on #1928): an answer with more or fewer is not known, and every
  // product is then weighed at its ceiling.
  const replies: unknown = key ? await redisPipeline([["HMGET", key, ...ids.map((id) => `p:${id}`)]]) : null;
  const reply = Array.isArray(replies) && replies.length === 1 ? replies[0] : null;
  const exact = Array.isArray(reply) && reply.length === ids.length ? reply : null;
  return ids.reduce((sum, _id, i) => {
    const raw = exact?.[i];
    const n = typeof raw === "string" && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : typeof raw === "number" && Number.isSafeInteger(raw) ? raw : NaN;
    return sum + (n > 0 && n <= MAX_PRODUCT_BYTES ? n : MAX_PRODUCT_BYTES);
  }, 0);
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
    if (toRead.length) {
      const units = cartLinkUnits(toRead.length, await weigh(store, toRead));
      if (!(await countStudio(store, null, units)).ok) return [];
    }
    const coming = await soonState(store);
    const listed = await readListings(store, ids);
    return listed.filter((p) => cartable(p) && !coming.soon.has(p.id)).map((p) => ({ id: p.id, title: p.title }));
  } catch {
    return [];
  }
}
