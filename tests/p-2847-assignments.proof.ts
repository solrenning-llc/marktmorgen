/**
 * Independent review proof for #2847: erasure writes must not certify success
 * when the Redis pipeline reply is unknown or only part of the batch applied.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetTasksPerson } from "@/lib/assignment";
import type { Submission } from "@/lib/assignment-rules";
import { store as redis } from "./redis-stub";

const COURSE = "crs_p2847proof";
const LESSON = "lessonp284701";
const WHO = "dddddddddddddddddddddddddddddddd";
const sub = `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`;
const waiting = `nl:course:${COURSE}:tasks:waiting`;
const all = `nl:course:${COURSE}:tasks:all`;
const files = `nl:course:${COURSE}:task:${LESSON}:files`;
const member = `${LESSON}|${WHO}`;
const path = "synthetic/p-2847.pdf";

const work: Submission = {
  text: "Synthetic answer.",
  file: { path, name: "proof.pdf", bytes: 100, type: "application/pdf" },
  at: 1_700_000_000,
  state: "waiting",
  feedback: "",
  reviewedAt: 0,
  tries: 1,
};

function seed(): void {
  redis.clear();
  redis.run(["SET", sub, JSON.stringify(work)]);
  redis.run(["ZADD", waiting, work.at, member]);
  redis.run(["ZADD", all, work.at, member]);
  redis.run(["HSET", files, path, work.file?.bytes ?? 0]);
}

async function capture(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

test("control: an exact healthy erasure removes the record and indexes", async () => {
  seed();
  assert.deepEqual(await forgetTasksPerson(COURSE, [LESSON], WHO, null), { records: 1, files: [path] });
  assert.equal(redis.run(["GET", sub]), null);
  assert.equal(redis.run(["ZCARD", waiting]), 0);
  assert.equal(redis.run(["ZCARD", all]), 0);
  assert.equal(redis.run(["HLEN", files]), 0);
});

test("an unapplied erasure batch with an empty reply is unknown, never successful", async () => {
  seed();
  const original = redis.pipeline.bind(redis);
  let calls = 0;
  redis.pipeline = (async (batch) => {
    calls += 1;
    if (calls === 2) return [];
    return original(batch);
  }) as typeof redis.pipeline;
  const result = await capture(() => forgetTasksPerson(COURSE, [LESSON], WHO, null));
  redis.pipeline = original;

  assert.ok(result.error, `must reject unknown write, got ${JSON.stringify(result.value)}`);
  assert.equal(redis.run(["GET", sub]), JSON.stringify(work), "the retained record remains retryable");
  assert.equal(redis.run(["ZCARD", waiting]), 1);
  assert.equal(redis.run(["ZCARD", all]), 1);
  assert.equal(redis.run(["HLEN", files]), 1);
});

test("a partially applied erasure batch is incomplete, never successful", async () => {
  seed();
  const original = redis.pipeline.bind(redis);
  let calls = 0;
  redis.pipeline = (async (batch) => {
    calls += 1;
    if (calls === 2) {
      await original([batch[0]]);
      return [];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  const result = await capture(() => forgetTasksPerson(COURSE, [LESSON], WHO, null));
  redis.pipeline = original;

  assert.ok(result.error, `must report incomplete, got ${JSON.stringify(result.value)}`);
  assert.equal(redis.run(["GET", sub]), null, "the first write may already have applied");
  assert.equal(redis.run(["ZCARD", waiting]), 1, "the waiting identity remains");
  assert.equal(redis.run(["ZCARD", all]), 1, "the all-work identity remains");
  assert.equal(redis.run(["HLEN", files]), 1, "the file identity remains");
});
