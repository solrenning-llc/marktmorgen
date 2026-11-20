/**
 * Several students' work, and an assignment's prompt, read only in their exact shape (CX-123 rule 24; Claude 4's
 * follow-up to tests/assignment-reads-exact.test.ts):
 *
 *   - submissionsOf: a reply cut short or of another shape throws; a record that is there but does not read is
 *     answered as unread, never as nothing handed in, so it does not drop out of the person's copy of their data
 *     (lib/person-copy.ts) nor out of the studio's list of work;
 *   - readTaskFor: a prompt record that does not read throws, never "no assignment".
 *
 * Confirmed absence (GET nil) stays what it was. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readTaskFor, submissionsOf } from "@/lib/assignment";
import type { Submission, Task } from "@/lib/assignment-rules";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { CourseWorkStudio } from "@/components/course-work-studio";
import { store as redis } from "./redis-stub";

const COURSE = "crs_exportexact";
const LESSON = "lessonexpor1";
const OTHER_LESSON = "lessonexpor2";
const WHO = "dddddddddddddddddddddddddddddddd";
const sub = (lessonId: string) => `nl:course:${COURSE}:task:${lessonId}:sub:${WHO}`;
const taskKey = (lessonId: string) => `nl:course:${COURSE}:task:${lessonId}`;

const work = (lessonId: string): Submission => ({
  text: "A synthetic answer.",
  file: { path: `synthetic/${lessonId}.pdf`, name: "work.pdf", bytes: 100, type: "application/pdf" },
  at: 1_700_000_000,
  state: "approved",
  feedback: "Synthetic feedback.",
  reviewedAt: 1_700_000_100,
  tries: 1,
});
const task: Task = { prompt: "A synthetic prompt.", review: true, gate: false, file: true };

type Batch = (string | number)[][];
async function withReplies<T>(alter: (batch: Batch, answers: unknown[]) => unknown[], run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => alter(batch, await original(batch))) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = original;
  }
}
const rows = [
  { lessonId: LESSON, who: WHO },
  { lessonId: OTHER_LESSON, who: WHO },
];

// ------------------------------------------------------------ submissionsOf

test("submissionsOf: written records read, nil is nothing handed in", async () => {
  redis.clear();
  redis.run(["SET", sub(LESSON), JSON.stringify(work(LESSON))]);
  assert.deepEqual(await submissionsOf(COURSE, rows), [work(LESSON), null]);
});

for (const [label, alter] of [
  ["no replies", () => []],
  ["one reply short", (a: unknown[]) => a.slice(0, 1)],
  ["a number where a record was", (a: unknown[]) => a.map(() => 7)],
  ["an object where a record was", (a: unknown[]) => a.map(() => ({}))],
] as [string, (a: unknown[]) => unknown[]][]) {
  test(`submissionsOf: ${label} throws, never nothing handed in`, async () => {
    redis.clear();
    redis.run(["SET", sub(LESSON), JSON.stringify(work(LESSON))]);
    const result = await withReplies((_b, a) => alter(a), () => submissionsOf(COURSE, rows));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}

for (const [label, raw] of [
  ["broken JSON", "{not json"],
  ["a record without its state", JSON.stringify({ ...work(LESSON), state: undefined })],
] as [string, string][]) {
  test(`submissionsOf: a stored record with ${label} is answered unread, never nothing handed in`, async () => {
    redis.clear();
    redis.run(["SET", sub(LESSON), raw]);
    assert.deepEqual(await submissionsOf(COURSE, rows), [{ unread: true }, null]);
  });
}

// ------------------------------------------------------------ the person's copy

const scope = { learner: WHO, courses: [{ productId: "prd_exportexact", courseId: COURSE, lessonIds: [LESSON, OTHER_LESSON], moduleIds: [] }] } as unknown as ErasureScope;
const copyWork = () => COPIERS["lib/assignment.ts"](scope);

test("copy: work that reads is copied as it was", async () => {
  redis.clear();
  redis.run(["SET", sub(LESSON), JSON.stringify(work(LESSON))]);
  const out = (await copyWork()) as Record<string, unknown>[];
  assert.equal(out.length, 1);
  assert.equal(out[0].lesson, LESSON);
  assert.equal(out[0].text, "A synthetic answer.");
  assert.equal(out[0].feedback, "Synthetic feedback.");
});

test("copy: a stored record that does not read is in the copy, said as not read, never left out", async () => {
  redis.clear();
  redis.run(["SET", sub(LESSON), "{not json"]);
  redis.run(["SET", sub(OTHER_LESSON), JSON.stringify(work(OTHER_LESSON))]);
  const out = (await copyWork()) as Record<string, unknown>[];
  assert.equal(out.length, 2, JSON.stringify(out));
  const unread = out.find((r) => r.lesson === LESSON);
  assert.ok(unread, "the unread record is in the copy");
  assert.equal(unread.course, "prd_exportexact");
  assert.match(String(unread.unread), /could not be read/);
  assert.equal(out.find((r) => r.lesson === OTHER_LESSON)?.text, "A synthetic answer.");
});

test("copy: an unknown reply fails the part, so the copy is not handed over with it missing", async () => {
  redis.clear();
  redis.run(["SET", sub(LESSON), JSON.stringify(work(LESSON))]);
  const result = await withReplies(() => [], copyWork);
  assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
});

// ------------------------------------------------------------ the studio's list

const studio = (unread: number) =>
  renderToStaticMarkup(
    createElement(CourseWorkStudio, {
      productId: "prd_exportexact",
      rows: [],
      total: unread,
      showing: "waiting",
      hrefs: { waiting: "#w", all: "#a" },
      ai: { on: false, left: 0 },
      unread,
    } as Parameters<typeof CourseWorkStudio>[0]),
  );

test("studio: work that could not be read is said, never 'nothing is waiting'", () => {
  const html = studio(2);
  assert.match(html, /2 pieces of work could not be read/);
  assert.doesNotMatch(html, /Nothing is waiting/);
});

test("studio: with nothing unread, the list is as it was", () => {
  const html = studio(0);
  assert.doesNotMatch(html, /could not be read/);
  assert.match(html, /Nothing is waiting/);
});

test("studio: the course page counts the unread work and gives it to the list", () => {
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  assert.match(page, /isUnreadSubmission/);
  assert.match(page, /unread=\{unreadWork\}/);
});

// ------------------------------------------------------------ readTaskFor

test("readTaskFor: a written prompt reads, and nil is no assignment", async () => {
  redis.clear();
  redis.run(["SET", taskKey(LESSON), JSON.stringify(task)]);
  assert.deepEqual(await readTaskFor(COURSE, LESSON), task);
  assert.equal(await readTaskFor(COURSE, OTHER_LESSON), null);
});

for (const [label, alter] of [
  ["no reply", () => []],
  ["a number", () => [5]],
  ["broken JSON", () => ["{"]],
  ["JSON of another shape", () => [JSON.stringify(["a"])]],
  ["an empty prompt", () => [JSON.stringify({ ...task, prompt: "" })]],
  ["a switch that is not a switch", () => [JSON.stringify({ ...task, review: "yes" })]],
] as [string, () => unknown[]][]) {
  test(`readTaskFor: ${label} throws, never "no assignment"`, async () => {
    redis.clear();
    redis.run(["SET", taskKey(LESSON), JSON.stringify(task)]);
    const result = await withReplies(() => alter(), () => readTaskFor(COURSE, LESSON));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}
