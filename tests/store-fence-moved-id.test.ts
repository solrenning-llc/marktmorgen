// A store with an id is live for a fenced write only while its id key still holds this store's own ref (Claude 2's
// MEDIUM on #4937, 7058724674; the rule of store-claim-live:v1 on #5007): moveAccount repoints nl:store:id:<sid> to
// the new ref, and the store's erasure then marks the new ref's field, so a fence built under the old ref must not
// let a late write land on EXISTS alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { reserveStorage } from "@/lib/storage-reservations";
import { setIfStoreLive } from "@/lib/live-fence";
import { ERASING_KEY, erasingField } from "@/lib/store";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const LIVE = "nl:store:id:s_movedstore";
const OLD = "old-owner@example.com";
const NEW = "new-owner@example.com";
const folder = "c".repeat(32);
const row = async () => (await redis.pipeline([["GET", "nl:storage:pending:" + folder]]))[0];

async function moved(): Promise<{ live: string; erasing: string; field: string; statsId: string; ref: string }> {
  redis.clear();
  // The fence was built at the open, under the old ref; then the account moved and the erasure began under the new.
  const fence = { live: LIVE, erasing: ERASING_KEY, field: await erasingField(OLD), statsId: "", ref: OLD };
  await redis.pipeline([["SET", LIVE, NEW], ["HSET", ERASING_KEY, await erasingField(NEW), String(Date.now())]]);
  return fence;
}

test("moved account, erasure under the new ref: the store cache's late write is refused", async () => {
  const fence = await moved();
  assert.equal(await setIfStoreLive(fence, "nl:test:cache:moved", "x", 60), "gone");
  assert.equal((await redis.pipeline([["GET", "nl:test:cache:moved"]]))[0], null);
});

test("moved account, erasure under the new ref: the storage row is not written back", async () => {
  const fence = await moved();
  await assert.rejects(reserveStorage(folder, 10, 100, async () => 0, fence), /storage_store_gone/);
  assert.equal(await row(), null);
});

test("control: the id key holds this store's ref, nothing erasing: both writes land", async () => {
  redis.clear();
  const fence = { live: LIVE, erasing: ERASING_KEY, field: await erasingField(OLD), statsId: "", ref: OLD };
  await redis.pipeline([["SET", LIVE, OLD]]);
  assert.equal(await setIfStoreLive(fence, "nl:test:cache:moved", "x", 60), "kept");
  assert.equal((await reserveStorage(folder, 10, 100, async () => 0, fence)).bytes, 10);
  assert.notEqual(await row(), null);
});
