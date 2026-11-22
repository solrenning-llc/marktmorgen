/**
 * A store's fence for a write that can land after its erasure began (C5-20261119-1210-defeitos18): the store's own
 * key must still exist and its erasing mark (lib/store.ts ERASING_KEY) must be absent, read in the same step as the
 * write. closeStoreRecord deletes the id key and the record in the same fenced step as the erasing mark, so either one
 * being gone means erased. A store kept from before ids (its sid is "") has no id key: its record, under its owner's
 * address, is the key fenced on, and only while that record is still this store's own, its statsId (which never
 * changes for a store) the one asked for. After the store is erased its owner may make a new one under the same key,
 * and that record's being there must not let the erased store's late write back in (Codex X8 on #4951, X5 on #4942).
 * A legacy store with no statsId cannot be told from another: nothing is written, and the answer is unknown. A store
 * with an id is live only while its id key still holds this store's own ref: moveAccount repoints that key to the new
 * ref, and an erasure begun after a move marks the new ref's field, so EXISTS alone would let a fence built under the
 * old ref write (Claude 2 on #4937, 7058724674; the rule of store-claim-live:v1).
 * Kept apart from lib/store.ts so a module that writes for a store (lib/vault.ts, lib/storage-reservations.ts) takes
 * the fence without importing the store module; lib/store-live-cache.ts builds it for a store.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

/** The keys of one store's fence: its live key (its id key, or its record for a store from before ids), the erasing
 * hash and the store's field in it, the statsId its record must carry ("" for a store with an id, whose id key must
 * hold `ref`; null for a store from before ids with none: it cannot be told from another, unknown) and the store's
 * ref the fence was built under. */
export type StoreLiveFence = { live: string; erasing: string; field: string; statsId: string | null; ref: string };

// ARGV[4] is "" for a store with an id (its id key must hold ARGV[5], the store's ref); for one from before ids it is
// the store's statsId, compared with the record's own. A record that does not parse is unknown (-1), never this store.
export const SET_IF_STORE_LIVE = `-- marktmorgen:store-cache-live:v3
if redis.call("HGET", KEYS[2], ARGV[1]) then return 0 end
if ARGV[4] == "" then
  if redis.call("GET", KEYS[1]) ~= ARGV[5] then return 0 end
else
  local raw = redis.call("GET", KEYS[1])
  if not raw then return 0 end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return -1 end
  if record["statsId"] ~= ARGV[4] then return 0 end
end
redis.call("SET", KEYS[3], ARGV[2], "EX", ARGV[3])
return 1`;

// The same identity rule, for a count of the month (lib/review-proof.ts, the rows handled and the payments marked):
// INCRBY by ARGV[2] and EXPIRE ARGV[3], only while the store is live, the count after it answered. 0: gone or erasing,
// nothing written (a count is never 0 after an INCRBY of at least one on a count never below zero); -1: the owner's
// record could not be read (10th triple audit on #5092, LEVE 5).
export const COUNT_IF_STORE_LIVE = `-- marktmorgen:store-count-live:v1
if redis.call("HGET", KEYS[2], ARGV[1]) then return 0 end
if ARGV[4] == "" then
  if redis.call("GET", KEYS[1]) ~= ARGV[5] then return 0 end
else
  local raw = redis.call("GET", KEYS[1])
  if not raw then return 0 end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return -1 end
  if record["statsId"] ~= ARGV[4] then return 0 end
end
local count = redis.call("INCRBY", KEYS[3], tonumber(ARGV[2]))
redis.call("EXPIRE", KEYS[3], ARGV[3])
return count`;

/**
 * Keeps `value` under `key` for `seconds` while the fenced store is live: "kept"; "gone" when its erasure has begun or
 * its record is gone, and then nothing is written; "unknown" for any other answer (nothing known to be written).
 */
