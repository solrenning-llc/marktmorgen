/**
 * A student's assignment work is read only in its exact shape (CX-123 rule 24; Claude 4's audit of lib/assignment.ts):
 *
 *   - deleting a person (forgetTasksPerson): a reply cut short or of another shape throws and deletes nothing; a
 *     record that is there but does not read is still deleted, and the erasure is told it could not find the file
 *     from it (a throw, so the erasure says "incomplete", never "done" with nothing counted);
 *   - one student's work (submissionOf): a record that does not read throws, never "nothing handed in", so approved
 *     work is not handed in over (handIn);
 *   - the creator's list of work (waitingWork) and the hourly email's mark (tellCreatorNow): another shape throws.
 *
 * Confirmed absence (GET nil, an empty list, SET NX nil) stays what it was. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetTasksPerson, handIn, submissionOf, tellCreatorNow, waitingWork } from "@/lib/assignment";
import type { Submission, Task } from "@/lib/assignment-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const COURSE = "crs_readsexact";
const LESSON = "lessonexact1";
const OTHER_LESSON = "lessonother1";
const WHO = "cccccccccccccccccccccccccccccccc";
const ROOM_KEY = "st_readsexact";
const sub = (lessonId: string) => `nl:course:${COURSE}:task:${lessonId}:sub:${WHO}`;
const files = (lessonId: string) => `nl:course:${COURSE}:task:${lessonId}:files`;
const waiting = `nl:course:${COURSE}:tasks:waiting`;
const all = `nl:course:${COURSE}:tasks:all`;
const bytes = `nl:tasks:bytes:${ROOM_KEY}`;
const doors = "nl:tasks:doors";
const told = `nl:course:${COURSE}:tasks:told`;

const work = (lessonId: string, state: Submission["state"] = "waiting"): Submission => ({
  text: "A synthetic answer.",
  file: { path: `synthetic/${lessonId}.pdf`, name: "work.pdf", bytes: 100, type: "application/pdf" },
  at: 1_700_000_000,
  state,
  feedback: "",
  reviewedAt: 0,
  tries: 1,
});

function seed(lessonId: string, raw: string): void {
  redis.run(["SET", sub(lessonId), raw]);
  redis.run(["ZADD", waiting, 1_700_000_000, `${lessonId}|${WHO}`]);
  redis.run(["ZADD", all, 1_700_000_000, `${lessonId}|${WHO}`]);
  redis.run(["HSET", files(lessonId), `synthetic/${lessonId}.pdf`, "100"]);
}

type Batch = (string | number)[][];
async function withReplies<T>(alter: (batch: Batch, answers: unknown[]) => unknown[], run: () => Promise<T>): Promise<{ value?: T; error?: unknown; sent: Batch[] }> {
  const original = redis.pipeline.bind(redis);
  const sent: Batch[] = [];
  redis.pipeline = (async (batch: Batch) => {
    sent.push(batch);
    return alter(batch, await original(batch));
  }) as typeof redis.pipeline;
  try {
    return { value: await run(), sent };
  } catch (error) {
    return { error, sent };
  } finally {
    redis.pipeline = original;
  }
}
const isGets = (batch: Batch) => batch.length > 0 && batch.every((c) => c[0] === "GET");

// ------------------------------------------------------------ deleting a person

test("erasure: healthy records are deleted, counted and their files returned", async () => {
  redis.clear();
  seed(LESSON, JSON.stringify(work(LESSON)));
  redis.run(["SET", bytes, "100"]);
  const done = await forgetTasksPerson(COURSE, [LESSON, OTHER_LESSON], WHO, ROOM_KEY);
  assert.deepEqual(done, { records: 1, files: [`synthetic/${LESSON}.pdf`] });
  assert.equal(redis.run(["GET", sub(LESSON)]), null);
  assert.equal(redis.run(["ZCARD", all]), 0);
  assert.equal(redis.run(["HLEN", files(LESSON)]), 0);
  assert.equal(redis.run(["GET", bytes]), "0");
});

test("erasure: a person who handed nothing in is confirmed absent, nothing deleted", async () => {
  redis.clear();
  const result = await withReplies((_b, a) => a, () => forgetTasksPerson(COURSE, [LESSON, OTHER_LESSON], WHO, ROOM_KEY));
  assert.deepEqual(result.value, { records: 0, files: [] });
  assert.equal(result.sent.length, 1, "only the reading");
});

for (const [label, alter] of [
  ["no replies", () => []],
  ["one reply short", (_b: Batch, a: unknown[]) => a.slice(0, 1)],
  ["a number where a record was", (_b: Batch, a: unknown[]) => a.map(() => 7)],
  ["an object where a record was", (_b: Batch, a: unknown[]) => a.map(() => ({}))],
] as [string, (b: Batch, a: unknown[]) => unknown[]][]) {
  test(`erasure: ${label} throws and deletes nothing, never "nothing to erase"`, async () => {
    redis.clear();
    seed(LESSON, JSON.stringify(work(LESSON)));
    const result = await withReplies((b, a) => (isGets(b) ? alter(b, a) : a), () => forgetTasksPerson(COURSE, [LESSON, OTHER_LESSON], WHO, ROOM_KEY));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
    assert.equal(result.sent.length, 1, "nothing sent after the reading");
    assert.equal(typeof redis.run(["GET", sub(LESSON)]), "string", "the record is still there to erase on the retry");
  });
}

test("erasure: a stored record that does not read is still deleted, and the erasure is told it is incomplete", async () => {
  redis.clear();
  seed(LESSON, "{not json");
  const result = await withReplies((_b, a) => a, () => forgetTasksPerson(COURSE, [LESSON], WHO, ROOM_KEY));
  assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  assert.equal(redis.run(["GET", sub(LESSON)]), null, "the record is deleted");
  assert.equal(redis.run(["ZCARD", all]), 0, "and its places in the lists");
  assert.equal(redis.run(["ZCARD", waiting]), 0);
});

test("erasure: beside a record that does not read, the files that do read go to the daily deletion", async () => {
  redis.clear();
  seed(LESSON, JSON.stringify({ ...work(LESSON), file: "garbled" }));
  seed(OTHER_LESSON, JSON.stringify(work(OTHER_LESSON)));
  redis.run(["SET", bytes, "100"]);
  const result = await withReplies((_b, a) => a, () => forgetTasksPerson(COURSE, [LESSON, OTHER_LESSON], WHO, ROOM_KEY));
  assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  assert.equal(redis.run(["GET", sub(LESSON)]), null);
  assert.equal(redis.run(["GET", sub(OTHER_LESSON)]), null);
  assert.equal(redis.run(["HLEN", files(OTHER_LESSON)]), 0);
  assert.equal(redis.run(["ZSCORE", doors, `synthetic/${OTHER_LESSON}.pdf`]), "0", "the readable file is left for the daily job to delete");
  assert.equal(redis.run(["GET", bytes]), "0", "its room is given back");
});

// ------------------------------------------------------------ one student's work

test("submissionOf: a written record reads, and nil is nothing handed in", async () => {
  redis.clear();
  seed(LESSON, JSON.stringify(work(LESSON)));
  assert.deepEqual(await submissionOf(COURSE, LESSON, WHO), work(LESSON));
  assert.equal(await submissionOf(COURSE, OTHER_LESSON, WHO), null);
});

for (const [label, alter] of [
  ["no reply", () => []],
  ["a number", () => [5]],
  ["broken JSON", () => ["{"]],
  ["JSON of another shape", () => [JSON.stringify(["a"])]],
  ["a record without its state", () => [JSON.stringify({ ...work(LESSON), state: undefined })]],
  ["a record with a garbled file", () => [JSON.stringify({ ...work(LESSON), file: { path: 1 } })]],
] as [string, () => unknown[]][]) {
  test(`submissionOf: ${label} throws, never "nothing handed in"`, async () => {
    redis.clear();
    seed(LESSON, JSON.stringify(work(LESSON)));
    const result = await withReplies((b, a) => (isGets(b) ? alter() : a), () => submissionOf(COURSE, LESSON, WHO));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}

test("handIn: approved work that does not read is not handed in over", async () => {
  redis.clear();
  const kept = '{"state":"approved","tries":3';
  redis.run(["SET", sub(LESSON), kept]);
  const task: Task = { prompt: "Synthetic prompt.", review: true, gate: false, file: false };
  const result = await withReplies((_b, a) => a, () => handIn({ courseId: COURSE, lessonId: LESSON, who: WHO, email: "", task, text: "Again.", file: null, data: ROOM }));
  assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  assert.equal(redis.run(["GET", sub(LESSON)]), kept, "the record is untouched");
});

// ------------------------------------------------------------ the creator's list and email

test("waitingWork: the work written reads, and an empty list is none", async () => {
  redis.clear();
  seed(LESSON, JSON.stringify(work(LESSON)));
  assert.deepEqual(await waitingWork(COURSE), { rows: [{ lessonId: LESSON, who: WHO, at: 1_700_000_000 }], total: 1 });
  assert.deepEqual(await waitingWork(COURSE, 50, true), { rows: [{ lessonId: LESSON, who: WHO, at: 1_700_000_000 }], total: 1 });
  assert.deepEqual(await waitingWork("crs_readsnone"), { rows: [], total: 0 });
});

for (const [label, alter] of [
  ["no replies", () => []],
  ["the list missing", (a: unknown[]) => [null, a[1]]],
  ["the list an object", (a: unknown[]) => [{}, a[1]]],
  ["the list odd", (a: unknown[]) => [(a[0] as unknown[]).slice(0, 1), a[1]]],
  ["a member of another shape", (a: unknown[]) => [["nopipe", "1700000000"], a[1]]],
  ["a score that is not a number", (a: unknown[]) => [[(a[0] as unknown[])[0], "soon"], a[1]]],
  ["the count missing", (a: unknown[]) => [a[0], null]],
  ["the count as text", (a: unknown[]) => [a[0], "1"]],
] as [string, (a: unknown[]) => unknown[]][]) {
  test(`waitingWork: ${label} throws, never an empty list`, async () => {
    redis.clear();
    seed(LESSON, JSON.stringify(work(LESSON)));
    const result = await withReplies((_b, a) => alter(a), () => waitingWork(COURSE));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}

test("tellCreatorNow: OK is now, nil is told already this hour", async () => {
  redis.clear();
  assert.equal(await tellCreatorNow(COURSE), true);
  assert.equal(await tellCreatorNow(COURSE), false);
  assert.equal(redis.run(["GET", told]), "1");
});

for (const [label, reply] of [["no reply", []], ["a number", [1]], ["another word", ["QUEUED"]]] as [string, unknown[]][]) {
  test(`tellCreatorNow: ${label} throws, never another email`, async () => {
    redis.clear();
    const result = await withReplies(() => [...reply], () => tellCreatorNow(COURSE));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}
