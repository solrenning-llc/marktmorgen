/**
 * A handed-in file's bytes come back to the store's task room once, by whoever really took the file out of the
 * files' hash (Claude 6, money review of #3009). A creator dropping an assignment (readTaskDrop, then applyTaskDrop),
 * a student's erasure (forgetTasksPerson) and a hand-in replacing its file (handIn) can each remove the same file:
 * only the call whose HDEL answered 1 for it gives its bytes back; one that answered 0 gives nothing, and an answer of
 * another shape gives nothing and is said in the log (CX-123 rule 24), so the counter never falls below what the
 * store still keeps and the store never holds more than its task room. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HandInChangedError, applyTaskDrop, forgetTasksPerson, handIn, readTaskDrop } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const COURSE = "crs_dbl";
const LESSON = "lsndblaaaaaa";
const OTHER = "lsnkeptaaaaa";
const WHO = "0123456789abcdef";
const ROOM = "dbl-room";
const bytesKey = `nl:tasks:bytes:${ROOM}`;
const filesKey = (l: string) => `nl:course:${COURSE}:task:${l}:files`;
const subKey = (l: string, w: string) => `nl:course:${COURSE}:task:${l}:sub:${w}`;
const allKey = `nl:course:${COURSE}:tasks:all`;
const DATA = { sid: "s_dbl", statsId: "st_dbl" } as unknown as Parameters<typeof applyTaskDrop>[2];
const TASK: Task = { prompt: "Write it.", review: true, gate: false, file: true };

function seed() {
  redis.clear();
  // Lesson LESSON: one file of 100 bytes, WHO's. Lesson OTHER: a file of 1000 bytes that stays kept.
  redis.run(["SET", bytesKey, "1100"]);
  redis.run(["HSET", filesKey(LESSON), "a.pdf", "100"]);
  redis.run(["HSET", filesKey(OTHER), "k.pdf", "1000"]);
  const sub = { text: "x", file: { path: "a.pdf", name: "a.pdf", bytes: 100, type: "application/pdf" }, at: 1, state: "waiting", feedback: "", reviewedAt: 0, tries: 1 };
  redis.run(["SET", subKey(LESSON, WHO), JSON.stringify(sub)]);
  redis.run(["ZADD", allKey, 1, `${LESSON}|${WHO}`]);
}

const counter = () => Number(redis.run(["GET", bytesKey]));

type Batch = (string | number)[][];

/** Runs `before` once, just ahead of the first batch `when` picks, then lets that batch through. */
async function aheadOf<T>(when: (batch: Batch) => boolean, before: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => {
    if (when(batch)) {
      redis.pipeline = original;
      await before();
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

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

test("a drop read before a student's erasure gives the file's bytes back once", async () => {
  seed();
  const drop = await readTaskDrop(COURSE, LESSON);
  assert.equal(drop.bytes, 100);
  await forgetTasksPerson(COURSE, [LESSON], WHO, ROOM); // removes a.pdf and gives back its 100
  const files = await applyTaskDrop(drop, ROOM, DATA); // a.pdf is gone already: nothing more
  assert.equal(counter(), 1000, "only lesson OTHER's 1000 bytes are still kept");
  assert.deepEqual(files, ["a.pdf"], "the file is still returned to be deleted");
});

test("an erasure racing a drop the other way round gives the bytes back once", async () => {
  seed();
  // forgetTasksPerson reads the record, then the drop runs whole before forgetTasksPerson deletes.
  const isErasure = (batch: Batch) => batch[0]?.[0] === "DEL" && String(batch[0][1]).includes(":sub:");
  const done = await aheadOf(isErasure, async () => applyTaskDrop(await readTaskDrop(COURSE, LESSON), ROOM, DATA), () => forgetTasksPerson(COURSE, [LESSON], WHO, ROOM));
  assert.equal(counter(), 1000, "only lesson OTHER's 1000 bytes are still kept");
  assert.deepEqual(done.files, ["a.pdf"], "the file is still returned to be deleted");
});

test("a drop alone gives back every file it removed", async () => {
  seed();
  redis.run(["HSET", filesKey(LESSON), "b.pdf", "50"]);
  redis.run(["SET", bytesKey, "1150"]);
  await applyTaskDrop(await readTaskDrop(COURSE, LESSON), ROOM, DATA);
  assert.equal(counter(), 1000);
});

test("an erasure alone gives back the file it removed", async () => {
  seed();
  await forgetTasksPerson(COURSE, [LESSON], WHO, ROOM);
  assert.equal(counter(), 1000);
});

for (const [label, reply] of [["null", null], ["text", "1"], ["2", 2], ["-1", -1], ["a list", [1]]] as [string, unknown][]) {
  test(`applyTaskDrop, HDEL answers ${label}: nothing given back, and said so`, async () => {
    seed();
    const drop = await readTaskDrop(COURSE, LESSON);
    const original = redis.pipeline.bind(redis);
    redis.pipeline = (async (batch: Batch) => {
      const answers = await original(batch);
      return batch.map((c, i) => (c[0] === "HDEL" ? reply : answers[i]));
    }) as typeof redis.pipeline;
    try {
      const { value, lines } = await logged(() => applyTaskDrop(drop, ROOM, DATA));
      assert.deepEqual(value, ["a.pdf"], "the deletion that happened still returns its files");
      assert.equal(counter(), 1100, "an unknown removal is never given back");
      assert.ok(lines.some((l) => l.includes("unknown")), "the unknown answer is said in the log");
    } finally {
      redis.pipeline = original;
    }
  });

  test(`forgetTasksPerson, HDEL answers ${label}: nothing given back, and said so`, async () => {
    seed();
    const original = redis.pipeline.bind(redis);
    redis.pipeline = (async (batch: Batch) => {
      const answers = await original(batch);
      return batch.map((c, i) => (c[0] === "HDEL" ? reply : answers[i]));
    }) as typeof redis.pipeline;
    try {
      if (typeof reply === "number" && reply >= 0) {
        // A count, but not 0 or 1: the erasure finishes and gives nothing back for that file.
        const { value, lines } = await logged(() => forgetTasksPerson(COURSE, [LESSON], WHO, ROOM));
        assert.deepEqual(value.files, ["a.pdf"], "the erasure that happened still returns its files");
        assert.ok(lines.some((l) => l.includes("unknown")), "the unknown answer is said in the log");
      } else {
        // Not a count: the erasure is told it could not finish (Codex P on #2847), never "done".
        await assert.rejects(logged(() => forgetTasksPerson(COURSE, [LESSON], WHO, ROOM)), (e: unknown) => e instanceof UnknownReplyError);
      }
      assert.equal(counter(), 1100, "an unknown removal is never given back");
    } finally {
      redis.pipeline = original;
    }
  });
}

test("a hand-in replacing its file says the replaced bytes to give back only when it removed the file", async () => {
  seed();
  // The new file b.pdf took its 200 bytes of the room (takeRoom) before the hand-in.
  redis.run(["SET", bytesKey, "1300"]);
  const file = { path: "b.pdf", name: "b.pdf", bytes: 200, type: "application/pdf" };
  const done = await handIn({ data: DATA, courseId: COURSE, lessonId: LESSON, who: WHO, email: "", task: TASK, text: "Again.", file });
  assert.equal(done.replaced?.path, "a.pdf", "the old file is handed back to be deleted");
  assert.equal(done.freedBytes, 100, "its bytes are this hand-in's to give back");
});

test("a hand-in racing a drop of the same assignment: the replaced file's bytes are the drop's, given back once", async () => {
  seed();
  redis.run(["SET", bytesKey, "1300"]);
  const file = { path: "b.pdf", name: "b.pdf", bytes: 200, type: "application/pdf" };
  // handIn has read the old record (a.pdf); the drop runs whole before handIn writes and takes a.pdf out. The work's
  // write is its SET, or since #3135 the conditional write (HAND_IN_WRITE_IF, an EVAL with the work's key first).
  const isWrite = (batch: Batch) =>
    (batch[0]?.[0] === "SET" && String(batch[0][1]).includes(":sub:")) || (batch[0]?.[0] === "EVAL" && String(batch[0][3]).includes(":sub:"));
  const done = await aheadOf(isWrite, async () => applyTaskDrop(await readTaskDrop(COURSE, LESSON), ROOM, DATA), () =>
    handIn({ data: DATA, courseId: COURSE, lessonId: LESSON, who: WHO, email: "", task: TASK, text: "Again.", file }),
  ).then(
    () => "written",
    (error: unknown) => (error instanceof HandInChangedError ? "changed" : error),
  );
  assert.equal(counter(), 1200, "the drop gave a.pdf's 100 back, and nothing else gave it back again");
  // The drop deleted the work, so the hand-in that read it before writes nothing over the dropped assignment
  // (HandInChangedError): it gives nothing back, and the route lets its own new file go (app/api/store/course/task).
  assert.equal(done, "changed", "the hand-in finds the work changed under it and writes nothing");
  assert.equal(redis.run(["GET", `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`]), null, "no work is left on the dropped assignment");
  assert.equal(redis.run(["HGET", `nl:course:${COURSE}:task:${LESSON}:files`, "b.pdf"]), null, "and no entry for the new file");
});

test("the hand-in route gives back what handIn removed, never the replaced file's size as read", () => {
  const route = readFileSync("app/api/store/course/task/route.ts", "utf8");
  assert.ok(!route.includes("releaseBytes(room, done.replaced.bytes)"), "the replaced file's size as read is never given back by itself");
  assert.ok(route.includes("releaseBytes(room, done.freedBytes)"), "the route gives back handIn's freedBytes");
});
