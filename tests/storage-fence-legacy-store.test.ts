// A store from before ids is fenced on its owner's record only while that record carries its statsId (Codex X8 on
// #4951, X5 on #4942, brought to the storage rows by Claude 2's review of #4937, 7058369876): after its erasure its
// owner's next store sits under the same key, and the erased store's late storage write must not land.
import { test } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { reserveStorage } from "@/lib/storage-reservations";
import { setIfStoreLive } from "@/lib/live-fence";
import { ERASING_KEY, erasingField } from "@/lib/store";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const OWNER = "nl:store:owner-key-legacy";
const REF = "legacy-owner@example.com";
const folder = "b".repeat(32);
const row = async () => (await redis.pipeline([["GET", "nl:storage:pending:" + folder]]))[0];

test("legacy store: the owner's record holds another store; the erased store's storage write is refused", async () => {
  redis.clear();
  await redis.pipeline([["SET", OWNER, JSON.stringify({ statsId: "s_B", handle: "next-store" })]]);
  const fence = { live: OWNER, erasing: ERASING_KEY, field: await erasingField(REF), statsId: "s_A", ref: REF };
  assert.equal(await setIfStoreLive(fence, "nl:test:cache", "x", 60), "gone");
  await assert.rejects(reserveStorage(folder, 10, 100, async () => 0, fence), /storage_store_gone/);
  assert.equal(await row(), null);
});

test("legacy store with no statsId: nothing is known, nothing is written", async () => {
  redis.clear();
  await redis.pipeline([["SET", OWNER, JSON.stringify({ statsId: "s_B" })]]);
  const fence = { live: OWNER, erasing: ERASING_KEY, field: await erasingField(REF), statsId: null, ref: REF };
  await assert.rejects(reserveStorage(folder, 10, 100, async () => 0, fence), /storage_unknown/);
  assert.equal(await row(), null);
});

test("legacy store whose record is its own: the row is written", async () => {
  redis.clear();
  await redis.pipeline([["SET", OWNER, JSON.stringify({ statsId: "s_A" })]]);
  const fence = { live: OWNER, erasing: ERASING_KEY, field: await erasingField(REF), statsId: "s_A", ref: REF };
  const made = await reserveStorage(folder, 10, 100, async () => 0, fence);
  assert.equal(made.bytes, 10);
  assert.notEqual(await row(), null);
});

test("a record that does not parse is never this store: refused, nothing written", async () => {
  redis.clear();
  await redis.pipeline([["SET", OWNER, "not json"]]);
  const fence = { live: OWNER, erasing: ERASING_KEY, field: await erasingField(REF), statsId: "s_A", ref: REF };
  await assert.rejects(reserveStorage(folder, 10, 100, async () => 0, fence));
  assert.equal(await row(), null);
});

test("a store with an id keeps the EXISTS fence on its id key", async () => {
  redis.clear();
  const live = "nl:store:id:s_idstore";
  const fence = { live, erasing: ERASING_KEY, field: await erasingField(REF), statsId: "", ref: REF };
  await assert.rejects(reserveStorage(folder, 10, 100, async () => 0, fence), /storage_store_gone/);
  assert.equal(await row(), null);
  await redis.pipeline([["SET", live, REF]]);
  assert.equal((await reserveStorage(folder, 10, 100, async () => 0, fence)).bytes, 10);
});
