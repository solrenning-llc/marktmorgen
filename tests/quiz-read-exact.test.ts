/**
 * A lesson's quiz is read only in its exact shape (CX-123 rule 24; Claude 5 on #2858, the sibling of readTaskFor):
 *
 *   - a reply cut short or of another shape throws UnknownReplyError, never "this lesson has no quiz";
 *   - a record that is there but does not read as saveQuiz wrote it (broken JSON, a pass mark out of bounds, a bank
 *     setting out of bounds) throws QuizRecordUnreadError, never a quiz with the default pass mark or with every
 *     question; the page of the lesson still shows the lesson, without the quiz and with an honest notice, and the
 *     studio can save the quiz again over it;
 *   - saving reads what it replaces exactly: an unknown reply charges nothing and writes nothing.
 *
 * Confirmed absence (GET nil) stays "no quiz", and the legacy shapes the store already keeps stay readable.
 * Synthetic data only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as quizLib from "@/lib/quiz";
import { type Quiz, readQuizFor, saveQuiz } from "@/lib/quiz";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const COURSE = "a".repeat(32);
const LESSON = "lessonexact1";
const KEY = `nl:course:${COURSE}:quiz:${LESSON}`;

const one = { id: "question0001", text: "First question", kind: "single", choices: ["One", "Two"], correct: [0], explanation: "Because." };
const record = { passPercent: 80, attempts: 3, required: true, questions: [one, { ...one, id: "question0002", correct: [1] }] };

type Batch = (string | number)[][];
async function withReplies<T>(alter: (batch: Batch, answers: unknown[]) => unknown, run: () => Promise<T>): Promise<{ value?: T; error?: unknown; sent: Batch[] }> {
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

const nameOf = (error: unknown) => (error instanceof Error ? error.name : "no error");
const store = (value: unknown) => redis.run(["SET", KEY, typeof value === "string" ? value : JSON.stringify(value)]);

test("a reply cut short or of another shape is unknown, never 'no quiz'", async () => {
  redis.clear();
  store(record);
  const shapes: [string, (batch: Batch, answers: unknown[]) => unknown][] = [
    ["no reply at all", () => []],
    ["a number", () => [42]],
    ["an object", () => [{}]],
    ["an extra reply", (_b, answers) => [...answers, null]],
    ["not a list", () => "OK"],
  ];
  for (const [what, alter] of shapes) {
    const read = await withReplies(alter, () => readQuizFor(COURSE, LESSON));
    assert.equal(nameOf(read.error), "UnknownReplyError", `${what}: ${JSON.stringify(read.value)}`);
  }
});

test("a record that does not read as saveQuiz wrote it is unread, never a quiz with defaults", async () => {
  const broken: [string, unknown][] = [
    ["broken JSON", "{\"passPercent\":"],
    ["not an object", "[1,2]"],
    ["pass mark missing", { ...record, passPercent: undefined }],
    ["pass mark zero", { ...record, passPercent: 0 }],
    ["pass mark over 100", { ...record, passPercent: 101 }],
    ["pass mark not a number", { ...record, passPercent: "most" }],
    ["pass mark a fraction", { ...record, passPercent: 70.5 }],
    ["draw out of bounds", { ...record, draw: 2 }],
    ["draw not a number", { ...record, draw: "one" }],
    ["wait out of bounds", { ...record, waitMinutes: 0 }],
    ["shuffle not a switch", { ...record, shuffle: "yes" }],
    ["required not a switch", { ...record, required: "yes" }],
    ["a broken question", { ...record, questions: [one, { ...one, id: "question0002", correct: [] }] }],
  ];
  for (const [what, value] of broken) {
    redis.clear();
    store(value);
    const read = await withReplies((_b, answers) => answers, () => readQuizFor(COURSE, LESSON));
    assert.equal(nameOf(read.error), "QuizRecordUnreadError", `${what}: ${JSON.stringify(read.value)}`);
    assert.equal(read.sent.length, 1, `${what}: one read, no retry`);
  }
});

test("confirmed absence and the shapes already kept read as before", async () => {
  redis.clear();
  assert.equal(await readQuizFor(COURSE, LESSON), null, "GET nil is no quiz");
  store(record);
  assert.equal((await readQuizFor(COURSE, LESSON))?.passPercent, 80);
  store({ ...record, draw: 1, shuffle: true, waitMinutes: 15 });
  const bank = await readQuizFor(COURSE, LESSON);
  assert.deepEqual([bank?.draw, bank?.shuffle, bank?.waitMinutes], [1, true, 15]);
  store({ ...record, shuffle: false });
  assert.equal((await readQuizFor(COURSE, LESSON))?.shuffle, undefined, "a switch kept off reads as off");
  store({ ...record, attempts: "0", passPercent: "100", required: undefined, questions: [{ ...one, kind: undefined, explanation: undefined }] });
  const legacy = await readQuizFor(COURSE, LESSON);
  assert.deepEqual([legacy?.attempts, legacy?.passPercent, legacy?.required, legacy?.questions[0].kind], [0, 100, false, "single"]);
});

test("the lesson page's read: an unread record is said as unread, an unknown reply still throws", async () => {
  const shown = (quizLib as Record<string, unknown>).quizShownFor as ((c: string, l: string) => Promise<{ quiz: Quiz | null; unread: boolean }>) | undefined;
  assert.equal(typeof shown, "function", "quizShownFor exists");
  if (!shown) return;
  redis.clear();
  assert.deepEqual(await shown(COURSE, LESSON), { quiz: null, unread: false });
  store({ ...record, passPercent: 0 });
  assert.deepEqual(await shown(COURSE, LESSON), { quiz: null, unread: true });
  store(record);
  assert.equal((await shown(COURSE, LESSON)).quiz?.questions.length, 2);
  const cut = await withReplies(() => [], () => shown(COURSE, LESSON));
  assert.equal(nameOf(cut.error), "UnknownReplyError");
});

test("saving reads what it replaces exactly, and saves over an unread record", async () => {
  redis.clear();
  store(record);
  const quiz = (await readQuizFor(COURSE, LESSON))!;
  const cut = await withReplies((batch, answers) => (batch.some((c) => c[0] === "GET" && c[1] === KEY) ? [] : answers), () => saveQuiz(COURSE, LESSON, { ...quiz, passPercent: 90 }, ROOM));
  assert.equal(nameOf(cut.error), "UnknownReplyError", "an unknown reply of what is replaced refuses the save");
  assert.equal(cut.sent.length, 1, "nothing charged and nothing written after it");
  assert.equal((await readQuizFor(COURSE, LESSON))?.passPercent, 80, "the record is as it was");

  store("{\"passPercent\":");
  const over = await withReplies((_b, answers) => answers, () => saveQuiz(COURSE, LESSON, { ...quiz, passPercent: 90 }, ROOM));
  assert.equal(over.error, undefined, "an unread record is saved over");
  assert.equal((await readQuizFor(COURSE, LESSON))?.passPercent, 90);
});

test("each reader of a lesson's quiz handles an unread record", () => {
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  assert.match(page, /quizShownFor\(course\.id, lesson\.id\)/, "the lesson page reads through quizShownFor");
  assert.doesNotMatch(page, /readQuizFor/, "the lesson page never reads a quiz that could take the whole page down");
  assert.match(page, /quizUnread/, "the lesson page says when the quiz could not be read");

  const answer = readFileSync("app/api/store/course/quiz/route.ts", "utf8");
  assert.match(answer, /QuizRecordUnreadError/, "answering an unread quiz goes back to the lesson, which says why");
  assert.match(answer, /UnknownReplyError/, "an unknown reply is 'try again', never a mark");

  const studio = readFileSync("app/api/store/course/route.ts", "utf8");
  assert.match(studio, /unread: true/, "the studio is told the saved quiz could not be read");
  assert.match(studio, /QuizRecordUnreadError/, "saving over an unread quiz is allowed");

  const editor = readFileSync("components/quiz-editor.tsx", "utf8");
  assert.match(editor, /data\.unread/, "the studio's editor opens a fresh quiz over an unread one and says so");

  const mcp = readFileSync("lib/mcp-tools.ts", "utf8");
  assert.match(mcp, /quiz_unread/, "get_lesson says the quiz could not be read, never that there is none");
});
