/**
 * A creator's review is written only over the work it read (issue #3954). review() read the student's work, then
 * wrote `{...old, state}` with a plain SET: a new hand-in written between the two (handIn's own write is a
 * compare-and-set, HAND_IN_WRITE_IF, so it passed and answered the old file as replaced, which the task route
 * deletes) was overwritten by the old work marked approved. The student's new text and file were lost, the new file
 * stayed stored with no work keeping it, the approved record pointed at the deleted file and the lesson was marked
 * done. Now the review is a compare-and-set too: the work handed in meanwhile is kept, waiting, and the review answers
 * "state" so the studio reloads. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { handIn, review, submissionOf, waitingWork } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { passedQuizzes } from "@/lib/quiz";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const COURSE = "crs_review_race";
const LESSON = "lsnrevieweda";
const WHO = "0123456789abcdef";
const TASK: Task = { prompt: "Write it.", review: true, gate: true, file: true };
const subKey = `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`;
const file = (name: string) => ({ path: `${name}.pdf`, name: `${name}.pdf`, bytes: 1000, type: "application/pdf" });

type Batch = (string | number)[][];

/** The review's own write of the work: a plain SET before the fix, its compare-and-set after it. */
const reviewWrite = (batch: Batch) =>
  batch.some(([op, arg]) => (op === "SET" && arg === subKey) || (op === "EVAL" && String(arg).startsWith("-- marktmorgen:review-write-if:")));

/** Runs `before` once, just ahead of the first batch `when` picks, then lets that batch through. */
async function aheadOf<T>(when: (batch: Batch) => boolean, before: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => {
    if (when(batch)) {
      redis.pipeline = original;
      await before();
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const handInText = (text: string, name: string, now: number) =>
  handIn({ data: ROOM, courseId: COURSE, lessonId: LESSON, who: WHO, email: "student@example.com", task: TASK, text, file: file(name), now });

const approve = (feedback = "Clear now.") =>
  review({ data: ROOM, courseId: COURSE, lessonId: LESSON, who: WHO, email: "student@example.com", verdict: "approved", feedback, now: 300 });

test("a hand-in written while the creator approves keeps the student's new work and file", async () => {
  redis.clear();
  await handInText("v1", "one", 100);
  let second: Awaited<ReturnType<typeof handIn>> | null = null;
  const result = await aheadOf(reviewWrite, async () => {
    second = await handInText("v2", "two", 200);
  }, approve);
  assert.equal(second!.replaced?.path, "one.pdf", "the second hand-in replaced the first file, which the route deletes");
  const kept = await submissionOf(COURSE, LESSON, WHO);
  assert.equal(kept?.text, "v2", "the new text is kept");
  assert.equal(kept?.file?.path, "two.pdf", "the new file is kept, never the deleted one");
  assert.equal(kept?.state, "waiting", "the new work still waits for the creator");
  assert.deepEqual(result, { ok: false, reason: "state" }, "the review of the old work is refused, so the studio reloads");
  assert.equal((await passedQuizzes(COURSE, WHO)).has(LESSON), false, "the lesson is not marked done on work nobody approved");
  assert.deepEqual((await waitingWork(COURSE)).rows.map((row) => row.who), [WHO], "the new work stays in the creator's list");
});

test("two reviews of the same work at once: one is written, the other refused", async () => {
  redis.clear();
  await handInText("v1", "one", 100);
  let other: Awaited<ReturnType<typeof review>> | null = null;
  const first = await aheadOf(reviewWrite, async () => {
    other = await review({ data: ROOM, courseId: COURSE, lessonId: LESSON, who: WHO, email: "", verdict: "again", feedback: "Say who it is for.", now: 250 });
  }, approve);
  assert.equal(other!.ok, true, "the review that wrote first stands");
  assert.deepEqual(first, { ok: false, reason: "state" }, "the one that read the same work is refused, never written over it");
  const kept = await submissionOf(COURSE, LESSON, WHO);
  assert.equal(kept?.state, "again");
  assert.equal(kept?.feedback, "Say who it is for.");
  assert.equal((await passedQuizzes(COURSE, WHO)).has(LESSON), false);
});

test("a review with nothing in between is written and finishes the lesson, as before", async () => {
  redis.clear();
  await handInText("v1", "one", 100);
  const result = await approve();
  assert.equal(result.ok, true);
  const kept = await submissionOf(COURSE, LESSON, WHO);
  assert.deepEqual([kept?.text, kept?.file?.path, kept?.state, kept?.feedback, kept?.reviewedAt], ["v1", "one.pdf", "approved", "Clear now.", 300]);
  assert.equal((await waitingWork(COURSE)).total, 0, "it leaves the creator's list");
  assert.equal((await passedQuizzes(COURSE, WHO)).has(LESSON), true, "the lesson is done");
  assert.deepEqual(await approve(), { ok: false, reason: "state" }, "work already answered is not answered twice");
});
