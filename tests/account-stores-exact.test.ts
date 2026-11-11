/**
 * Rule 24 in lib/store.ts accountStores and moveAccount:
 *
 *   - accountStores: the pipeline's two replies (the account's first store and the SMEMBERS of its other stores), and
 *     the GET of each other store, are read exactly. A reply cut short or of another shape throws, never "this account
 *     has no other store": lib/closed-store-data.ts deletes a Stripe account's records and a host's calendar when no
 *     other store is listed, the billing checkout makes a second Stripe customer, and moveAccount moved only the first
 *     store and then deleted the account's list, leaving the others behind with nobody listing them;
 *   - moveAccount: the SCARD of the address moved to is a whole number or unknown, never NaN that passed as "it owns
 *     no store", which merged two accounts' stores.
 *
 * Synthetic accounts and stores only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accountStores, claimHandle, createStore, moveAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
async function answered<T>(pick: (batch: Batch) => boolean, alter: (real: unknown[]) => unknown[], run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  redis.pipeline = (async (batch: Batch) => {
    const real = await pipeline(batch);
    return pick(batch) ? alter(real) : real;
  }) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = pipeline;
  }
}

redis.clear();
const OWNER = "owner@example.com";
const fixture = (async () => {
  assert.equal((await claimHandle(OWNER, "firstshop", "First", "")).ok, true);
  for (const handle of ["secondshop", "thirdshop"]) assert.equal((await createStore(OWNER, handle, "More", "")).ok, true);
  assert.equal((await claimHandle("taken@example.com", "takenshop", "Taken", "")).ok, true);
})();

const listing = (batch: Batch) => batch.length === 2 && batch[0][0] === "GET" && batch[1][0] === "SMEMBERS";
// The two other stores' GETs, sent together after the account's list was read.
const extras = (batch: Batch) => batch.length === 2 && batch.every((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:"));

test("accountStores read exactly lists the first store and every other one", async () => {
  await fixture;
  const stores = await accountStores(OWNER);
  assert.deepEqual(stores.map((s) => s.handle), ["firstshop", "secondshop", "thirdshop"]);
});

for (const [label, alter] of [
  ["no reply", () => []],
  ["one reply of two", (r: unknown[]) => r.slice(0, 1)],
  ["the store ids as a number", (r: unknown[]) => [r[0], 7]],
  ["the store ids as null", (r: unknown[]) => [r[0], null]],
  ["a store id that is not text", (r: unknown[]) => [r[0], [...(r[1] as unknown[]), 7]]],
  ["the first store as a number", (r: unknown[]) => [7, r[1]]],
  ["the first store as text that is not a store", (r: unknown[]) => ["{not json", r[1]]],
] as [string, (r: unknown[]) => unknown[]][]) {
  test(`accountStores: the account read as ${label} throws, never fewer stores`, async () => {
    await fixture;
    const result = await answered(listing, alter, () => accountStores(OWNER));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value?.map((s) => s.handle))}`);
  });
}

for (const [label, alter] of [
  ["cut short", (r: unknown[]) => r.slice(0, -1)],
  ["a number for one store", (r: unknown[]) => [7, ...r.slice(1)]],
  ["text that is not a store", (r: unknown[]) => ["{not json", ...r.slice(1)]],
] as [string, (r: unknown[]) => unknown[]][]) {
  test(`accountStores: the other stores read as ${label} throw, never a store left out`, async () => {
    await fixture;
    const result = await answered(extras, alter, () => accountStores(OWNER));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value?.map((s) => s.handle))}`);
  });
}

test("accountStores: an id whose store is gone (GET answered null) is left out, exactly", async () => {
  await fixture;
  const result = await answered(extras, (r) => [null, ...r.slice(1)], () => accountStores(OWNER));
  assert.equal(result.error, undefined);
  assert.equal(result.value?.length, 2);
});

test("moveAccount: the account's other stores read as unknown move nothing and keep the account's list", async () => {
  await fixture;
  const result = await answered(listing, (r) => [r[0], 7], () => moveAccount(OWNER, "newhome@example.com"));
  assert.ok(result.error || (result.value && !result.value.ok), `not moved, not ${JSON.stringify(result.value)}`);
  assert.equal((await storeForEmail(OWNER))?.handle, "firstshop");
  assert.equal(await storeForEmail("newhome@example.com"), null);
  assert.deepEqual((await accountStores(OWNER)).map((s) => s.handle), ["firstshop", "secondshop", "thirdshop"]);
});

for (const [label, value] of [["text", "x"], ["null", null], ["a list", []]] as [string, unknown][]) {
  test(`moveAccount: the count of the new address's stores read as ${label} is unknown, never "it owns none"`, async () => {
    await fixture;
    const scard = (batch: Batch) => batch.length === 2 && batch[1][0] === "SCARD";
    const result = await answered(scard, (r) => [r[0], value], () => moveAccount(OWNER, "newhome@example.com"));
    assert.ok(result.error || (result.value && !result.value.ok), `not moved, not ${JSON.stringify(result.value)}`);
    assert.equal((await storeForEmail(OWNER))?.handle, "firstshop");
    assert.equal(await storeForEmail("newhome@example.com"), null);
  });
}

test("moveAccount read exactly still moves every store of the account", async () => {
  await fixture;
  const moved = await moveAccount(OWNER, "moved@example.com");
  assert.equal(moved.ok, true);
  assert.deepEqual((await accountStores("moved@example.com")).map((s) => s.handle), ["firstshop", "secondshop", "thirdshop"]);
  assert.deepEqual(await accountStores(OWNER), []);
});
