/**
 * A store's fence for a write that can land after its erasure began (C5-20261119-1210-defeitos18): the store's own
 * key must still exist and its erasing mark (lib/store.ts ERASING_KEY) must be absent, read in the same step as the
 * write. closeStoreRecord deletes the id key and the record in the same fenced step as the erasing mark, so either one
 * being gone means erased. A store kept from before ids (its sid is "") has no id key: its record, under its owner's
 * address, is the key fenced on, and only while that record is still this store's own, its statsId (which never
 * changes for a store) the one asked for. After the store is erased its owner may make a new one under the same key,
 * and that record's being there must not let the erased store's late write back in (Codex X8 on #4951, X5 on #4942).
 * A legacy store with no statsId cannot be told from another: nothing is written, and the answer is unknown.
 * Kept apart from lib/store.ts so a module that writes for a store (lib/vault.ts, lib/storage-reservations.ts) takes
 * the fence without importing the store module; lib/store-live-cache.ts builds it for a store.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

/** The keys of one store's fence: its live key (its id key, or its record for a store from before ids), the erasing
 * hash and the store's field in it, and the statsId its record must carry: "" for a store with an id (its id key is
 * fenced on with EXISTS), null for a store from before ids with none (it cannot be told from another: unknown). */
export type StoreLiveFence = { live: string; erasing: string; field: string; statsId: string | null };

// ARGV[4] is "" for a store with an id (its id key is fenced on with EXISTS); for one from before ids it is the
// store's statsId, compared with the record's own. A record that does not parse is unknown (-1), never this store.
export const SET_IF_STORE_LIVE = `-- marktmorgen:store-cache-live:v2
if redis.call("HGET", KEYS[2], ARGV[1]) then return 0 end
if ARGV[4] == "" then
  if redis.call("EXISTS", KEYS[1]) ~= 1 then return 0 end
else
  local raw = redis.call("GET", KEYS[1])
  if not raw then return 0 end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return -1 end
  if record["statsId"] ~= ARGV[4] then return 0 end
end
redis.call("SET", KEYS[3], ARGV[2], "EX", ARGV[3])
return 1`;

/**
 * Keeps `value` under `key` for `seconds` while the fenced store is live: "kept"; "gone" when its erasure has begun or
 * its record is gone, and then nothing is written; "unknown" for any other answer (nothing known to be written).
 */
export async function setIfStoreLive(fence: StoreLiveFence, key: string, value: string, seconds: number): Promise<"kept" | "gone" | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  if (fence.statsId === null) return "unknown";
  const replies = repliesFor(await redisPipeline([["EVAL", SET_IF_STORE_LIVE, 3, fence.live, fence.erasing, key, fence.field, value, seconds, fence.statsId]]), 1);
  const answer = replies?.[0];
  return answer === 1 ? "kept" : answer === 0 ? "gone" : "unknown";
}
