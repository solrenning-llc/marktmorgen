import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { forgetPushPerson } from "@/lib/community-push";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { erasePerson } from "@/lib/person-erasure";
import { emailKey } from "@/lib/learn";
import { makeWorld } from "./erasure-world";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const realFetch = globalThis.fetch;
beforeEach(() => {
  redis.clear();
  globalThis.fetch = async () => { throw new Error("External IO is forbidden in this review"); };
});
afterEach(() => { redis.pipeline = pipeline; globalThis.fetch = realFetch; });

test("confirmed DEL targets only the requested member and community, including an already absent hash", async () => {
  const key = "nl:cm:review-one:ps:member-one";
  const neighbors = ["nl:cm:review-one:ps:member-two", "nl:cm:review-two:ps:member-one"];
  for (const target of [key, ...neighbors]) redis.run(["HSET", target, "synthetic-endpoint", "synthetic-device"]);
  const sent: (string | number)[][] = [];
  redis.pipeline = async batch => { sent.push(...batch); return Object.freeze(await pipeline(batch)) as unknown as unknown[]; };
  assert.equal(await forgetPushPerson("review-one", "member-one"), 1);
  assert.equal(await forgetPushPerson("review-one", "member-one"), 0);
  assert.deepEqual(sent, [["DEL", key], ["DEL", key]]);
  for (const target of neighbors) assert.equal(redis.run(["HLEN", target]), 1);
});

test("the community eraser cannot turn an unconfirmed push deletion into a record count", async () => {
  const key = "nl:cm:review-community:ps:review-member";
  redis.run(["HSET", key, "synthetic-endpoint", "synthetic-device"]);
  let writes = 0;
  redis.pipeline = async batch => {
    if (batch.length === 1 && batch[0][0] === "DEL" && batch[0][1] === key) { writes += 1; return []; }
    return pipeline(batch);
  };
  await assert.rejects(forgetCommunityPerson("review-community", "review-member", "member@example.test", []), /not confirmed/);
  assert.equal(writes, 1);
  assert.equal(redis.run(["HLEN", key]), 1);
});

for (const applied of [false, true]) {
  test(`the real person eraser reports incomplete on lost push evidence (DEL applied: ${applied})`, async () => {
    const world = await makeWorld("push-review-store", "owner@example.test");
    const email = "member@example.test";
    const key = `nl:cm:${world.communityId}:ps:${emailKey(email)}`;
    redis.run(["HSET", key, "synthetic-endpoint", "synthetic-device"]);
    let attempts = 0;
    redis.pipeline = async batch => {
      if (batch.length === 1 && batch[0][0] === "DEL" && batch[0][1] === key) {
        attempts += 1;
        if (applied) await pipeline(batch);
        return [];
      }
      return pipeline(batch);
    };
    const result = await erasePerson(world.store, email, { kind: "person" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === "incomplete");
    if (result.ok || result.reason !== "incomplete") throw new Error("Expected an incomplete erasure");
    assert.deepEqual(result.failed, ["lib/community-erasure.ts"]);
    assert.equal(result.parts.some(part => part.module === "lib/community-erasure.ts"), false);
    assert.equal(attempts, 1);
    assert.equal(redis.run(["HLEN", key]), applied ? 0 : 1);
  });
}
