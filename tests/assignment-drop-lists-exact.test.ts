/**
 * readTaskDrop reads the files' hash (HGETALL) and the list of work (ZRANGEBYSCORE) only as a plain list of text,
 * from its own slots (stringList; CX-123 rule 24, Claude 4): a Proxy, a hole or a member that is not text is unknown
 * and throws UnknownReplyError before anything is deleted. Synthetic data only; replies are swapped on the in-memory
 * Redis (tests/redis-stub.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readTaskDrop } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const COURSE = "crs_leftover";
const LESSON = "lsn_leftover";
const WHO = "0123456789abcdef";
const filesKey = `nl:course:${COURSE}:task:${LESSON}:files`;
const allKey = `nl:course:${COURSE}:tasks:all`;

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

const holed = (list: unknown) => {
  const out = [...(list as unknown[])];
  out.length += 1; // a hole at the end: no own slot, so .every and Array.isArray never see it
  return out;
};

const READ_SHAPES: [string, Alter][] = [
  ["files: a Proxy of a list", on("HGETALL", (reply) => new Proxy(reply as unknown[], {}))],
  ["files: an object, not a list", on("HGETALL", () => ({ "a.pdf": "100", "b.pdf": "50" }))],
  ["work list: a Proxy of a list", on("ZRANGEBYSCORE", (reply) => new Proxy(reply as unknown[], {}))],
  ["work list: a hole", on("ZRANGEBYSCORE", holed)],
  ["work list: a member that is not text", on("ZRANGEBYSCORE", (reply) => [...(reply as unknown[]), 7])],
];

for (const [label, alter] of READ_SHAPES) {
  test(`readTaskDrop, ${label}: unknown, never read as a list`, async () => {
    seed();
    await assert.rejects(
      withReplies(alter, () => readTaskDrop(COURSE, LESSON)),
      UnknownReplyError,
      `${label}: throws UnknownReplyError`,
    );
    assert.equal(redis.run(["HLEN", filesKey]), 2, `${label}: nothing deleted`);
  });
}

test("readTaskDrop, healthy: every file and every piece of work read", async () => {
  seed();
  const drop = await readTaskDrop(COURSE, LESSON);
  assert.deepEqual([...drop.files].sort(), ["a.pdf", "b.pdf"]);
  assert.equal(drop.bytes, 150);
  assert.deepEqual(drop.gone, [`${LESSON}|${WHO}`]);
});

test("readTaskDrop, confirmed absence: no files and no work is an empty drop", async () => {
  redis.clear();
  const drop = await readTaskDrop(COURSE, LESSON);
  assert.deepEqual(drop.files, []);
  assert.deepEqual(drop.gone, []);
  assert.equal(drop.bytes, 0);
});

