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
import { setIfStoreLive, type StoreLiveFence } from "@/lib/live-fence";
import { ERASING_KEY, STORE_ID_PATTERN, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";

/** The fence of this store (lib/live-fence.ts): its id key, or its record and statsId for a store kept from before ids. */
export async function storeLiveFence(store: Pick<Store, "email" | "sid" | "extra" | "statsId">): Promise<StoreLiveFence> {
  const ref = storeRef(store);
  const withId = STORE_ID_PATTERN.test(store.sid);
  const live = withId ? storeIdCommand(store.sid)[1] : await ownerKey(ref);
  // A store from before ids is told from its owner's next store only by its statsId: without one, nothing is known.
  const statsId = withId ? "" : store.statsId || null;
  return { live, erasing: ERASING_KEY, field: await erasingField(ref), statsId };
}

/**
 * Keeps `value` under `key` for `seconds` while `store` is live: "kept"; "gone" when its erasure has begun or its
 * record is gone, and then nothing is written; "unknown" for any other answer (nothing known to be written).
 */
export async function setWhileStoreLive(store: Pick<Store, "email" | "sid" | "extra" | "statsId">, key: string, value: string, seconds: number): Promise<"kept" | "gone" | "unknown"> {
  return setIfStoreLive(await storeLiveFence(store), key, value, seconds);
}
