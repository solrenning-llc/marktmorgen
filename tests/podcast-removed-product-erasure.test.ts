/**
 * A removed product's private podcast feeds never outlive a person's deletion (nuvem I privacy audit of main
 * @3cdc624a7d, 13 November 2026, ALTO).
 *
 * A feed's grant (nl:pod:t:<sha>) holds the listener's address in plain text, kept for good, found only through
 * its index (nl:pod:by:<sid>:<pid>:<hash>). Removing the product dropped neither, and deleting a person went only
 * over the products still in the catalog: the erasure answered done with the address kept, while the feed itself
 * answered "no longer here" (410) to everyone.
 *
 * Now each new grant also notes its product in the store's set (nl:pod:pids:<sid>), in the same counted write as
 * its index, and a person's deletion (and the copy of their data) goes over the catalog and that set, read exactly
 * (unreadable: the deletion is not finished). A removed product stays in the set, so its feeds stay within reach
 * of every deletion and of the walk at store closing. Grants made before this change for a product removed before
 * it are reached only by that walk (known limit).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { erasePerson } from "@/lib/person-erasure";
import * as access from "@/lib/podcast-access";
import { CLOSING, COUNTED_FAMILIES } from "@/lib/data-families";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, removeProduct, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const owner = "podcast-removed-owner@example.test";
const person = "podcast-removed-person@example.test";
const other = "podcast-removed-other@example.test";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const grantKey = (token: string) => `nl:pod:t:${sha(token)}`;

async function world() {
  redis.clear();
  await claimHandle(owner, "podremoved", "Podcast Removed", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_PodRemoved", subscriptionId: "sub_PodRemoved", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic podcast", "", "27", null);
  assert.ok(made.ok);
  const shop = (await storeForEmail(owner))!;
  const pid = made.product.id;
  const mine = await access.feedToken(shop, pid, person);
  const theirs = await access.feedToken(shop, pid, other);
  assert.ok(mine && theirs, "both listeners have a feed");
  return { sid: shop.statsId!, pid, mine, theirs };
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const oldFetch = globalThis.fetch, oldLog = console.error;
  globalThis.fetch = async () => { throw new Error("No external provider allowed"); };
  console.error = () => {};
  try { return await run(); } finally { globalThis.fetch = oldFetch; console.error = oldLog; }
}

test("a feed of a product removed before is still reached by a person's deletion", () => quietly(async () => {
  const { sid, pid, mine, theirs } = await world();
  const removed = await removeProduct(owner, pid);
  assert.ok(removed.ok);
  const shop = (await storeForEmail(owner))!;
  assert.equal(shop.catalog.items.some((item) => item.id === pid), false);
  const result = await erasePerson(shop, person, { kind: "person" });
  assert.equal(result.ok, true);
  assert.equal(redis.run(["GET", grantKey(mine)]), null, "the person's grant, with their address, is gone");
  assert.notEqual(redis.run(["GET", grantKey(theirs)]), null, "another listener's grant stays");
  assert.equal(redis.run(["SISMEMBER", `nl:pod:pids:${sid}`, pid]), 1, "the removed product stays noted for the next deletion");
}));

test("an unreadable set of podcast products leaves the deletion unfinished, never done", () => quietly(async () => {
  const { pid } = await world();
  await removeProduct(owner, pid);
  const shop = (await storeForEmail(owner))!;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:pod:pids:"))) return [{ garbled: true }];
    return original(commands);
  };
  try {
    const result = await erasePerson(shop, person, { kind: "person" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === "incomplete" && result.failed.includes("lib/podcast-access.ts"));
  } finally { redis.pipeline = original; }
}));

test("the new family is counted and erased when a store closes", () => {
  for (const family of ["nl:pod:pids:"]) {
    assert.ok(COUNTED_FAMILIES.includes(family), `${family} is counted`);
    assert.deepEqual(CLOSING[family], { how: "erase" }, `${family} is erased at closing`);
  }
});
