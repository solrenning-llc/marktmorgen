/**
 * A person's erasure keeps the list's row while lib/mail-clicks.ts could not
 * finish (lib/person-erasure.ts, `after`): the row's token is the only way to
 * the key their links carried (nl:mail:mk:<key>, kept 400 days), so deleting
 * the row first would leave that key behind for good. The retry deletes both.
 *
 * The failure here is a read that throws, so this holds whatever shape checks
 * lib/mail-clicks.ts makes of its own replies.
 *
 * Synthetic data only; no provider is called.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { keyIndex, linkKeyOf, rememberLinkKeys } from "@/lib/mail-clicks";
import { leadsKey } from "@/lib/contacts";
import { ERASERS, erasePerson } from "@/lib/person-erasure";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];
const EMAIL = "reader@example.test";
const TOKEN = "a".repeat(40);

const original = redis.pipeline.bind(redis);
/** Throws for the pipelines `when` picks, `times` times. */
function failing(when: (commands: Commands) => boolean, times: number): () => number {
  let hit = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (hit < times && when(commands)) {
      hit++;
      throw new Error("Redis request failed with status 503");
    }
    return original(commands);
  }) as typeof redis.pipeline;
  return () => hit;
}
const restore = () => {
  redis.pipeline = original as typeof redis.pipeline;
};

async function exists(key: string): Promise<boolean> {
  return (await redisPipeline([["EXISTS", key]]))[0] === 1;
}

test("the list's row is erased after the module that reads its token, and waits for it", () => {
  const at = (module: string) => ERASERS.findIndex((e) => e.module === module);
  assert.ok(at("lib/mail-clicks.ts") >= 0 && at("lib/contacts.ts") >= 0);
  assert.ok(at("lib/mail-clicks.ts") < at("lib/contacts.ts"), "a module can only wait for one that runs before it");
  assert.deepEqual(ERASERS.find((e) => e.module === "lib/contacts.ts")?.after, ["lib/mail-clicks.ts"]);
});

test("the erasure stays incomplete when the link use could not be erased, keeps the row, and a retry deletes the link key", async () => {
  redis.clear();
  const oldFetch = globalThis.fetch;
  const oldLog = console.error;
  globalThis.fetch = async () => {
    throw new Error("No external provider allowed");
  };
  const owner = "erasure-after-owner@example.test";
  await claimHandle(owner, "erasureafter", "Erasure After", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_ErasureAfter", subscriptionId: "sub_ErasureAfter", active: true, tier: "pro", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  const listId = shop.listId as string;
  await redisPipeline([["HSET", leadsKey(listId), EMAIL, JSON.stringify({ agreed: true, t: TOKEN })]]);
  await rememberLinkKeys([TOKEN]);
  const linkKey = keyIndex(linkKeyOf(TOKEN));
  const contactRead = (commands: Commands) => commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === leadsKey(listId);
  // Only the first read of the contact's row (lib/mail-clicks.ts's) fails.
  const hits = failing(contactRead, 1);
  console.error = () => {};
  try {
    const result = await erasePerson(shop, EMAIL, { kind: "person" });
    assert.equal(hits(), 1);
    assert.equal(result.ok, false, "an erasure that may leave the link key is never said done");
    assert.ok(!result.ok && result.reason === "incomplete");
    assert.ok(result.failed.includes("lib/mail-clicks.ts"));
    assert.ok(result.failed.includes("lib/contacts.ts"), "the list's row waits for the module that reads it");
    assert.equal(typeof (await redisPipeline([["HGET", leadsKey(listId), EMAIL]]))[0], "string", "the row, and so the token, is kept for the retry");
    assert.equal(await exists(linkKey), true);
    restore();
    const again = await erasePerson(shop, EMAIL, { kind: "person" });
    assert.equal(again.ok, true, "the same deletion finishes once the reads work");
    assert.equal(await exists(linkKey), false, "the key their links carried is gone");
    assert.equal((await redisPipeline([["HGET", leadsKey(listId), EMAIL]]))[0], null, "and so is the row");
  } finally {
    restore();
    globalThis.fetch = oldFetch;
    console.error = oldLog;
  }
});

test("control: with nothing failing, the row and the link key go in one erasure", async () => {
  redis.clear();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("No external provider allowed");
  };
  const owner = "erasure-after-control@example.test";
  try {
    await claimHandle(owner, "erasureaftercontrol", "Erasure After Control", "");
    await ensureStoreId(owner);
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setSubscription(owner, { customerId: "cus_ErasureAfterC", subscriptionId: "sub_ErasureAfterC", active: true, tier: "pro", period: paidPeriod() });
    const shop = (await storeForEmail(owner))!;
    const listId = shop.listId as string;
    await redisPipeline([["HSET", leadsKey(listId), EMAIL, JSON.stringify({ agreed: true, t: TOKEN })]]);
    await rememberLinkKeys([TOKEN]);
    const linkKey = keyIndex(linkKeyOf(TOKEN));
    const result = await erasePerson(shop, EMAIL, { kind: "person" });
    assert.equal(result.ok, true);
    assert.equal(await exists(linkKey), false);
    assert.equal((await redisPipeline([["HGET", leadsKey(listId), EMAIL]]))[0], null);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
