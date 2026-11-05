/**
 * An agent reads a course's record only within COURSE_READ_MOST_BYTES
 * (lib/course.ts, readCourseWithin; Codex G2 on #1933): a record past it is
 * not read at all and is said too large, one within it reads as readCourse
 * does, and a reply that is not the script's exact answer is not a course.
 * In-memory Redis only.
 */
import { test } from "node:test";
import { inspect } from "node:util";
import assert from "node:assert/strict";
import { COURSE_READ_MOST_BYTES, CourseTooLarge, emptyCourse, readCourse, readCourseWithin } from "@/lib/course";
import { store as redis } from "./redis-stub";

const id = "c".repeat(32);
const key = `nl:course:${id}`;

test("a course within the bound reads as it is kept", async () => {
  redis.clear();
  await redis.pipeline([["SET", key, JSON.stringify(emptyCourse(id))]]);
  assert.deepEqual(await readCourseWithin(id), await readCourse(id));
});

test("no course: nothing, as readCourse", async () => {
  redis.clear();
  assert.equal(await readCourseWithin(id), null);
});

test("the in-memory model answers a missing course as Redis does: [1, null]", async () => {
  redis.clear();
  const { READ_COURSE_WITHIN } = await import("@/lib/course");
  assert.deepEqual(await redis.pipeline([["EVAL", READ_COURSE_WITHIN, 1, key, COURSE_READ_MOST_BYTES]]), [[1, null]]);
});

test("Redis's exact answer for a missing course, [1, null], is no course", async () => {
  redis.clear();
  const original = redis.pipeline;
  redis.pipeline = async () => [[1, null]];
  try {
    assert.equal(await readCourseWithin(id), null);
  } finally {
    redis.pipeline = original;
  }
});

test("a record past the bound is not read: too large, and the GET never runs", async () => {
  redis.clear();
  await redis.pipeline([["SET", key, "x".repeat(COURSE_READ_MOST_BYTES + 1)]]);
  const original = redis.pipeline;
  let reads = 0;
  redis.pipeline = async (commands) => {
    reads += commands.filter((c) => c[0] === "GET" && c[1] === key).length;
    return original.call(redis, commands);
  };
  try {
    await assert.rejects(readCourseWithin(id), CourseTooLarge);
    assert.equal(reads, 0);
  } finally {
    redis.pipeline = original;
  }
});

// Codex A3 on #1933: [1] alone, [1, undefined] and [1, false] are not Redis's answer for a missing course, which is [1, null]
// (the exact script run on Redis 7.4: missing [1, null], present [1, "..."], too large [0]); a record that is kept but is
// not a course is not "no course" either.
for (const reply of [[], [[1, "{}", "extra"]], [[2]], [["1", "{}"]], [null], [[1]], [[1, undefined]], [[1, false]], [[1, "{"]], [[1, 7]]]) {
  test(`an answer that is not the script's exact one (${inspect(reply)}) is not a course`, async () => {
    redis.clear();
    const original = redis.pipeline;
    redis.pipeline = async () => reply as unknown[];
    try {
      await assert.rejects(readCourseWithin(id));
    } finally {
      redis.pipeline = original;
    }
  });
}
