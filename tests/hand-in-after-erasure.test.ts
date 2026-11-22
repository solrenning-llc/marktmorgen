/**
 * A hand-in read before a student's erasure is never written after it (issue #4271, Codex L's #4034). handIn read
 * "no work yet", the erasure (forgetTasksPerson) found nothing to delete and reported done, then HAND_IN_WRITE_IF
 * compared "" with "" and wrote: the erased student's text, file and places in the course's lists came back, and on
 * an assignment nobody reviews the lesson was marked done for their email. Now the erasure leaves a short mark on each
 * lesson even when it finds nothing, the hand-in reads it before the work, and the write is refused when it changed
 * in between. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HandInChangedError, forgetTasksPerson, handIn, submissionOf, waitingWork } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { passedQuizzes } from "@/lib/quiz";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const COURSE = "crs_hand_in_erased";
const LESSON = "lsnerasedaaa";
const OTHER = "lsnotheraaaa";
const WHO = "0123456789abcdef";
const REVIEWED: Task = { prompt: "Write it.", review: true, gate: false, file: true };
const AT_ONCE: Task = { prompt: "Write it.", review: false, gate: false, file: true };
const filesKey = `nl:course:${COURSE}:task:${LESSON}:files`;
const allKey = `nl:course:${COURSE}:tasks:all`;

type Batch = (string | number)[][];

/** The hand-in's own write of the work. */
const handInWrite = (batch: Batch) => batch.some(([op, arg]) => op === "EVAL" && String(arg).startsWith("-- marktmorgen:hand-in-write-if:"));

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

const firstHandIn = (task: Task, now = 100) =>
  handIn({ data: ROOM, courseId: COURSE, lessonId: LESSON, who: WHO, email: "student@example.com", task, text: "My work.", file: { path: "one.pdf", name: "one.pdf", bytes: 1000, type: "application/pdf" }, now });

for (const [name, task] of [["reviewed", REVIEWED], ["done at once", AT_ONCE]] as const) {
  test(`a first hand-in read before the erasure is not written after it (${name})`, async () => {
    redis.clear();
    let erased: Awaited<ReturnType<typeof forgetTasksPerson>> | null = null;
    await assert.rejects(
      aheadOf(handInWrite, async () => {
        erased = await forgetTasksPerson(COURSE, [LESSON], WHO, null);
      }, () => firstHandIn(task)),
      HandInChangedError,
      "the hand-in is refused, so the student is told to hand in again",
    );
    assert.deepEqual(erased, { records: 0, files: [] }, "the erasure found nothing yet and finished");
    assert.equal(await submissionOf(COURSE, LESSON, WHO), null, "the erased student's work does not come back");
    assert.deepEqual((await waitingWork(COURSE)).rows, [], "nor in the creator's waiting list");
    assert.equal(redis.run(["ZCARD", allKey]), 0, "nor in the list of all work");
    assert.equal(redis.run(["HEXISTS", filesKey, "one.pdf"]), 0, "its file is not listed as kept");
    assert.equal((await passedQuizzes(COURSE, WHO)).has(LESSON), false, "the lesson is not marked done");
  });
}

for (const [name, task] of [["reviewed", REVIEWED], ["done at once", AT_ONCE]] as const) {
  test(`a hand-in read after the erasure's first count and written after the erasure finished is refused (${name})`, async () => {
    // Claude 7 on #5073: the hand-in reads the lesson's count after the erasure counted it once, and its own write
    // waits until the erasure has finished. The erasure counts again at its end, so the count read is stale.
    redis.clear();
    const original = redis.pipeline.bind(redis);
    let handing: Promise<unknown> | null = null;
    let atWrite: () => void = () => undefined;
    const reachedWrite = new Promise<void>((resolve) => { atWrite = resolve; });
    let letWrite: () => void = () => undefined;
    const writeHeld = new Promise<void>((resolve) => { letWrite = resolve; });
    redis.pipeline = (async (batch: Batch) => {
      if (!handing && batch.length > 0 && batch.every(([op, key]) => op === "GET" && String(key).includes(":sub:"))) {
        handing = firstHandIn(task).then(() => "written", (error: unknown) => error);
        await reachedWrite;
      } else if (handInWrite(batch)) {
        atWrite();
        await writeHeld;
      }
      return original(batch);
    }) as typeof redis.pipeline;
    let erased: Awaited<ReturnType<typeof forgetTasksPerson>> | null = null;
    try {
      erased = await forgetTasksPerson(COURSE, [LESSON], WHO, null);
      letWrite();
      assert.ok((await handing) instanceof HandInChangedError, "the hand-in is refused, so the student is told to hand in again");
    } finally {
      redis.pipeline = original;
      letWrite();
    }
    assert.deepEqual(erased, { records: 0, files: [] }, "control: the erasure read before the hand-in wrote");
    assert.equal(await submissionOf(COURSE, LESSON, WHO), null, "the erased student's work does not come back");
    assert.equal(redis.run(["ZCARD", allKey]), 0);
    assert.equal(redis.run(["HEXISTS", filesKey, "one.pdf"]), 0);
    assert.equal((await passedQuizzes(COURSE, WHO)).has(LESSON), false);
  });
}

test("a hand-in made after the erasure finished is written as usual", async () => {
  redis.clear();
  assert.deepEqual(await forgetTasksPerson(COURSE, [LESSON, OTHER], WHO, null), { records: 0, files: [] });
  const done = await firstHandIn(REVIEWED, 200);
  assert.equal(done.state, "waiting");
  assert.equal((await submissionOf(COURSE, LESSON, WHO))?.text, "My work.");
  assert.deepEqual((await waitingWork(COURSE)).rows.map((row) => row.who), [WHO]);
  const again = await handIn({ data: ROOM, courseId: COURSE, lessonId: LESSON, who: WHO, email: "student@example.com", task: REVIEWED, text: "Second go.", file: null, now: 300 });
  assert.equal(again.state, "waiting", "and handed in again over it");
});

test("work handed in before the erasure is deleted by it, as before", async () => {
  redis.clear();
  await firstHandIn(REVIEWED);
  assert.deepEqual(await forgetTasksPerson(COURSE, [LESSON], WHO, null), { records: 1, files: ["one.pdf"] });
  assert.equal(await submissionOf(COURSE, LESSON, WHO), null);
});

test("an erasure whose mark is not confirmed is told it did not finish", async () => {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) =>
    batch.some(([op]) => op === "INCR") ? batch.map(() => "OK") : original(batch)) as typeof redis.pipeline;
  try {
    await assert.rejects(forgetTasksPerson(COURSE, [LESSON], WHO, null), UnknownReplyError);
  } finally {
    redis.pipeline = original;
  }
});
