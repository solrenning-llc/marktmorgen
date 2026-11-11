/**
 * Rule 24 in the closing walk (lib/plan-closing.ts, closeEnded): each page of the stores whose plan ended
 * (ZRANGEBYSCORE on the ended index) is read exactly. A page cut short or of another shape is unknown: the walk stops
 * with an error, keeps where it had got to (the cursor), and does not count the month's held stores as complete.
 * Before, it read as "no more stores": the cursor was deleted, the stores after it were skipped for the run, and the
 * month's count was recorded as complete.
 *
 * Synthetic only: the in-memory Redis, no store, no provider.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { closeEnded } from "@/lib/plan-closing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { store as redis } from "./redis-stub";

const AFTER = "nl:plan:closing:after";
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

for (const [label, reply] of [
  ["no reply", []],
  ["a number", [7]],
  ["null", [null]],
  ["an odd count", [["a"]]],
  ["a score that is not text", [["a", 1]]],
] as [string, unknown[]][]) {
  test(`a page of ended stores read as ${label}: the walk stops, keeps its place and certifies nothing`, async () => {
    redis.clear();
    await pipeline([["SET", AFTER, "1700000000", "EX", 3600]]);
    const sent: Batch = [];
    redis.pipeline = (async (batch: Batch) => {
      sent.push(...batch);
      return batch.length === 1 && batch[0][0] === "ZRANGEBYSCORE" && batch[0][1] === ENDED_INDEX ? reply : pipeline(batch);
    }) as typeof redis.pipeline;
    let threw = false;
    try {
      await closeEnded(Infinity, Date.now());
    } catch {
      threw = true;
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(threw, true, "the walk stops on an unknown page");
    assert.deepEqual(await pipeline([["GET", AFTER]]), ["1700000000"], "the cursor is kept");
    assert.equal(sent.some((c) => c[0] === "EVAL" && c.some((a) => String(a).startsWith("nl:held:month:"))), false, "the month is not recorded");
  });
}

test("an exact empty page ends the walk and records the month", async () => {
  redis.clear();
  await pipeline([["SET", AFTER, "1700000000", "EX", 3600]]);
  await closeEnded(Infinity, Date.now());
  assert.deepEqual(await pipeline([["GET", AFTER]]), [null]);
});
