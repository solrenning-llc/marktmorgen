/**
 * Removing an assignment reads what it removes exactly (CX-123 rules 24 and 30; Claude 4, LEVE after Codex P on #2655):
 * a list of handed-in files, a list of work or a record in another shape is unknown, and nothing is deleted, so the
 * files' list is never lost while the files themselves stay kept (paid storage nobody could find again).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dropTask } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "../../tests/redis-stub";

const COURSE = "crs_dropexact";
const LESSON = "lsn_dropexact";
const filesKey = `nl:course:${COURSE}:task:${LESSON}:files`;
const ROOM = { sid: "s_dropexact", statsId: "st_dropexact" } as unknown as Parameters<typeof dropTask>[3];

async function seed() {
  redis.clear();
  redis.run(["HSET", filesKey, "a.pdf", "100", "b.pdf", "50"]);
}

async function dropWith(alter: (batch: (string | number)[][], answers: unknown[]) => unknown[]) {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => alter(batch, await original(batch))) as typeof redis.pipeline;
  try {
    return await dropTask(COURSE, LESSON, null, ROOM).then((files) => ({ files }), (error) => ({ error }));
  } finally {
    redis.pipeline = original;
  }
}

test("a healthy read returns every file and forgets the list", async () => {
  await seed();
  const result = await dropWith((_batch, answers) => answers);
  assert.deepEqual("files" in result ? [...result.files].sort() : result, ["a.pdf", "b.pdf"]);
  assert.equal(redis.run(["HLEN", filesKey]), 0);
});

const SHAPES: [string, (batch: (string | number)[][], answers: unknown[]) => unknown[]][] = [
  ["files: no reply", (batch, answers) => (batch[0]?.[0] === "HGETALL" ? [] : answers)],
  ["files: null", (batch, answers) => (batch[0]?.[0] === "HGETALL" ? [null] : answers)],
  ["files: odd list", (batch, answers) => (batch[0]?.[0] === "HGETALL" ? [["a.pdf"]] : answers)],
  ["files: a size not a whole number", (batch, answers) => (batch[0]?.[0] === "HGETALL" ? [["a.pdf", "1e3"]] : answers)],
  ["files: a name not text", (batch, answers) => (batch[0]?.[0] === "HGETALL" ? [[7, "100"]] : answers)],
  ["work list: null", (batch, answers) => (batch[0]?.[0] === "ZRANGEBYSCORE" ? [null] : answers)],
  ["records: one reply missing", (batch, answers) => (batch[0]?.[0] === "GET" ? answers.slice(0, -1) : answers)],
];

for (const [label, alter] of SHAPES) {
  test(`${label}: unknown, and the list of files is kept`, async () => {
    await seed();
    const result = await dropWith(alter);
    assert.ok("error" in result && result.error instanceof UnknownReplyError, `${label}: throws UnknownReplyError`);
    assert.equal(redis.run(["HLEN", filesKey]), 2, `${label}: nothing deleted`);
  });
}
