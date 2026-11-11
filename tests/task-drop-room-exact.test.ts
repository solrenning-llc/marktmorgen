/**
 * Rule 24 / MR in dropping an assignment (lib/assignment.ts, applyTaskDrop): the room its records took in the store's
 * data room (`freed`) is given back only when every delete is confirmed by this call (each DEL answers exactly 1).
 * Replies cut short or of another shape, or a second drop racing the first (whose DELs answer 0), give nothing back:
 * the room stays counted (more, never less), never given back for records that may still be there, or twice.
 *
 * Synthetic course, lesson and student only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyTaskDrop, readTaskDrop } from "@/lib/assignment";
import { dataUsed, needData } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM as DATA } from "./data-room";

const COURSE = "crs_room";
const LESSON = "lsnroomaaaaa";
const WHO = "0123456789abcdef";
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function seed(): Promise<number> {
  redis.clear();
  const sub = { text: "x", file: null, at: 1, state: "waiting", feedback: "", reviewedAt: 0, tries: 1 };
  await pipeline([
    ["SET", `nl:course:${COURSE}:task:${LESSON}`, JSON.stringify({ prompt: "Write it.", review: true, gate: false, file: false })],
    ["SET", `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`, JSON.stringify(sub)],
    ["ZADD", `nl:course:${COURSE}:tasks:all`, 1, `${LESSON}|${WHO}`],
  ]);
  await needData(DATA, [{ slot: `ca:${COURSE}`, bytes: 5000 }]);
  return (await dataUsed(DATA))!.used;
}

for (const [label, alter] of [["no replies", () => []], ["replies of another shape", (r: unknown[]) => r.map(() => "1")]] as [string, (r: unknown[]) => unknown[]][]) {
  test(`the deletes answered as ${label}: no room given back`, async () => {
    const before = await seed();
    const drop = await readTaskDrop(COURSE, LESSON);
    assert.ok(drop.freed > 0, "(the drop has room to give back)");
    redis.pipeline = (async (b: Batch) => {
      const real = await pipeline(b);
      return b.some((c) => c[0] === "DEL" && String(c[1]) === `nl:course:${COURSE}:task:${LESSON}`) ? alter(real) : real;
    }) as typeof redis.pipeline;
    try {
      await applyTaskDrop(drop, null, DATA).catch(() => null);
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal((await dataUsed(DATA))!.used, before, "the room stays counted");
  });
}

test("two drops racing: the room comes back once", async () => {
  const before = await seed();
  const first = await readTaskDrop(COURSE, LESSON);
  const second = await readTaskDrop(COURSE, LESSON);
  await applyTaskDrop(first, null, DATA);
  await applyTaskDrop(second, null, DATA);
  assert.equal((await dataUsed(DATA))!.used, before - first.freed);
});
