/**
 * A hand-in never writes an erased student's work back (issue #4271, Codex L's #4034; reviews of #5073 by Claude 7 xAF
 * and Claude 7 3uv). handIn read "no work yet", the student's erasure found nothing to delete and reported done, then
 * HAND_IN_WRITE_IF compared "" with "" and wrote: the erased student's text, file and places in the course's lists
 * came back, and on an assignment nobody reviews the lesson was marked done for their email. A count compared between
 * the read and the write still missed a hand-in admitted before the erasure but read after it, or written between the
 * erasure's start and its read. Now the write is fenced by the student's erasure print, in the same Redis step: the
 * erasure puts the print first (lib/person-erasure.ts), so a write that lands after it is refused whenever the hand-in
 * read, and one that lands before it is deleted by forgetTasksPerson, which runs after the print. Synthetic,
 * in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HandInChangedError, HandInErasedError, forgetTasksPerson, handIn, submissionOf, waitingWork } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { passedQuizzes } from "@/lib/quiz";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const COURSE = "crs_hand_in_erased";
const LESSON = "lsnerasedaaa";
const WHO = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const EMAIL = "student@example.com";
const LIST = "list_hand_in_erased";
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

const hand = (task: Task, who = WHO, email = EMAIL, now = 100) =>
  handIn({ data: ROOM, erasure: { listId: LIST, email }, courseId: COURSE, lessonId: LESSON, who, email, task, text: "My work.", file: { path: `${who}.pdf`, name: "work.pdf", bytes: 1000, type: "application/pdf" }, now });

/** The student's erasure as lib/person-erasure.ts runs it: the print first, then the course's tasks. */
async function erasePrint(email = EMAIL): Promise<void> {
  await redis.pipeline([suppressCommand(LIST, email)]);
}
const eraseTasks = (who = WHO) => forgetTasksPerson(COURSE, [LESSON], who, null);

async function nothingKept(task: Task): Promise<void> {
  assert.equal(await submissionOf(COURSE, LESSON, WHO), null, "the erased student's work does not come back");
  assert.deepEqual((await waitingWork(COURSE)).rows, [], "nor in the creator's waiting list");
  assert.equal(redis.run(["ZCARD", allKey]), 0, "nor in the list of all work");
  assert.equal(redis.run(["HEXISTS", filesKey, `${WHO}.pdf`]), 0, "its file is not listed as kept");
  assert.equal((await passedQuizzes(COURSE, WHO)).has(LESSON), false, `the lesson is not marked done (${task.review ? "reviewed" : "at once"})`);
}

for (const [name, task] of [["reviewed", REVIEWED], ["done at once", AT_ONCE]] as const) {
  test(`a first hand-in read before the erasure is not written after it (${name})`, async () => {
    redis.clear();
    let erased: Awaited<ReturnType<typeof eraseTasks>> | null = null;
    await assert.rejects(
      aheadOf(handInWrite, async () => {
        await erasePrint();
        erased = await eraseTasks();
      }, () => hand(task)),
      HandInErasedError,
    );
    assert.deepEqual(erased, { records: 0, files: [] }, "the erasure found nothing yet and finished");
    await nothingKept(task);
  });

  test(`a hand-in admitted before the erasure and read only after it finished is refused (${name})`, async () => {
    // Claude 7 3uv on #5073: the route let the student in before the erasure; handIn read after the erasure was over.
    redis.clear();
    await erasePrint();
    assert.deepEqual(await eraseTasks(), { records: 0, files: [] });
    await assert.rejects(hand(task), HandInErasedError);
    await nothingKept(task);
  });

  test(`a hand-in written after the print but before the erasure reads the work is refused (${name})`, async () => {
    // Claude 7 3uv on #5073: the write lands between the erasure's start and its read of the records.
    redis.clear();
    await assert.rejects(aheadOf(handInWrite, () => erasePrint(), () => hand(task)), HandInErasedError);
    assert.deepEqual(await eraseTasks(), { records: 0, files: [] });
    await nothingKept(task);
  });
}

test("a refused hand-in is a HandInChangedError, so the route lets its file go", () => {
  assert.equal(new HandInErasedError() instanceof HandInChangedError, true);
});

test("work written before the erasure's print is deleted by the erasure, as before", async () => {
  redis.clear();
  await hand(REVIEWED);
  await erasePrint();
  assert.deepEqual(await eraseTasks(), { records: 1, files: [`${WHO}.pdf`] });
  await nothingKept(REVIEWED);
});

test("another student of the lesson hands in while one is erased", async () => {
  redis.clear();
  await erasePrint();
  const done = await hand(REVIEWED, OTHER, "other@example.com");
  assert.equal(done.state, "waiting");
  assert.equal((await submissionOf(COURSE, LESSON, OTHER))?.text, "My work.");
});

test("a reply of another shape to the write is unknown, never written or refused", async () => {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => (handInWrite(batch) ? ["OK"] : original(batch))) as typeof redis.pipeline;
  try {
    await assert.rejects(hand(REVIEWED), (error: unknown) => error instanceof Error && error.name === "UnknownReplyError");
  } finally {
    redis.pipeline = original;
  }
});
