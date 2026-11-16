/**
 * Removing an assignment reads what it removes exactly (CX-123 rules 24 and 30; Claude 4, LEVE after Codex P on #2655):
 * a list of handed-in files, a list of work or a record in another shape is unknown, and nothing is deleted, so the
 * files' list is never lost while the files themselves stay kept (paid storage nobody could find again).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { applyTaskDrop, dropTask, readCourseTaskDrops, readTaskDrop } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

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

test("a file handed in after the reading stays listed, never lost (Revisor 1 on #2810)", async () => {
  await seed();
  const drop = await readTaskDrop(COURSE, LESSON);
  redis.run(["HSET", filesKey, "late.pdf", "10"]);
  const files = await applyTaskDrop(drop, null, ROOM);
  assert.deepEqual([...files].sort(), ["a.pdf", "b.pdf"]);
  assert.deepEqual(redis.run(["HGETALL", filesKey]), ["late.pdf", "10"]);
});

test("the course route reads the work before it saves the course without the assignment", () => {
  const route = readFileSync("app/api/store/course/route.ts", "utf8");
  for (const [read, save] of [[route.indexOf("const drop = await readTaskDrop("), route.indexOf("await save(result.course);\n          const files = await applyTaskDrop(")], [route.indexOf("taskDrops.push(drop)"), route.indexOf("await save(result.course);\n      const lessons")]]) {
    assert.ok(read > 0 && save > read, "read first, then save");
  }
  assert.equal((route.match(/error: "unavailable" \}, \{ status: 503 \}/g) ?? []).length >= 2, true, "an unread assignment answers 503 and keeps the course as it was");
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

test("a product's course: every assignment read before the product goes (Revisor 1 on #2810)", async () => {
  await seed();
  const course = { id: COURSE, modules: [{ lessons: [{ id: LESSON, task: { prompt: "x" } }, { id: "lsn_none" }] }] };
  assert.equal((await readCourseTaskDrops(course)).length, 1, "one assignment, one reading");
  await seed();
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => (batch[0]?.[0] === "HGETALL" ? [null] : original(batch))) as typeof redis.pipeline;
  try {
    await assert.rejects(readCourseTaskDrops(course), UnknownReplyError, "an unread assignment stops the removal");
  } finally {
    redis.pipeline = original;
  }
  const route = readFileSync("app/api/store/product/route.ts", "utf8");
  const lookup = route.indexOf("before = await readListing(guarded.store, id);");
  const courseRead = route.indexOf("preparedCourse = await readCourseExact(before.course.id);");
  const read = route.indexOf("taskDrops = await readCourseTaskDrops(preparedCourse)");
  const remove = route.indexOf("const removed = await removeProduct(ref, id");
  const confirm = route.indexOf("JSON.stringify(found) !== JSON.stringify(preparedCourse)", remove);
  assert.ok(
    lookup > 0 && courseRead > lookup && read > courseRead && remove > read && confirm > remove,
    "the product route prepares the exact course's work before removal and confirms the same snapshot under the lock",
  );
  assert.ok(route.slice(read, remove).includes('error: "unavailable" }, { status: 503 }'), "and answers 503 when it cannot");
  const refuse = route.indexOf('error: "unavailable" }, { status: 503 }', courseRead);
  assert.ok(lookup > 0 && courseRead > lookup && refuse > read && refuse < remove, "a product or course that cannot be read answers 503 too, never \"not a course\"");
});
