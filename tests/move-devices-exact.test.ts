/**
 * Rule 24 in moving an account's known browsers (lib/auth.ts, moveDevices): the old address's set is read exactly.
 * A reply cut short or of another shape is unknown: nothing is deleted and the call throws (the move route logs it),
 * never "no browsers" followed by deleting the ones known.
 *
 * Synthetic addresses only.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { moveDevices } from "@/lib/auth";
import { store as redis } from "./redis-stub";

const FROM = "old-person@example.test";
const TO = "new-person@example.test";
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

const devicesKey = (email: string) => `nl:auth:devices:${createHash("sha256").update(`nimbus-auth-devices:${email}`).digest("hex").slice(0, 40)}`;

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["a member that is not text", [["a1", 5]]], ["two replies", [["a1"], ["b2"]]]] as [string, unknown[]][]) {
  test(`the old set read as ${label}: nothing is deleted`, async () => {
    redis.clear();
    // Two browsers known at the old address.
    const key = devicesKey(FROM);
    await pipeline([["SADD", key, "a1", "b2"]]);
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "SMEMBERS" ? reply : pipeline(b))) as typeof redis.pipeline;
    let threw = false;
    try {
      await moveDevices(FROM, TO);
    } catch {
      threw = true;
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(threw, true, "an unread set is not \"no browsers\"");
    assert.deepEqual(((await pipeline([["SMEMBERS", key]]))[0] as string[]).sort(), ["a1", "b2"]);
  });
}

test("read exactly: the browsers go to the new address", async () => {
  redis.clear();
  const from = devicesKey(FROM);
  const to = devicesKey(TO);
  await pipeline([["SADD", from, "a1", "b2"]]);
  await moveDevices(FROM, TO);
  const [kept, moved] = await pipeline([["EXISTS", from], ["SMEMBERS", to]]);
  assert.equal(kept, 0);
  assert.deepEqual((moved as string[]).sort(), ["a1", "b2"]);
});
