/**
 * Two key uploads at once never take a product's pool past MAX_POOL_KEYS (Claude 7's race hunt).
 *
 * addKeys read the pool's length once (LLEN), worked out the room left, and pushed that many keys several round trips
 * later. Two uploads of the same product at once (two tabs, a double click) both read the same length, both took the
 * same room, and both pushed: the pool ended past its bound by up to one upload. The room is now read and taken in the
 * same script as the push, so the second upload finds it gone and its keys are left out (overflow), given back to the
 * key record and the store's data room as before.
 *
 * Real MemoryRedis; the pool is filled to one short of the bound with synthetic keys.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { addKeys, MAX_POOL_KEYS } from "@/lib/licence-keys";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@keyrace.example";
process.env.STRIPE_SECRET_KEY = "sk_test_key_race_only_a_stand_in";

async function setUp() {
  redis.clear();
  await claimHandle(OWNER, "keyrace", "Key Race", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKeyRace001", true);
  await setSubscription(OWNER, { customerId: "cus_KeyRace00001", subscriptionId: "sub_KeyRace00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Plugin", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/plugin");
  assert.ok((await setProductKeys(OWNER, made.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 })).ok);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, made.product.id))!;
  const pool = `nl:keys:${store.statsId}:${product.id}:pool`;
  // One short of the bound, written straight to the pool (the record of every key is not needed for the length).
  const seed = Array.from({ length: MAX_POOL_KEYS - 1 }, (_, i) => `SEED-${String(i).padStart(5, "0")}-KEYS`);
  redis.run(["RPUSH", pool, ...seed]);
  return { store, product, pool };
}
const key = (tab: string, i: number) => `${tab}${String(i).padStart(3, "0")}-ABCD-EFGH-JKLM`;

test("two uploads at once leave the pool at its bound, the rest left out", async () => {
  const { store, product, pool } = await setUp();
  const [a, b] = await Promise.all([
    addKeys(store, product, [key("AAA", 1), key("AAA", 2)]),
    addKeys(store, product, [key("BBB", 1), key("BBB", 2)]),
  ]);
  assert.equal(redis.run(["LLEN", pool]), MAX_POOL_KEYS, "the pool stops at its bound");
  assert.equal(a.added + b.added, 1, "one key fitted");
  assert.equal(a.overflow + b.overflow, 3, "the others are left out and said so");
});

test("control: one upload fills the room left and leaves the rest out", async () => {
  const { store, product, pool } = await setUp();
  const result = await addKeys(store, product, [key("CCC", 1), key("CCC", 2)]);
  assert.equal(result.added, 1);
  assert.equal(result.overflow, 1);
  assert.equal(redis.run(["LLEN", pool]), MAX_POOL_KEYS);
});
