/**
 * A removed product's waitlist never outlives a person's deletion (nuvem I privacy audit of main @3cdc624a7d,
 * 13 November 2026, ALTO).
 *
 * A waitlist (lib/waitlist.ts) keeps each address in plain text, with no expiry, under the product's id. Removing
 * the product (app/api/store/product/route.ts, action "remove") dropped its page, reviews and files but not its
 * waitlist, and deleting a person (lib/person-erasure.ts) went only over the products still in the catalog. So
 * "Delete this person", and the person's own deletion, answered done while the address stayed on the waitlist
 * of a product removed before, until the whole store closed.
 *
 * Now removing a product drops its waitlist, and a deletion also goes over every product still marked coming
 * soon, which reaches a waitlist left by a product removed before this change (removal never unmarked it).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { erasePerson } from "@/lib/person-erasure";
import * as waitlist from "@/lib/waitlist";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, removeProduct, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const owner = "waitlist-removed-owner@example.test";
const person = "waitlist-removed-person@example.test";
const other = "waitlist-removed-other@example.test";

async function world() {
  redis.clear();
  await claimHandle(owner, "wlremoved", "Waitlist Removed", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_WlRemoved", subscriptionId: "sub_WlRemoved", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic coming soon", "", "27", null);
  assert.ok(made.ok);
  const shop = (await storeForEmail(owner))!;
  const sid = shop.statsId!;
  const pid = made.product.id;
  await waitlist.setSoon(shop, pid, true);
  const entry = (at: number) => JSON.stringify({ at, ok: at, c: false, t: "0".repeat(48) });
  redis.run(["HSET", `nl:wl:${sid}:${pid}`, person, entry(1), other, entry(2)]);
  redis.run(["RPUSH", `nl:wl:${sid}:${pid}:send`, person, other]);
  return { sid, pid };
}

test("a waitlist left by a product removed before is still reached by a person's deletion", async () => {
  const oldFetch = globalThis.fetch, oldLog = console.error;
  globalThis.fetch = async () => { throw new Error("No external provider allowed"); };
  console.error = () => {};
  try {
    const { sid, pid } = await world();
    // The product goes the old way, without its waitlist: the store's record no longer lists it.
    const removed = await removeProduct(owner, pid);
    assert.ok(removed.ok);
    const shop = (await storeForEmail(owner))!;
    assert.equal(shop.catalog.items.some((item) => item.id === pid), false);
    const result = await erasePerson(shop, person, { kind: "person" });
    assert.equal(result.ok, true);
    assert.equal(redis.run(["HGET", `nl:wl:${sid}:${pid}`, person]), null, "the person's place is gone");
    assert.equal(redis.run(["HGET", `nl:wl:${sid}:${pid}`, other]) !== null, true, "another person's place stays");
    assert.equal((redis.run(["LRANGE", `nl:wl:${sid}:${pid}:send`, 0, -1]) as string[]).includes(person), false, "and out of the launch email");
  } finally { globalThis.fetch = oldFetch; console.error = oldLog; }
});

test("removing a product drops its waitlist, its launch list and job, and its coming-soon mark", async () => {
  const { sid, pid } = await world();
  redis.run(["SET", `nl:wl:${sid}:${pid}:job`, "{}"]);
  redis.run(["SADD", "nl:wl:jobs", `${sid}|${pid}`, `${sid}|another`]);
  const drop = (waitlist as Record<string, unknown>).dropWaitlist;
  assert.equal(typeof drop, "function", "lib/waitlist.ts has dropWaitlist");
  await (drop as (sid: string, pid: string) => Promise<void>)(sid, pid);
  assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}`]), 0);
  assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}:send`]), 0);
  assert.equal(redis.run(["EXISTS", `nl:wl:${sid}:${pid}:job`]), 0);
  assert.equal(redis.run(["SISMEMBER", `nl:wl:${sid}:soon`, pid]), 0);
  assert.deepEqual(redis.run(["SMEMBERS", "nl:wl:jobs"]), [`${sid}|another`], "another product's launch stays");
});

test("the product route drops the waitlist when it removes a product", () => {
  const route = readFileSync("app/api/store/product/route.ts", "utf8");
  assert.match(route, /dropWaitlist\(removed\.store\.statsId, id\)/);
});
