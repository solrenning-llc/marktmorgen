/**
 * releaseBytes reads the DECRBY's answer, the counter's new total, only as a whole number (CX-123 rule 24; Claude 4).
 * Anything else is not "given back": releaseBytes answers false and logs it, never blocking a deletion that already
 * happened (applyTaskDrop still returns its files), and undoTakeRoom, whose caller already handles
 * UnknownReplyError, throws it instead of answering true. Synthetic data only; replies are swapped on the in-memory
 * Redis (tests/redis-stub.ts).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyTaskDrop, readTaskDrop, releaseBytes, undoTakeRoom } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const COURSE = "crs_release";
const LESSON = "lsn_release";
const WHO = "0123456789abcdef";
const filesKey = `nl:course:${COURSE}:task:${LESSON}:files`;
const allKey = `nl:course:${COURSE}:tasks:all`;
const ROOM = "release-room";
const bytesKey = `nl:tasks:bytes:${ROOM}`;
const DATA = { sid: "s_release", statsId: "st_release" } as unknown as Parameters<typeof applyTaskDrop>[2];

function seed() {
  redis.clear();
  redis.run(["HSET", filesKey, "a.pdf", "100", "b.pdf", "50"]);
  redis.run(["ZADD", allKey, 1, `${LESSON}|${WHO}`]);
}

type Alter = (batch: (string | number)[][], answers: unknown[]) => unknown[];

async function withReplies<T>(alter: Alter, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => alter(batch, await original(batch))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

/** The first reply of a batch whose first command is `name`, replaced by what `swap` makes of it. */
const on = (name: string, swap: (reply: unknown) => unknown): Alter => (batch, answers) => (batch[0]?.[0] === name ? [swap(answers[0]), ...answers.slice(1)] : answers);

/** console.error's lines while `run` runs. */
async function logged<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: await run(), lines };
  } finally {
    console.error = original;
  }
}

const DECRBY_SHAPES: [string, unknown[]][] = [
  ["no reply", []],
  ["null", [null]],
  ["text", ["50"]],
  ["a fraction", [1.5]],
  ["an object", [{}]],
];

for (const [label, replies] of DECRBY_SHAPES) {
  test(`releaseBytes, DECRBY answers ${label}: not given back, and said so`, async () => {
    redis.clear();
    redis.run(["SET", bytesKey, "200"]);
    const { value, lines } = await logged(() => withReplies((batch, answers) => (batch[0]?.[0] === "DECRBY" ? replies : answers), () => releaseBytes(ROOM, 50)));
    assert.equal(value, false, `${label}: never "given back"`);
    assert.ok(lines.some((line) => line.includes("room")), `${label}: logged`);
  });
}

test("releaseBytes, healthy: given back, and a total below zero comes back to zero", async () => {
  redis.clear();
  redis.run(["SET", bytesKey, "200"]);
  assert.equal(await releaseBytes(ROOM, 50), true);
  assert.equal(redis.run(["GET", bytesKey]), "150");
  assert.equal(await releaseBytes(ROOM, 500), true);
  assert.equal(redis.run(["GET", bytesKey]), "0");
});

test("undoTakeRoom, DECRBY unknown after the mark was removed: throws UnknownReplyError, never true", async () => {
  redis.clear();
  redis.run(["SET", bytesKey, "200"]);
  redis.run(["SET", `nl:tasks:taken:${createHash("sha256").update("stores/s/tasks/x.pdf").digest("hex").slice(0, 40)}`, "50"]);
  await assert.rejects(
    logged(() => withReplies(on("DECRBY", () => "50"), () => undoTakeRoom(ROOM, 50, "stores/s/tasks/x.pdf"))),
    UnknownReplyError,
  );
});

test("applyTaskDrop, DECRBY unknown: the deletion that happened still returns its files, and the reply is logged", async () => {
  seed();
  redis.run(["SET", bytesKey, "200"]);
  const drop = await readTaskDrop(COURSE, LESSON);
  const { value, lines } = await logged(() => withReplies(on("DECRBY", () => null), () => applyTaskDrop(drop, ROOM, DATA)));
  assert.deepEqual([...value].sort(), ["a.pdf", "b.pdf"], "the files go to be deleted all the same");
  assert.equal(redis.run(["HLEN", filesKey]), 0, "the list was forgotten");
  assert.ok(lines.some((line) => line.includes("room")), "the unknown give-back is logged");
});
