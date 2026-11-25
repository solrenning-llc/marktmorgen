/**
 * A cache kept for a store, written only while that store is still live (Codex L-1446, G-1346 and G-1333,
 * C5-20261119-1455-defeitos21). Its value often comes from a slow provider call (a Stripe price made on the
 * creator's account), and the store's erasure can begin or end while that call is in flight: a plain SET after it
 * would write a key of an erased family back, after the closing walk may already have passed it.
 *
 * One step, the fence pattern of C5-20261119-1210-defeitos18: the store's own key must still exist and its erasing
 * mark (lib/store.ts ERASING_KEY) must be absent, then the SET. closeStoreRecord deletes the id key and the record in
 * the same fenced step as the erasing mark, so either one being gone means erased. A store kept from before ids (its
 * sid is "") has no id key: its record, under its owner's address, is the key fenced on, and only while that record
 * is still this store's own, its statsId (which never changes for a store) the one asked for. After the store is
 * erased its owner may make a new one under the same key, and that record's being there must not let the erased
 * store's late write back in (Codex X8 on #4951, X5 on #4942). A legacy store with no statsId cannot be told from
 * another: nothing is written, and the answer is unknown.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { claimValue } from "@/lib/claim-mark";
import { pushIfStoreLive, setIfStoreLive, type StoreLiveFence } from "@/lib/live-fence";
import { ERASING_KEY, STORE_ID_PATTERN, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";

/** The fence of this store (lib/live-fence.ts): its id key, or its record and statsId for a store kept from before ids. */
export async function storeLiveFence(store: Pick<Store, "email" | "sid" | "extra" | "statsId">): Promise<StoreLiveFence> {
  const ref = storeRef(store);
  const withId = STORE_ID_PATTERN.test(store.sid);
  const live = withId ? storeIdCommand(store.sid)[1] : await ownerKey(ref);
  // A store from before ids is told from its owner's next store only by its statsId: without one, nothing is known.
  const statsId = withId ? "" : store.statsId || null;
  return { live, erasing: ERASING_KEY, field: await erasingField(ref), statsId, ref };
}

/**
 * Keeps `value` under `key` for `seconds` while `store` is live: "kept"; "gone" when its erasure has begun or its
 * record is gone, and then nothing is written; "unknown" for any other answer (nothing known to be written).
 */
export async function setWhileStoreLive(store: Pick<Store, "email" | "sid" | "extra" | "statsId">, key: string, value: string, seconds: number): Promise<"kept" | "gone" | "unknown"> {
  return setIfStoreLive(await storeLiveFence(store), key, value, seconds);
}

/**
 * Pushes `value` onto the list under `key`, kept to its newest `most` lines for `seconds`, while `store` is live
 * (lib/live-fence.ts pushIfStoreLive): "kept"; "gone" when its erasure has begun or its record is gone, and then nothing
 * is written; "unknown" for any other answer.
 */
export async function pushWhileStoreLive(store: Pick<Store, "email" | "sid" | "extra" | "statsId">, key: string, value: string, most: number, seconds: number): Promise<"kept" | "gone" | "unknown"> {
  return pushIfStoreLive(await storeLiveFence(store), key, value, most, seconds);
}

// The same identity rule as SET_IF_STORE_LIVE, for a mark taken once (lib/claim-mark.ts claimMark's SET NX): a job that
// read slowly on an old Store takes its mark only while that store is still its own and not erasing, in one step, so a
// late run never recreates an erased store's family nor goes on to contact its old addresses (Codex L-20261120-1852 and
// L-20261120-1842). For a store with an id, its id key must hold this store's very ref (ARGV[5]), not only exist:
// moveAccount repoints it (Codex L-20261121-0043). -1: gone or erasing, nothing written; -2: the owner's record could
// not be read; 1: ours; 0: taken.
export const CLAIM_IF_STORE_LIVE = `-- marktmorgen:store-claim-live:v1
if redis.call("HGET", KEYS[2], ARGV[1]) then return -1 end
if ARGV[4] == "" then
  if redis.call("GET", KEYS[1]) ~= ARGV[5] then return -1 end
else
  local raw = redis.call("GET", KEYS[1])
  if not raw then return -1 end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return -2 end
  if record["statsId"] ~= ARGV[4] then return -1 end
end
local taken
if ARGV[3] == "" then taken = redis.call("SET", KEYS[3], ARGV[2], "NX") else taken = redis.call("SET", KEYS[3], ARGV[2], "NX", "EX", ARGV[3]) end
if taken then return 1 end
return 0`;

/**
 * Takes `key` for `seconds` with a value of its own, as claimMark does, but only while `store` is live: "ours" when it
 * was taken now; "taken" when someone holds it already; "gone" when the store's erasure has begun or its record is gone
 * (nothing written); "unknown" for any other answer. A lost answer is read back by the value, as claimMark does, so a
 * mark this run did take is never sent twice and never taken for someone else's. `seconds` null keeps the mark for
 * good, as claimMark(key, null) does (an empty ARGV[3]; Codex L-20261120-1745, lib/yearly-offer.ts).
 */
export async function claimWhileStoreLive(store: Pick<Store, "email" | "sid" | "extra" | "statsId">, key: string, seconds: number | null, value = claimValue()): Promise<"ours" | "taken" | "gone" | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  const ref = storeRef(store);
  const withId = STORE_ID_PATTERN.test(store.sid);
  const statsId = store.statsId ?? "";
  if (!withId && !statsId) return "unknown";
  const live = withId ? storeIdCommand(store.sid)[1] : await ownerKey(ref);
  try {
    const answer = repliesFor(await redisPipeline([
      ["EVAL", CLAIM_IF_STORE_LIVE, 3, live, ERASING_KEY, key, await erasingField(ref), value, seconds ?? "", withId ? "" : statsId, ref],
    ]), 1)?.[0];
    if (answer === 1) return "ours";
    if (answer === 0) return "taken";
    if (answer === -1) return "gone";
    if (answer === -2) return "unknown";
  } catch {
    // Read back below: the script may have run.
  }
  try {
    const held = repliesFor(await redisPipeline([["GET", key]]), 1)?.[0];
    if (held === value) return "ours";
    if (typeof held === "string") return "taken";
  } catch {
    // Unknown below.
  }
  return "unknown";
}
