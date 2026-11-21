/**
 * A synthetic store marked live where lib/paypal-payouts.ts's link fence looks for it (KEEP_LINK_IF_LIVE: its id
 * key, or for a store from before ids, sid "", its record under its owner), so connectPayPal keeps the link of a
 * store a test made by hand instead of through claimHandle; a store from before ids gets a record carrying its statsId,
 * as a real record does, which the open-batch fence compares (KEEP_OPEN_IF_LIVE v3). A store made by hand with no owner address is given a
 * synthetic one, as every real store has. A key already there is left as it is.
 */
import { ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

export async function markLive(store: Pick<Store, "email" | "sid" | "extra"> & { statsId?: string | null }): Promise<void> {
  // A store made by hand often has no owner address; the fence names the store by it (storeRef), as every real store has.
  if (typeof store.email !== "string" || !store.email) (store as { email: string }).email = `owner-${store.sid || "legacy"}@example.com`;
  const key = store.sid ? storeIdCommand(store.sid)[1] : await ownerKey(storeRef(store));
  // A store from before ids is told from its owner's next store by its record's statsId (KEEP_OPEN_IF_LIVE v3).
  if (redis.run(["EXISTS", key]) !== 1) redis.run(["SET", key, store.sid ? storeRef(store) : !store.statsId ? "{}" : JSON.stringify({ statsId: store.statsId })]);
}
