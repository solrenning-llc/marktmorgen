/**
 * The store page's search index is kept only while the store is live (#5010 row 130, Codex L-20261119-2133): the index,
 * nl:search:<sid>, was written with a plain SET EX after the listings were read, so a search racing the store's erasure
 * put the erased store's product index back for ten minutes. It now goes through setWhileStoreLive
 * (lib/store-live-cache.ts): nothing is kept for an erasing store and the search answers nothing; a live store is kept
 * as before. Synthetic stores; in-memory Redis.
 */
import { ERASING_KEY, addProduct, claimHandle, ensureStatsId, erasingField, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { searchIndexKey, searchStorePaid } from "@/lib/store-search-index";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const exists = (key: string) => Number(redis.run(["EXISTS", key]));
async function erasing(store: Store, on: boolean): Promise<void> {
  const field = await erasingField(storeRef(store));
  redis.run(on ? ["HSET", ERASING_KEY, field, String(Date.now())] : ["HDEL", ERASING_KEY, field]);
}

async function searchStore(): Promise<Store> {
  redis.clear();
  const owner = "search-erase@example.test";
  await claimHandle(owner, "searcherase", "Search Erase", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_searcherase01", subscriptionId: "sub_searcherase01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  // More products than the record carries, so the search reads listings and keeps an index (listingsToRead > 0).
  for (let n = 1; n <= STORE_PAGE_SIZE + 10; n += 1) {
    const made = await addProduct(owner, `Lesson ${n}`, "A synthetic lesson.", "9", null);
    if (!made.ok) throw new Error(`no product ${n}`);
  }
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  part("Row 130: a search building the index while the store is being erased keeps nothing");
  {
    const store = await searchStore();
    const key = searchIndexKey(store);
    await erasing(store, true);
    const late = await searchStorePaid(store, "lesson");
    is("the erasing store's search answers nothing (null), no matches shown", late, null);
    is("and no product index is written back", exists(key), 0);
    await erasing(store, false);
    // The first build's lock (SET NX, SEARCH_BUILD_LOCK_SECONDS) still stands; it lapses by itself, here at once.
    for (const k of redis.keys().filter((k: string) => k.startsWith("nl:search:build:"))) redis.run(["DEL", k]);
    const live = await searchStorePaid(store, "lesson");
    is("control: a live store's search finds its products and keeps the index", [live !== null && live !== "unavailable" && live.total > 0, exists(key)], [true, 1]);
  }

  part("Review of #5252: a live store whose index could not be confirmed kept still answers the search it paid for");
  {
    const store = await searchStore();
    const key = searchIndexKey(store);
    // Redis fails on the step that keeps the index (the store-cache-live fence), as an outage on a live store would.
    const pipeline = redis.pipeline.bind(redis);
    let failed = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("marktmorgen:store-cache-live"))) {
        failed += 1;
        throw new Error("synthetic Redis outage");
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    let found: Awaited<ReturnType<typeof searchStorePaid>>;
    try {
      found = await searchStorePaid(store, "lesson");
    } finally {
      redis.pipeline = pipeline;
    }
    is("the keeping step was tried and failed", failed, 1);
    is("the search still shows the matches it read and paid for", found !== null && found !== "unavailable" && found.total > 0, true);
    is("and no index is counted on", exists(key), 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
