import assert from "node:assert/strict";
import { test } from "node:test";
import { saveNote, readNote, notesOf, notesAsText } from "@/lib/lesson-notes";
import { lessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { laterPageCost } from "./traffic-cost";
import { UPSTASH_MICRO_USD_PER_GB_TRANSFER } from "@/lib/spend-cost-table";

const STATS = "j3031store";
const LEARNER = "a".repeat(32);
const COURSE = "c".repeat(32);
const OTHER_COURSE = "d".repeat(32);
const key = `nl:lnote:${STATS}:${LEARNER}`;
const lesson = (i: number) => `l${String(i).padStart(11, "0")}`;
// At most 200 lessons per course; the store-wide note cap spans courses.
const courseFor = (i: number) => i < 200 ? COURSE : OTHER_COURSE;
const field = (i: number) => `${courseFor(i)}:${lesson(i)}`;
const input = (i: number, text: string, was = "") => ({ statsId: STATS, learner: LEARNER, courseId: courseFor(i), lessonId: lesson(i), text, was, room: ROOM, now: 1_794_009_600_000 });
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let commands = 0;
const measured = async (batch: Command[]) => {
  commands += batch.length;
  assert.ok(commands <= 2_000, "per-case command ceiling, including setup");
  return real(batch);
};
function reset() { redis.clear(); commands = 0; redis.pipeline = measured; }
async function together<T>(body: () => Promise<T>) {
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  redis.pipeline = async batch => {
    const reply = await measured(batch);
    if (batch.length === 2 && batch[0][0] === "HLEN" && batch[0][1] === key && batch[1][0] === "HGET") {
      arrived += 1;
      if (arrived === 2) release();
      await barrier;
    }
    return reply;
  };
  try { return await body(); }
  finally { redis.pipeline = measured; }
}

test("healthy sequential saves retain the latest note and refuse a stale tab", async () => {
  reset();
  assert.deepEqual(await saveNote(input(1, "first")), { ok: true, text: "first" });
  assert.deepEqual(await saveNote(input(1, "second", "first")), { ok: true, text: "second" });
  assert.deepEqual(await saveNote(input(1, "stale", "first")), { ok: false, reason: "changed" });
  const kept = await readNote(STATS, LEARNER, COURSE, lesson(1));
  assert.equal(kept.state === "kept" && kept.text, "second");
  console.log(JSON.stringify({ case: "healthy-sequential", commands }));
});

test("two simultaneous saves from one original cannot both acknowledge conflicting replacements", async () => {
  reset();
  assert.equal((await saveNote(input(1, "original"))).ok, true);
  const result = await together(() => Promise.all([
    saveNote(input(1, "first replacement", "original")),
    saveNote(input(1, "second replacement", "original")),
  ]));
  const kept = await readNote(STATS, LEARNER, COURSE, lesson(1));
  console.log(JSON.stringify({ case: "same-note-concurrency", result, kept, commands }));
  assert.equal(result.filter(r => r.ok).length, 1, "only one conflicting save may be confirmed; the other must be changed/unknown");
});

test("the 300-note ceiling still holds when two different notes share the last available place", async () => {
  reset();
  const seed: Command = ["HSET", key];
  for (let i = 0; i < 299; i += 1) seed.push(field(i), JSON.stringify({ t: "kept", at: 1_794_009_600 }));
  await measured([seed]);
  const result = await together(() => Promise.all([
    saveNote(input(300, "new A")), saveNote(input(301, "new B")),
  ]));
  const [count] = await measured([["HLEN", key]]);
  console.log(JSON.stringify({ case: "count-concurrency", result, count, commands }));
  assert.ok(typeof count === "number" && count <= 300, "two acknowledged saves must not turn a valid 299-note hash into 301 notes");
});

test("a maximum legitimate notes download fits the one public request that admits it", async () => {
  reset();
  const seed: Command = ["HSET", key];
  for (let i = 0; i < 300; i += 1) seed.push(field(i), JSON.stringify({ t: "🙂".repeat(4_000), at: 1_794_009_600 }));
  await measured([seed]);
  let replyBytes = 0;
  redis.pipeline = async batch => {
    const reply = await measured(batch);
    replyBytes += Buffer.byteLength(JSON.stringify(reply), "utf8");
    return reply;
  };
  const notes = await notesOf(STATS, LEARNER);
  assert.equal(notes.length, 300, "healthy maximum-note fixture must be fully read");
  // The real GET reads every course's notes, then filters for its course.
  const text = notesAsText({ words: lessonNotesWords("en"), courseTitle: "Course", storeName: "Store", day: "November 6, 2026", lessons: [], notes: notes.filter(note => note.course === COURSE) });
  const bytes = Buffer.byteLength(text, "utf8");
  // The original draft compared raw origin bytes, although origin transfer can
  // be compressed. This lower bound instead uses the registry's database
  // transfer coefficient on the complete JSON reply, excluding origin/CPU.
  const transferAlone = replyBytes * (UPSTASH_MICRO_USD_PER_GB_TRANSFER / 1_000_000) / 1_000_000_000;
  const admitted = laterPageCost();
  console.log(JSON.stringify({ case: "download-ceiling", commands, replyBytes, responseBytes: bytes, transferAlone, admitted }));
  assert.ok(transferAlone <= admitted, "database transfer alone must fit the existing single public-request cost, before commands/compute/origin overhead");
});
