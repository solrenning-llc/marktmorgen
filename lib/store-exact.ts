/**
 * A store found by its address or its id, read exactly (CX-123 rule 24; Codex J on #2910).
 *
 * The readers in lib/store.ts answer null both for a store that is not there and for a reply out of shape (no reply,
 * a number), so a page that asks them cannot tell "this store is gone" from "Redis did not answer as asked". These read
 * the store's own key first, in its exact shape:
 *
 *   - "none" only when that key is confirmed absent (an exact null), the address was let go, or the address or id
 *     cannot be a store's at all;
 *   - "unknown" when the reply is anything else, or when the key leads to a store whose record the reader in
 *     lib/store.ts could not give back;
 *   - the store otherwise, read from the record that key leads to with storeForEmail, which checks the record belongs
 *     to that very owner key; by id, the record must also carry that id, as storeForId checks.
 *
 * The key is read once: the record is read from the reference the exact read gave, never by asking the tolerant
 * reader again, which would repeat the same GET (Claude 3 on #2910: one command more per pasted card view).
 *
 * A request that fails throws, as before; its caller says the page could not be read just now.
 */
import { type Store, STORE_ID_PATTERN, handleLeadsToStore, handleProblem, ownerKey, storeForEmail, storeHandleKey } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

export type ExactStore = Store | "none" | "unknown";

/** The one reply of a GET, exactly: a non-empty string, null for an exact null, or undefined for anything else. */
async function getExactly(key: string): Promise<string | null | undefined> {
  const replies = repliesFor(await redisPipeline([["GET", key]]), 1);
  if (!replies) return undefined;
  const ref = replies[0];
  if (ref === null) return null;
  return typeof ref === "string" && ref ? ref : undefined;
}

/** The store behind a public address (already normalised), read exactly. */
export async function storeForHandleExactly(handle: string): Promise<ExactStore> {
  // No Redis is no store, as storeForHandle answers.
  if (handleProblem(handle) || !isRedisConfigured()) return "none";
  const ref = await getExactly(storeHandleKey(handle));
  if (ref === undefined) return "unknown";
  // A name that was let go is held, not owned: it leads nowhere on purpose.
  if (ref === null || !handleLeadsToStore(ref)) return "none";
  return (await storeForEmail(ref)) ?? "unknown";
}

/** The store with this id, read exactly. */
export async function storeForIdExactly(sid: string): Promise<ExactStore> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return "none";
  const ref = await getExactly(`nl:store:id:${sid}`);
  if (ref === undefined) return "unknown";
  if (ref === null) return "none";
  const store = await storeForEmail(ref);
  return store && store.sid === sid ? store : "unknown";
}

/**
 * The store an owner reference (an address, or an extra store's ref) names, read exactly: "none" only when its owner
 * key is confirmed absent (an exact null). A record that does not read back, or a reply of another shape, is
 * "unknown", never gone (lib/share-settle.ts keeps such a store in its indexes). One more GET only when the tolerant
 * reader found nothing.
 */
export async function storeForRefExactly(ref: string): Promise<ExactStore> {
  if (!ref || !isRedisConfigured()) return "none";
  const store = await storeForEmail(ref);
  if (store) return store;
  return (await getExactly(await ownerKey(ref))) === null ? "none" : "unknown";
}
