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
 * a removal is never written without it. At most MAX_REMOVED_PRODUCTS, as many
 * as a catalog holds, so an erasure's size stays bounded (lib/erasure-rules.ts),
 * and no id is ever dropped from it while the store is open: a person's data kept
 * under the oldest removed product is reached as long as that under the newest
 * (Codex X3 on #4436: trimming to the newest left it out of the copy and behind
 * the erasure). A removal that would need room the list does not have is refused
 * (noteRemovedProduct answers "full"), and the product stays listed: it can be
 * unpublished instead. Products removed before this list existed are not on it,
 * as the copy says where it says what it holds.
 * Read and written exactly (rule 24): an unknown reply throws, never "none".
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";

/** The most removed products remembered for a store: as many as its catalog may hold. */
export const MAX_REMOVED_PRODUCTS = MAX_PRODUCTS;

const removedKey = (statsId: string) => `nl:prodgone:${statsId}`;
const PRODUCT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * In one step, as Redis runs a script: a product already on the list has its removal time updated; a new one is
 * added only while the list has room, never by dropping another. 1 added, 0 updated, -1 full.
 */
export const NOTE_REMOVED_PRODUCT = `-- marktmorgen:removed-product-note:v1
if redis.call("ZSCORE", KEYS[1], ARGV[2]) then
  redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
  return 0
end
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * Notes a product as removed, at this time, before it leaves the catalog: "noted", or "full" when the list has no
 * room for a product not on it yet (nothing written; the removal is refused). Throws when neither is confirmed.
 */
export async function noteRemovedProduct(statsId: string | null, productId: string, now = Date.now()): Promise<"noted" | "full"> {
  if (!statsId || !isRedisConfigured()) return "noted";
  if (!PRODUCT.test(productId)) throw new UnknownReplyError("a removed product's id");
  const replies = repliesFor(await redisPipeline([
    // Its latest removal: one removed again keeps its place, by its newest time.
    ["EVAL", NOTE_REMOVED_PRODUCT, 1, removedKey(statsId), now, productId, MAX_REMOVED_PRODUCTS],
  ]), 1);
  const answer = replies ? replies[0] : null;
  if (answer === 1 || answer === 0) return "noted";
  if (answer === -1) return "full";
  throw new UnknownReplyError("noting a removed product");
}

/**
 * Whether this product can be noted as removed now: it is on the list already, or the list has room. Asked before
 * a removal does anything that cannot be undone (a course's comments), so a full list refuses it untouched; the
 * note itself (noteRemovedProduct) still decides in one step. Throws on an unknown reply.
 */
export async function removedListHasRoom(statsId: string | null, productId: string): Promise<boolean> {
  if (!statsId || !isRedisConfigured()) return true;
  if (!PRODUCT.test(productId)) throw new UnknownReplyError("a removed product's id");
  const key = removedKey(statsId);
  const replies = repliesFor(await redisPipeline([["ZSCORE", key, productId], ["ZCARD", key]]), 2);
  const listed = replies ? replies[0] : undefined;
  const count = replies ? countOf(replies[1]) : null;
  if ((listed !== null && typeof listed !== "string") || count === null) throw new UnknownReplyError("a store's removed products");
  return listed !== null || count < MAX_REMOVED_PRODUCTS;
}

/** The ids of the products this store removed, newest first; an unknown reply throws, never "none". */
export async function removedProductIds(statsId: string | null): Promise<string[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["ZREVRANGE", removedKey(statsId), 0, -1]]), 1);
  const ids = replies ? stringList(replies[0]) : null;
  if (!ids || ids.length > MAX_REMOVED_PRODUCTS || !ids.every((id) => PRODUCT.test(id))) throw new UnknownReplyError("a store's removed products");
  return ids;
}
