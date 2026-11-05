import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyCourse, readCourseWithin, READ_COURSE_WITHIN } from "@/lib/course";
import { store as redis } from "./redis-stub";

test("bounded course reads distinguish confirmed absence from incomplete replies", async t => {
  redis.clear();
  const id = "c".repeat(32), key = `nl:course:${id}`;
  await redis.pipeline([["SET", key, JSON.stringify(emptyCourse(id))]]);
  assert.equal((await readCourseWithin(id))?.id, id);
  const original = redis.pipeline;
  for (const { label, reply } of [
    { label: "truncated tuple", reply: [[1]] },
    { label: "missing value", reply: [[1, undefined]] },
    { label: "false instead of a GET value", reply: [[1, false]] },
  ]) {
    await t.test(label, async () => {
      let intercepted = false;
      redis.pipeline = async commands => {
        if (commands.some(c => c[0] === "EVAL" && c[1] === READ_COURSE_WITHIN)) {
          intercepted = true;
          return reply;
        }
        return original.call(redis, commands);
      };
      try {
        await assert.rejects(readCourseWithin(id), "unknown reply cannot confirm that the stored course is absent");
        assert.equal(intercepted, true);
      } finally { redis.pipeline = original; }
    });
  }
  redis.pipeline = async () => [[1, null]];
  try { assert.equal(await readCourseWithin(id), null, "an exact confirmed Redis miss remains absent"); }
  finally { redis.pipeline = original; }
});
