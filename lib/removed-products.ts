/**
 * The products a store has removed from its catalog, so that a person's data
 * kept under one of them after it is gone (a license key sold, a PayPal order,
 * a pre-order, a waitlist place) is still reached by the copy of their data
 * (lib/person-copy.ts) and by their erasure (lib/person-erasure.ts), which
 * otherwise walk only the products the store lists now.
 *
 *   nl:prodgone:<statsId>   sorted set   a removed product's id -> when it was removed (ms)
 *
 * Noted before the product leaves the catalog (lib/store.ts removeProduct), so
 * a removal is never written without it. Kept to the newest
 * MAX_REMOVED_PRODUCTS, as many as a catalog holds, so an erasure's size stays
 * bounded (lib/erasure-rules.ts): a store that removed more than that has its
 * oldest ones dropped from this list. Products removed before this list
 * existed are not on it. Both are said where the copy says what it holds.
 * Read and written exactly (rule 24): an unknown reply throws, never "none".
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";

/** The most removed products remembered for a store: as many as its catalog may hold. */
export const MAX_REMOVED_PRODUCTS = MAX_PRODUCTS;

const removedKey = (statsId: string) => `nl:prodgone:${statsId}`;
const PRODUCT = /^[A-Za-z0-9_-]{1,64}$/;

/** Notes a product as removed, at this time, before it leaves the catalog; throws when that is not confirmed. */
export async function noteRemovedProduct(statsId: string | null, productId: string, now = Date.now()): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  if (!PRODUCT.test(productId)) throw new UnknownReplyError("a removed product's id");
  const key = removedKey(statsId);
  const replies = repliesFor(await redisPipeline([
    // Its latest removal: one removed again is never trimmed before products removed since its first time.
    ["ZADD", key, now, productId],
    ["ZREMRANGEBYRANK", key, 0, -(MAX_REMOVED_PRODUCTS + 1)],
  ]), 2);
  const added = replies ? countOf(replies[0]) : null;
  const trimmed = replies ? countOf(replies[1]) : null;
  if (added === null || added > 1 || trimmed === null) throw new UnknownReplyError("noting a removed product");
}

/** The ids of the products this store removed, newest first; an unknown reply throws, never "none". */
export async function removedProductIds(statsId: string | null): Promise<string[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["ZREVRANGE", removedKey(statsId), 0, -1]]), 1);
  const ids = replies ? stringList(replies[0]) : null;
  if (!ids || ids.length > MAX_REMOVED_PRODUCTS || !ids.every((id) => PRODUCT.test(id))) throw new UnknownReplyError("a store's removed products");
  return ids;
}
