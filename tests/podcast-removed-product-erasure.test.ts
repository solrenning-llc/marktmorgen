/**
 * A removed product's private podcast feeds never outlive a person's deletion (nuvem I privacy audit of main
 * @3cdc624a7d, 13 November 2026, ALTO).
 *
 * A feed's grant (nl:pod:t:<sha>) holds the listener's address in plain text, kept for good, found only through
 * its index (nl:pod:by:<sid>:<pid>:<hash>). Removing the product dropped neither, and deleting a person went only
 * over the products still in the catalog: the erasure answered done with the address kept, while the feed itself
 * answered "no longer here" (410) to everyone.
 *
 * Now each grant also notes its product in the store's set (nl:pod:pids:<sid>) and its listener in the product's
 * holders (nl:pod:h:<sid>:<pid>), in the same counted write. A person's deletion goes over the catalog and that
 * set, read exactly (unreadable: the deletion is not finished). Removing a product deletes its grants through its
 * holders, and takes the product out of the set only once they are gone. Grants made before this change for a
 * product removed before it are reached only by the walk at store closing (known limit).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  assert.equal(redis.run(["SCARD", `nl:pod:h:${sid}:${pid}`]), 1, "and only the other listener is left in the product's holders");
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

test("removing a product deletes every feed of it, then takes it out of the store's set", () => quietly(async () => {
  const { sid, pid, mine, theirs } = await world();
  const drop = (access as Record<string, unknown>).dropPodcastFeeds;
  assert.equal(typeof drop, "function", "lib/podcast-access.ts has dropPodcastFeeds");
  await (drop as (sid: string, pid: string) => Promise<void>)(sid, pid);
  for (const token of [mine, theirs]) assert.equal(redis.run(["GET", grantKey(token)]), null);
  assert.equal(redis.run(["EXISTS", `nl:pod:h:${sid}:${pid}`]), 0);
  assert.equal(redis.run(["SISMEMBER", `nl:pod:pids:${sid}`, pid]), 0);
  const left = (redis.run(["KEYS", `nl:pod:by:${sid}:${pid}:*`]) as string[]) ?? [];
  assert.deepEqual(left, [], "no index is left");
}));

test("the product route drops the feeds when it removes a product", () => {
  assert.match(readFileSync("app/api/store/product/route.ts", "utf8"), /dropPodcastFeeds\(removed\.store\.statsId, id\)/);
});

test("the two new families are counted and erased when a store closes", () => {
  for (const family of ["nl:pod:pids:", "nl:pod:h:"]) {
    assert.ok(COUNTED_FAMILIES.includes(family), `${family} is counted`);
    assert.deepEqual(CLOSING[family], { how: "erase" }, `${family} is erased at closing`);
  }
});
