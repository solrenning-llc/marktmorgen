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
 *   - the store otherwise, read by that same reader, so what it checks (the owner key, the id the record carries) is
 *     still checked.
 *
 * A request that fails throws, as before; its caller says the page could not be read just now.
 */
import { type Store, STORE_ID_PATTERN, handleLeadsToStore, handleProblem, storeForId, storeForPage, storeHandleKey } from "@/lib/store";
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
  return (await storeForPage(handle)) ?? "unknown";
}

/** The store with this id, read exactly. */
export async function storeForIdExactly(sid: string): Promise<ExactStore> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return "none";
  const ref = await getExactly(`nl:store:id:${sid}`);
  if (ref === undefined) return "unknown";
  if (ref === null) return "none";
  return (await storeForId(sid)) ?? "unknown";
}