export async function setIfStoreLive(fence: StoreLiveFence, key: string, value: string, seconds: number): Promise<"kept" | "gone" | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  if (fence.statsId === null) return "unknown";
  const replies = repliesFor(await redisPipeline([["EVAL", SET_IF_STORE_LIVE, 3, fence.live, fence.erasing, key, fence.field, value, seconds, fence.statsId, fence.ref]]), 1);
  const answer = replies?.[0];
  return answer === 1 ? "kept" : answer === 0 ? "gone" : "unknown";
}

/** One command of a fenced step: a key is written as `{ key }`, so the step declares every key it touches. */
export type FencedCommand = (string | number | { key: string })[];

// The same identity rule as SET_IF_STORE_LIVE, for several writes made together only while the store is live: the
// review a refund sweep marks, with its indexes and the product's numbers (lib/reviews.ts creatorChange; Codex
// L-20261120-0838). ARGV[4] lists the commands as JSON; an argument written as {"k": n} stands for KEYS[n], so every
// key the step touches is declared (KEYS[1] and KEYS[2] are the fence's, the commands' keys follow). 0: gone or
// erasing, nothing written; -1: the owner's record could not be read, nothing written; 1: every command ran.
export const WRITE_IF_STORE_LIVE = `-- marktmorgen:store-write-live:v1
if redis.call("HGET", KEYS[2], ARGV[1]) then return 0 end
if ARGV[2] == "" then
  if redis.call("GET", KEYS[1]) ~= ARGV[3] then return 0 end
else
  local raw = redis.call("GET", KEYS[1])
  if not raw then return 0 end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return -1 end
  if record["statsId"] ~= ARGV[2] then return 0 end
end
for _, command in ipairs(cjson.decode(ARGV[4])) do
  for i, part in ipairs(command) do
    if type(part) == "table" then command[i] = KEYS[part["k"]] end
  end
  redis.call(unpack(command))
end
return 1`;

/**
 * Runs `commands` together, in one step, while the fenced store is live: "kept"; "gone" when its erasure has begun
 * or its record is gone, and then nothing is written; "unknown" for any other answer (nothing known to be written).
 * Billed as one command plus the fence's two reads plus one for each command.
 */
export async function writeIfStoreLive(fence: StoreLiveFence, commands: FencedCommand[]): Promise<"kept" | "gone" | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  if (fence.statsId === null) return "unknown";
  const keys: string[] = [];
  const encoded = commands.map((command) =>
    command.map((part) => {
      if (typeof part !== "object") return part;
      let at = keys.indexOf(part.key);
      if (at < 0) at = keys.push(part.key) - 1;
      return { k: at + 3 };
    }),
  );
  const replies = repliesFor(
    await redisPipeline([["EVAL", WRITE_IF_STORE_LIVE, 2 + keys.length, fence.live, fence.erasing, ...keys, fence.field, fence.statsId, fence.ref, JSON.stringify(encoded)]]),
    1,
  );
  const answer = replies?.[0];
  return answer === 1 ? "kept" : answer === 0 ? "gone" : "unknown";
}

/**
 * Adds `n` (at least one) to the count under `key`, kept `seconds`, while the fenced store is live: the count after it;
 * "gone" when its erasure has begun or its record is gone, and then nothing is written; "unknown" for any other
 * answer (nothing known to be written).
 */
export async function countIfStoreLive(fence: StoreLiveFence, key: string, n: number, seconds: number): Promise<number | "gone" | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  if (fence.statsId === null) return "unknown";
  if (!Number.isSafeInteger(n) || n < 1) return "unknown";
  const replies = repliesFor(await redisPipeline([["EVAL", COUNT_IF_STORE_LIVE, 3, fence.live, fence.erasing, key, fence.field, n, seconds, fence.statsId, fence.ref]]), 1);
  const answer = replies?.[0];
  const count = typeof answer === "number" ? answer : typeof answer === "string" && /^-?\d+$/.test(answer) ? Number(answer) : null;
  if (count === null || !Number.isSafeInteger(count)) return "unknown";
  return count === 0 ? "gone" : count < 0 ? "unknown" : count;
}
