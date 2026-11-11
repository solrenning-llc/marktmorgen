/**
 * Rule 24 in a course's comment switch (lib/lesson-comments.ts, commentsOn): comments are on only when the "off"
 * mark is confirmed absent (GET answers exactly null). A reply cut short or of another shape counts as off, so a
 * course whose creator switched comments off never takes a public post on an unread mark.
 *
 * Synthetic course only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { commentsOn, setCommentsOn } from "@/lib/lesson-comments";
import { store as redis } from "./redis-stub";

const COURSE = "f".repeat(32);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]], ["two replies", [null, null]]] as [string, unknown[]][]) {
  test(`the off mark read as ${label}: comments are off`, async () => {
    redis.clear();
    await setCommentsOn(COURSE, false);
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "GET" ? reply : pipeline(b))) as typeof redis.pipeline;
    try {
      assert.equal(await commentsOn(COURSE), false);
    } finally {
      redis.pipeline = pipeline;
    }
  });
}

test("read exactly: on with no mark, off with it", async () => {
  redis.clear();
  assert.equal(await commentsOn(COURSE), true);
  await setCommentsOn(COURSE, false);
  assert.equal(await commentsOn(COURSE), false);
});
