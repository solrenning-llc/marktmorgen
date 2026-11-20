/**
 * A cache kept for a store, written only while that store is still live (Codex L-1446, G-1346 and G-1333,
 * C5-20261119-1455-defeitos21). Its value often comes from a slow provider call (a Stripe price made on the
 * creator's account), and the store's erasure can begin or end while that call is in flight: a plain SET after it
 * would write a key of an erased family back, after the closing walk may already have passed it.
 *
 * One step, the fence pattern of C5-20261119-1210-defeitos18: the store's own key must still exist and its erasing
 * mark (lib/store.ts ERASING_KEY) must be absent, then the SET. closeStoreRecord deletes the id key and the record in
 * the same fenced step as the erasing mark, so either one being gone means erased. A store kept from before ids (its
 * sid is "") has no id key: its record, under its owner's address, is the key fenced on.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { ERASING_KEY, STORE_ID_PATTERN, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";

const SET_IF_STORE_LIVE = `-- marktmorgen:store-cache-live:v1
if redis.call("EXISTS", KEYS[1]) ~= 1 or redis.call("HGET", KEYS[2], ARGV[1]) then return 0 end
redis.call("SET", KEYS[3], ARGV[2], "EX", ARGV[3])
return 1`;

/**
 * Keeps `value` under `key` for `seconds` while `store` is live: "kept"; "gone" when its erasure has begun or its
 * record is gone, and then nothing is written; "unknown" for any other answer (nothing known to be written).
 */
export async function setWhileStoreLive(store: Pick<Store, "email" | "sid" | "extra">, key: string, value: string, seconds: number): Promise<"kept" | "gone" | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  const ref = storeRef(store);
  const live = STORE_ID_PATTERN.test(store.sid) ? storeIdCommand(store.sid)[1] : await ownerKey(ref);
  const replies = repliesFor(await redisPipeline([
    ["EVAL", SET_IF_STORE_LIVE, 3, live, ERASING_KEY, key, await erasingField(ref), value, seconds],
  ]), 1);
  const answer = replies?.[0];
  return answer === 1 ? "kept" : answer === 0 ? "gone" : "unknown";
}
