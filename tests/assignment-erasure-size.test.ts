/**
 * A student's erasure gives back only a handed-in file's real size (Codex N on #3078, proof
 * tests/n-3078-erasure-size.proof.ts on codex/n-review-3078-assignment-credit): forgetTasksPerson read the size from
 * the parsed submission with `Number(bytes) || 0`, so a size stored as text ("5000"), or one that is not a whole
 * number, was given back as it read, and the room counter fell below what the store still keeps. A size is now taken
 * only when it is a safe positive whole number; anything else gives nothing back and is said in the log (CX-123 rule
 * 24: never read as a size, never zero-as-success). Rule 30: applyTaskDrop's sizes are held to the same test.
 * Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyTaskDrop, forgetTasksPerson, readTaskDrop } from "@/lib/assignment";
import { store as redis } from "./redis-stub";

const COURSE = "crs_n3078";
const LESSON = "lsnn3078aaaa";
const KEPT = "lsnkeptaaaaa";
const WHO = "0123456789abcdef";
const ROOM = "n3078-room";
const bytesKey = `nl:tasks:bytes:${ROOM}`;
const filesKey = (l: string) => `nl:course:${COURSE}:task:${l}:files`;
const subKey = `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`;
const DATA = { sid: "s_n3078", statsId: "st_n3078" } as unknown as Parameters<typeof applyTaskDrop>[2];

/** Lesson LESSON: WHO's file of 100 bytes, its size in the submission `bytes`. Lesson KEPT: 1000 bytes that stay. */
function seed(bytes: unknown) {
  redis.clear();
  redis.run(["SET", bytesKey, "1100"]);
  redis.run(["HSET", filesKey(LESSON), "a.pdf", "100"]);
  redis.run(["HSET", filesKey(KEPT), "kept.pdf", "1000"]);
  const sub = { text: "x", file: { path: "a.pdf", name: "a.pdf", bytes, type: "application/pdf" }, at: 1, state: "waiting", feedback: "", reviewedAt: 0, tries: 1 };
  redis.run(["SET", subKey, JSON.stringify(sub)]);
  redis.run(["ZADD", `nl:course:${COURSE}:tasks:all`, 1, `${LESSON}|${WHO}`]);
}

const counter = () => Number(redis.run(["GET", bytesKey]));

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

test("control: a whole-number size is given back, and only it", async () => {
  seed(100);
  const { value, lines } = await logged(() => forgetTasksPerson(COURSE, [LESSON], WHO, ROOM));
  assert.equal(counter(), 1000);
  assert.deepEqual(value, { records: 1, files: ["a.pdf"] });
  assert.deepEqual(lines, []);
});

for (const [label, bytes] of [
  ["text \"5000\" (Codex N's case)", "5000"],
  ["a fraction", 100.5],
  ["a negative", -5],
  ["zero", 0],
  ["past the safe integers", 2 ** 53 + 2],
  ["missing", undefined],
  ["an object", { n: 5000 }],
] as const) {
  test(`erasure with a submission size that is ${label}: nothing given back, said in the log, the file still removed`, async () => {
    seed(bytes);
    const { value, lines } = await logged(() => forgetTasksPerson(COURSE, [LESSON], WHO, ROOM));
    assert.equal(counter(), 1100, "the 1000 kept bytes stay counted; no unknown size is given back");
    assert.deepEqual(value, { records: 1, files: ["a.pdf"] }, "the record goes and its file is still returned to be deleted");
    assert.equal(redis.run(["HGET", filesKey(LESSON), "a.pdf"]), null, "the file left the files' hash");
    assert.equal(lines.some((l) => l.includes("not giving back the room")), true, `logged: ${JSON.stringify(lines)}`);
  });
}

test("rule 30: a drop whose sizes are not safe positive whole numbers gives none of them back", async () => {
  seed(100);
  const drop = await readTaskDrop(COURSE, LESSON);
  assert.deepEqual(drop.sizes, [100]);
  const { value, lines } = await logged(() => applyTaskDrop({ ...drop, sizes: [Number.NaN] }, ROOM, DATA));
  assert.deepEqual(value, ["a.pdf"]);
  assert.equal(counter(), 1100);
  assert.equal(lines.some((l) => l.includes("not giving back the room")), true, `logged: ${JSON.stringify(lines)}`);
});

test("rule 30: a drop read exactly still gives its file back", async () => {
  seed(100);
  const drop = await readTaskDrop(COURSE, LESSON);
  const { lines } = await logged(() => applyTaskDrop(drop, ROOM, DATA));
  assert.equal(counter(), 1000);
  assert.deepEqual(lines, []);
});
