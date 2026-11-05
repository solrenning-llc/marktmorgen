import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { blankInLists, ERASED_MARK } from "@/lib/erasure-lists";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const email = "deleted@example.test", first = "synthetic:list:first", second = "synthetic:list:second";
beforeEach(() => { redis.pipeline = pipeline; redis.clear(); });
afterEach(() => { redis.pipeline = pipeline; });
for (const applied of [false, true]) test(`transport loss propagates without replay (applied=${applied})`, async () => {
  redis.run(["RPUSH", first, email, "other@example.test"]);
  let attempts = 0;
  redis.pipeline = async commands => {
    attempts += 1;
    if (applied) await pipeline(commands);
    throw new Error("synthetic lost transport");
  };
  await assert.rejects(blankInLists([first], email), /synthetic lost transport/);
  assert.equal(attempts, 1);
  assert.deepEqual(redis.run(["LRANGE", first, 0, -1]), [applied ? ERASED_MARK : email, "other@example.test"]);
});
test("an inherited numeric slot cannot confirm deletion", async () => {
  const reply = new Array(1);
  Object.setPrototypeOf(reply, { 0: 0 });
  redis.pipeline = async () => reply;
  await assert.rejects(blankInLists([first], email));
});
test("multiple lists retain positions, unrelated people and a genuine retry zero", async () => {
  redis.run(["RPUSH", first, email, "other@example.test", email]);
  redis.run(["RPUSH", second, "other@example.test", email]);
  assert.equal(await blankInLists([first, second], email), 3);
  assert.deepEqual(redis.run(["LRANGE", first, 0, -1]), [ERASED_MARK, "other@example.test", ERASED_MARK]);
  assert.deepEqual(redis.run(["LRANGE", second, 0, -1]), ["other@example.test", ERASED_MARK]);
  assert.equal(await blankInLists([first, second], email), 0);
});
