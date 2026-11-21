/**
 * Every paid plan holds the 2,000 products the site promises (MAX_PRODUCTS), each at its largest title and summary
 * (C1-20261117, 2,000 products on every plan). Until then a product took its worst page reading and side records
 * from the store's data room, 21,152 bytes, so a Store plan was full at 679 products. Synthetic stores only.
 */
import { addProduct, claimHandle, ensureStatsId, removeProduct, setSubscription, storeForEmail, StoreFullError } from "@/lib/store";
import { MAX_PRODUCTS, MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH } from "@/lib/catalog";
import * as rules from "@/lib/store-data-rules";
import * as data from "@/lib/store-data";
import type { Tier } from "@/lib/plan";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is } from "./check";

// Read through the modules, so this file also runs, and fails on what it saves, where the pool does not exist yet.
const { contentRoomFor } = rules;
const { dataUsed } = data;
const BESIDE_POOL_BYTES = (rules as { BESIDE_POOL_BYTES?: number }).BESIDE_POOL_BYTES ?? 0;
const besideKey = (store: Parameters<typeof data.dataKey>[0]) => (data as { besideKey?: typeof data.dataKey }).besideKey?.(store) ?? "nl:none";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  for (const tier of ["creator", "pro", "scale"] as Tier[]) {
    redis.clear();
    const owner = `fit-${tier}@example.com`;
    await claimHandle(owner, `fit${tier}`, "Fit Shop", "");
    await setSubscription(owner, { customerId: "cus_Fit0000001", subscriptionId: "sub_Fit0000001", active: true, tier, trialEnds: 0, period: paidPeriod() });
    await ensureStatsId(owner);
    let saved = 0;
    let first = "";
    for (let n = 0; n < MAX_PRODUCTS; n += 1) {
      const tag = String(n).padStart(5, "0");
      let made;
      try {
        made = await addProduct(owner, `Product ${tag} `.padEnd(MAX_TITLE_LENGTH, "t"), `Summary ${tag} `.padEnd(MAX_SUMMARY_LENGTH, "s"), "999.99");
      } catch (error) {
        if (error instanceof StoreFullError) break;
        throw error;
      }
      if (!made?.ok) break;
      if (n === 0) first = made.product.id;
      saved += 1;
    }
    const store = (await storeForEmail(owner))!;
    console.log(`  (${tier}: ${saved} products saved)`);
    is(`a ${tier} store with ${MAX_PRODUCTS.toLocaleString("en-US")} products at their largest saves every one`, saved, MAX_PRODUCTS);
    is(`and its index lists them all (${tier})`, store.catalog.items.length, MAX_PRODUCTS);
    const used = await dataUsed(store);
    is(`what it keeps stays inside its room for what it keeps (${tier})`, used !== null && used.used <= contentRoomFor(store), true);
    const [pool] = await redisPipeline([["HGET", besideKey(store)!, "#"]]);
    is(`and the pool beside its products stays inside its ceiling (${tier})`, Number(pool) > 0 && Number(pool) <= BESIDE_POOL_BYTES, true);
    // A deletion never makes the room fuller, and the product's share stays held in the pool as it stayed in the room.
    const removed = await removeProduct(owner, first);
    const after = await dataUsed((await storeForEmail(owner))!);
    const [poolAfter] = await redisPipeline([["HGET", besideKey(store)!, "#"]]);
    is(`deleting a product gives back its room and keeps its share held (${tier})`, [Boolean(removed?.ok), after !== null && used !== null && after.used < used.used, Number(poolAfter) === Number(pool)], [true, true, true]);
    // The pool is full of 2,000 shares, one of them a deleted product's: the next product's share is counted in the
    // room, as every product's was before, and the pool never passes its ceiling.
    const next = await addProduct(owner, "One more", "After a deletion.", "5");
    const roomNext = await dataUsed((await storeForEmail(owner))!);
    const [poolNext] = await redisPipeline([["HGET", besideKey(store)!, "#"]]);
    is(`with the pool full, a new product is counted whole in the room (${tier})`, [next.ok, roomNext !== null && after !== null && roomNext.used - after.used >= 19_936, Number(poolNext) === Number(pool)], [true, true, true]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
