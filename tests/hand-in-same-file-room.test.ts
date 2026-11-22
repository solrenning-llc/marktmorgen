/**
 * Handing in again while keeping the same file charges the store's data room no second file entry (#4486, Codex C2).
 *
 * handIn (lib/assignment.ts) charged ENTRY_BYTES whenever the hand-in carried a file. A student who kept file A and
 * only changed the text (the route passes the kept file back) wrote the same field of the lesson's files hash again,
 * so Redis still held one entry, but the room was charged another ENTRY_BYTES each time. Dropping the assignment gives
 * back one entry per field actually in the hash, so every duplicate charge stayed for good, and enough of them made
 * the creator's other data, or later work, fail with "no room".
 *
 * Now the entry is charged only for a file path that is not the kept one. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyTaskDrop, handIn, readTaskDrop } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { dataUsed } from "@/lib/store-data";
import { ENTRY_BYTES } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";

const COURSE = "crs_same";
const LESSON = "lsnsameaaaaa";
const WHO = "0123456789abcdef";
const ROOM = "same-room";
const DATA = { sid: "s_same", statsId: "st_same" } as unknown as Parameters<typeof applyTaskDrop>[2];
const TASK: Task = { prompt: "Write it.", review: true, gate: false, file: true };
const A = { path: "a.pdf", name: "a.pdf", bytes: 100, type: "application/pdf" };
const B = { path: "b.pdf", name: "b.pdf", bytes: 100, type: "application/pdf" };
const filesKey = `nl:course:${COURSE}:task:${LESSON}:files`;

const used = async () => (await dataUsed(DATA))?.used ?? Number.NaN;
const hand = (text: string, file: typeof A | null, now: number) =>
  handIn({ data: DATA, courseId: COURSE, lessonId: LESSON, who: WHO, email: "", task: TASK, text, file, now });

test("handing in again with the same file charges no second file entry, and a drop gives everything back", async () => {
  redis.clear();
  const empty = await used();
  await hand("First.", A, 1_000);
  const first = await used();
  assert.ok(first > empty, "the first hand-in is charged");
  assert.equal(redis.run(["HLEN", filesKey]), 1);
  // The same length of text, the same moment's width and one more try of one digit: the record weighs the same.
  await hand("Again.", A, 1_000);
  assert.equal(redis.run(["HLEN", filesKey]), 1, "still one file entry in the hash");
  assert.equal((await used()) - first, 0, `the kept file is charged no second entry (was +${ENTRY_BYTES})`);
  await hand("Third.", A, 1_000);
  assert.equal((await used()) - first, 0, "nor a third");
  await applyTaskDrop(await readTaskDrop(COURSE, LESSON), ROOM, DATA);
  assert.equal(await used(), empty, "dropping the assignment gives the room back whole");
});

test("control: a new file path is charged its entry, and the replaced one's is given back", async () => {
  redis.clear();
  await hand("First.", A, 1_000);
  const first = await used();
  await hand("Again.", B, 1_000);
  assert.equal(redis.run(["HLEN", filesKey]), 1, "a.pdf is out, b.pdf is in");
  assert.equal((await used()) - first, 0, "one entry charged for b.pdf, one given back for a.pdf");
});
