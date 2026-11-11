import assert from "node:assert/strict";
import test from "node:test";
import { attemptOf, readQuiz, submitQuiz, type Quiz } from "@/lib/quiz";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const COURSE = "a".repeat(32);
const LESSON = "lesson000001";
const LEARNER = "learner";

function quiz(): Quiz {
  const parsed = readQuiz({
    passPercent: 70,
    attempts: 2,
    required: false,
    questions: [{ text: "Which is correct?", choices: ["Yes", "No"], correct: [0], explanation: "Yes." }],
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.quiz;
}

async function attemptWith(reply: unknown[]): Promise<Awaited<ReturnType<typeof attemptOf>>> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async commands => {
    assert.equal(commands.length, 2);
    assert.deepEqual(commands.map(command => command[0]), ["GET", "GET"]);
    return reply;
  }) as typeof redis.pipeline;
  try {
    return await attemptOf(COURSE, LESSON, LEARNER);
  } finally {
    redis.pipeline = original;
  }
}

test("quiz attempt reads require the exact two-answer Redis envelope", async () => {
  redis.clear();
  assert.deepEqual(await attemptWith([null, null]), { used: 0, last: null, best: 0, passed: false });

  const sparse = new Array(2) as unknown[];
  sparse[1] = null;
  const inherited = new Array(2) as unknown[];
  Object.setPrototypeOf(inherited, { 0: null, 1: null });
  let accessorReads = 0;
  const accessor = new Array(2) as unknown[];
  Object.defineProperty(accessor, "0", { enumerable: true, configurable: true, get() { accessorReads += 1; return null; } });
  Object.defineProperty(accessor, "1", { enumerable: true, configurable: true, value: null });

  for (const reply of [[], [null], [null, null, "extra"], sparse, inherited, accessor]) {
    await assert.rejects(() => attemptWith(reply), /attempt evidence is unavailable/i);
  }
  assert.equal(accessorReads, 0, "an accessor reply must be refused without executing it");
});

test("quiz attempt reads refuse wrong slot types and malformed stored attempts", async () => {
  redis.clear();
  const malformedReplies: unknown[][] = [
    [0, null],
    [{}, null],
    ["{", null],
    [null, 0],
    [null, 1],
    [null, {}],
  ];

  for (const reply of malformedReplies) {
    await assert.rejects(
      () => attemptWith(reply),
      /attempt evidence is unavailable/i,
      `wrong Redis slot evidence must not become a known attempt: ${JSON.stringify(reply)}`,
    );
  }
});

test("unknown attempt evidence stops a submission before reservations, counters, or writes", async () => {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  let first = true;
  redis.pipeline = (async batch => {
    commands.push(...batch);
    if (first) {
      first = false;
      return [null, null, "extra"];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    const current = quiz();
    const result = await submitQuiz(
      COURSE,
      LESSON,
      LEARNER,
      current,
      { [current.questions[0].id]: [1] },
      undefined,
      undefined,
      ROOM,
    );
    assert.deepEqual(result, { ok: false, reason: "unavailable" });
    assert.deepEqual(commands.map(command => command[0]), ["GET", "GET"]);
  } finally {
    redis.pipeline = original;
  }
});

test("wrong attempt slot types stop a submission before later IO", async () => {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  let first = true;
  redis.pipeline = (async batch => {
    commands.push(...batch);
    if (first) {
      first = false;
      return [0, null];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    const current = quiz();
    delete current.usagePolicy;
    const result = await submitQuiz(
      COURSE,
      LESSON,
      LEARNER,
      current,
      { [current.questions[0].id]: [1] },
      undefined,
      undefined,
      ROOM,
    );
    assert.deepEqual(result, { ok: false, reason: "unavailable" });
    assert.deepEqual(commands.map(command => command[0]), ["GET", "GET"]);
  } finally {
    redis.pipeline = original;
  }
});
