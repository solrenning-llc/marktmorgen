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
import { UnknownReplyError, replyList, repliesFor } from "@/lib/redis-reply";
import { ERASING_KEY, STORE_ID_PATTERN, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";

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

/**
 * KEEP_UNLESS_ERASED (lib/suppression.ts) behind the store fence, in one step (Codex L-20261119-2235): a copy naming
 * people kept only while the store is live and nobody it names was deleted from it. KEYS[1] the store's own key,
 * KEYS[2] the erasing marks, KEYS[3] the copy, KEYS[4] the store's prints; ARGV[1] the store's erasing field,
 * ARGV[2] the copy, ARGV[3] its seconds, ARGV[4..] the prints of who it names (at least one). The store gone or
 * erasing: the copy goes and {0} is answered, never a place. Otherwise as KEEP_UNLESS_ERASED. Billed 2 more than it
 * (EXISTS, HGET). lib/redis-memory.ts runs it the same way. Used for the kept readings (lib/store-readings.ts,
 * READING_COPY_LIVE), the memberships' cache (lib/membership-numbers.ts) and the members' health copy
 * (lib/member-health.ts).
 */
export const KEEP_UNLESS_ERASED_LIVE = `-- marktmorgen:reading-copy-live:v1
if redis.call("EXISTS", KEYS[1]) ~= 1 or redis.call("HGET", KEYS[2], ARGV[1]) then
  redis.call("DEL", KEYS[3])
  return {0}
end
local found = redis.call("HMGET", KEYS[4], unpack(ARGV, 4))
local gone = {}
for i = 1, #found do
  if found[i] then gone[#gone + 1] = i end
end
if #gone > 0 then
  redis.call("DEL", KEYS[3])
  return gone
end
redis.call("SET", KEYS[3], ARGV[2], "EX", ARGV[3])
return gone`;

/**
 * Keeps `text` at `key` for `seconds` while `store` is live and unless one of `emails` (at least one) was deleted
 * from it (KEEP_UNLESS_ERASED_LIVE): returns who cannot be kept, and then nothing is kept; every one of them when
 * the store is gone or being erased. Throws when the step cannot run or its reply is not {0} or a list of places
 * among them: the caller keeps nothing.
 */
export async function keepUnlessErasedWhileLive(store: Pick<Store, "email" | "sid" | "extra">, key: string, listId: string, text: string, seconds: number, emails: string[]): Promise<Set<string>> {
  const names = [...new Set(emails)];
  if (!names.length) throw new Error("nobody to look up");
  const ref = storeRef(store);
  const live = STORE_ID_PATTERN.test(store.sid) ? storeIdCommand(store.sid)[1] : await ownerKey(ref);
  const replies = repliesFor(await redisPipeline([
    ["EVAL", KEEP_UNLESS_ERASED_LIVE, 4, live, ERASING_KEY, key, suppressedKey(listId), await erasingField(ref), text, seconds, ...names.map((e) => suppressionPrint(listId, e))],
  ]), 1);
  // Each place read from the list's own slots: a hole is not a place (Array#every would skip it).
  const places = replies ? replyList(replies[0]) : null;
  if (places && places.length === 1 && places[0] === 0) return new Set(names);
  if (!places || !places.every((i) => Number.isSafeInteger(i) && (i as number) >= 1 && (i as number) <= names.length)) {
    throw new UnknownReplyError("the check of a copy where it is kept, behind the store's fence");
  }
  return new Set((places as number[]).map((i) => names[i - 1]));
}
