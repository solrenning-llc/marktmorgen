/**
 * Issue #4367 (Codex G, G-2236): a student's erasure whose deletion batch was applied but whose reply was lost left
 * the handed-in attachment stored with no cleanup: the rejection went past the queue of uploads to delete, and the
 * retry found the submission gone and no file. The batch now queues every file it deletes for the daily sweep in the
 * same write, so a lost reply leaves the cleanup recoverable. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetTasksPerson, sweepTaskUploads } from "@/lib/assignment";
import { store as redis } from "./redis-stub";

const COURSE = "crs_n3078";
const LESSON = "lsnn3078aaaa";
const KEPT = "lsnkeptaaaaa";
const WHO = "0123456789abcdef";
const ROOM = "n3078-room";
const bytesKey = `nl:tasks:bytes:${ROOM}`;
const filesKey = (l: string) => `nl:course:${COURSE}:task:${l}:files`;
const subKey = `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`;

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


test("issue #4367: a lost reply after the submission deletion applied keeps the attachment's cleanup recoverable", async () => {
  seed(100);
  const original = redis.pipeline.bind(redis);
  let failed = false;
  (redis as unknown as { pipeline: unknown }).pipeline = async (commands: (string | number)[][]) => {
    if (!failed && commands[0]?.[0] === "DEL" && String(commands[0]?.[1]) === subKey) {
      failed = true;
      await original(commands); // applied
      throw new Error("synthetic: reply lost after the batch applied");
    }
    return original(commands);
  };
  try {
    await assert.rejects(forgetTasksPerson(COURSE, [LESSON], WHO, ROOM));
  } finally {
    (redis as unknown as { pipeline: unknown }).pipeline = original;
  }
  assert.equal(failed, true, "the deletion batch ran");
  const retry = await forgetTasksPerson(COURSE, [LESSON], WHO, ROOM);
  const queued = redis.run(["ZSCORE", "nl:tasks:doors", "a.pdf"]);
  assert.equal(queued !== null || retry.files.includes("a.pdf"), true, `doors=${queued} retry.files=${JSON.stringify(retry.files)}`);
  // And the daily job deletes it: the attachment does not outlive the erasure.
  const removed: string[] = [];
  await sweepTaskUploads(async (paths) => void removed.push(...paths), Date.now() + 2 * 86_400_000);
  assert.deepEqual(removed, ["a.pdf"]);
});

test("a deletion whose reply comes back whole still hands its files to the erasure", async () => {
  seed(100);
  const done = await forgetTasksPerson(COURSE, [LESSON], WHO, ROOM);
  assert.deepEqual(done, { records: 1, files: ["a.pdf"] });
  assert.equal(Number(redis.run(["GET", bytesKey])), 1000, "its bytes are given back once");
});
