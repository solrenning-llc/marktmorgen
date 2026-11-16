/**
 * The email platform jobs are read exactly where a person's erasure, a person's copy, a deleted store's forgetting
 * and the queue's tries depend on them (CX-123 rules 24 and 30; Claude 5 sweep A2, finding 5 and the two read by
 * the code: lib/email-sync.ts forgetSyncPerson, syncJobsOf, forgetStoreSync, runClaimed). A job log, a job record or
 * a deletion answered in another shape is unknown, never "no job": the erasure step and the copy throw
 * UnknownReplyError (lib/person-erasure.ts then answers "incomplete", lib/person-copy.ts hands over no copy), the job
 * record holding the address is kept for the next try, and a queued job is not dropped from the queue untried.
 * Same pattern as lib/erasure-index.ts forgetNoted (audit SG2, finding 4). Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetStoreSync, forgetSyncPerson, syncDue, syncJobsOf, QUEUE_KEY } from "@/lib/email-sync";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const STATS = "exactsync";
const ID = "esj_" + "a".repeat(24);
const OTHER = "esj_" + "b".repeat(24);
const EMAIL = "buyer@example.com";
const logKey = `nl:esync:log:${STATS}`;
const jobKey = (id: string) => `nl:esync:j:${id}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
const job = (id: string, email: string, state = "added") => ({ id, statsId: STATS, email, title: "Free guide", source: "free", state, attempts: 1, next: 0, lastError: "", note: "", lastAt: 1, createdAt: 1 });

async function seed(state = "added") {
  redis.clear();
  await redis.pipeline([
    ["RPUSH", logKey, ID, OTHER],
    ["SET", jobKey(ID), JSON.stringify(job(ID, EMAIL, state))],
    ["SET", jobKey(OTHER), JSON.stringify(job(OTHER, "other@example.com", state))],
    ["ZADD", QUEUE_KEY, 1, `${STATS}|${ID}`],
    ["SET", cfgKey, "{}"],
  ]);
}
const held = async (id = ID) => (await redis.pipeline([["GET", jobKey(id)]]))[0] !== null;
const queued = async () => (await redis.pipeline([["ZSCORE", QUEUE_KEY, `${STATS}|${ID}`]]))[0] !== null;

type Batch = (string | number)[][];
async function under<T>(alter: (batch: Batch, answers: unknown[]) => unknown[], run: () => Promise<T>): Promise<{ value: T } | { error: unknown }> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => alter(batch, await original(batch))) as typeof redis.pipeline;
  try {
    return await run().then((value) => ({ value }), (error: unknown) => ({ error }));
  } finally {
    redis.pipeline = original;
  }
}
/** The queue's lease (LEASE_SCRIPT), which the in-memory double does not run, done here by its three steps. */
const leased = async (batch: Batch, answers: () => Promise<unknown[]>): Promise<unknown[]> => {
  const [command] = batch;
  if (batch.length !== 1 || command?.[0] !== "EVAL") return answers();
  const [, , , key, member, now, until] = command;
  const due = redis.run(["ZSCORE", String(key), String(member)]);
  if (due === null || Number(due) > Number(now)) return [0];
  redis.run(["ZADD", String(key), Number(until), String(member)]);
  return [1];
};
async function tried(alter: (batch: Batch, answers: unknown[]) => unknown[] = (_b, a) => a): Promise<void> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => leased(batch, async () => alter(batch, await original(batch)))) as typeof redis.pipeline;
  try {
    await syncDue(Date.now() + 60_000);
  } finally {
    redis.pipeline = original;
  }
}
const unknown = (result: { value: unknown } | { error: unknown }) => "error" in result && result.error instanceof UnknownReplyError;

const isLog = (batch: Batch) => batch[0]?.[0] === "LRANGE" && batch[0]?.[1] === logKey;
const isJobs = (batch: Batch) => batch[0]?.[0] === "GET" && String(batch[0]?.[1]).startsWith("nl:esync:j:");
// The store's queued jobs are read with ZSCAN since the fix of Codex Q's finding on #2860 (an offset page skips members).
const isQueuePage = (batch: Batch) => batch[0]?.[0] === "ZSCAN" && batch[0]?.[1] === QUEUE_KEY;
const isErase = (batch: Batch) => batch[0]?.[0] === "DEL" && String(batch[0]?.[1]).startsWith("nl:esync:j:");

const LOG_SHAPES: [string, (batch: Batch, answers: unknown[]) => unknown[]][] = [
  ["no reply", (b, a) => (isLog(b) ? [] : a)],
  ["null", (b, a) => (isLog(b) ? [null] : a)],
  ["a number", (b, a) => (isLog(b) ? [7] : a)],
  ["a member not a string", (b, a) => (isLog(b) ? [[ID, 7]] : a)],
  ["a hole", (b, a) => (isLog(b) ? [[ID, , OTHER]] : a)],
];
const JOB_SHAPES: [string, (batch: Batch, answers: unknown[]) => unknown[]][] = [
  ["every reply a number", (b, a) => (isJobs(b) ? b.map(() => 7) : a)],
  ["one reply short", (b, a) => (isJobs(b) ? a.slice(1) : a)],
  ["a record not JSON", (b, a) => (isJobs(b) ? a.map(() => "{not json") : a)],
  ["a record with no address", (b, a) => (isJobs(b) ? a.map(() => JSON.stringify({ id: ID, state: "added" })) : a)],
];

test("healthy: the copy lists the person's job and only theirs", async () => {
  await seed();
  assert.deepEqual((await syncJobsOf(STATS, EMAIL)).map((j) => j.id), [ID]);
});

test("healthy: the erasure deletes the person's job, off the log and the queue, and counts it", async () => {
  await seed();
  assert.equal(await forgetSyncPerson(STATS, "Buyer@Example.com"), 1);
  assert.deepEqual([await held(ID), await queued(), await held(OTHER)], [false, false, true]);
  assert.deepEqual(redis.run(["LRANGE", logKey, 0, -1]), [OTHER]);
});

test("healthy: a job record that expired is known absence, not an unknown read", async () => {
  await seed();
  await redis.pipeline([["DEL", jobKey(ID)]]);
  assert.deepEqual(await syncJobsOf(STATS, EMAIL), []);
  assert.equal(await forgetSyncPerson(STATS, EMAIL), 0);
  assert.equal(await held(OTHER), true);
});

for (const [name, alter] of LOG_SHAPES) {
  test(`the job log answered as ${name}: the copy and the erasure throw, the job is kept`, async () => {
    await seed();
    assert.ok(unknown(await under(alter, () => syncJobsOf(STATS, EMAIL))), "copy");
    assert.ok(unknown(await under(alter, () => forgetSyncPerson(STATS, EMAIL))), "erasure");
    assert.deepEqual([await held(ID), await queued()], [true, true]);
  });
}

for (const [name, alter] of JOB_SHAPES) {
  test(`the job records answered as ${name}: the copy and the erasure throw, the job is kept`, async () => {
    await seed();
    assert.ok(unknown(await under(alter, () => syncJobsOf(STATS, EMAIL))), "copy");
    assert.ok(unknown(await under(alter, () => forgetSyncPerson(STATS, EMAIL))), "erasure");
    assert.deepEqual([await held(ID), await queued()], [true, true]);
  });
}

test("the erasure's deletion answered in another shape is not counted as done", async () => {
  await seed();
  assert.ok(unknown(await under((b, a) => (isErase(b) ? a.slice(1) : a), () => forgetSyncPerson(STATS, EMAIL))));
  await seed();
  assert.ok(unknown(await under((b, a) => (isErase(b) ? a.map(() => "OK") : a), () => forgetSyncPerson(STATS, EMAIL))));
});

test("healthy: a deleted store's forgetting deletes its jobs, its queue entries and its settings", async () => {
  await seed();
  await forgetStoreSync(STATS);
  assert.deepEqual([await held(ID), await held(OTHER), await queued()], [false, false, false]);
  assert.deepEqual([redis.run(["EXISTS", logKey]), redis.run(["EXISTS", cfgKey])], [0, 0]);
});

test("a deleted store's job log answered unknown: it throws, keeps the log for the next try, still forgets the key", async () => {
  for (const [name, alter] of LOG_SHAPES) {
    await seed();
    assert.ok(unknown(await under(alter, () => forgetStoreSync(STATS))), name);
    assert.equal(redis.run(["EXISTS", logKey]), 1, `${name}: log kept`);
    assert.equal(redis.run(["EXISTS", cfgKey]), 0, `${name}: settings and sealed key gone`);
    assert.equal(await held(ID), false, `${name}: the queued job found by the queue is deleted`);
  }
});

test("a deleted store's queue page answered unknown: it throws, never reported as finished", async () => {
  await seed();
  assert.ok(unknown(await under((b, a) => (isQueuePage(b) ? [7] : a), () => forgetStoreSync(STATS))));
  await seed();
  assert.ok(unknown(await under((b, a) => (isQueuePage(b) ? [] : a), () => forgetStoreSync(STATS))));
});

test("a deleted store's deletion answered in another shape is not finished", async () => {
  await seed();
  assert.ok(unknown(await under((b, a) => (b.some((c) => c[0] === "DEL" && c[1] === cfgKey) ? a.slice(1) : a), () => forgetStoreSync(STATS))));
});

test("healthy: a due job whose record expired leaves the queue", async () => {
  await seed("queued");
  await redis.pipeline([["DEL", jobKey(ID)]]);
  await tried();
  assert.equal(await queued(), false);
});

test("healthy: a due job already added leaves the queue", async () => {
  await seed("added");
  await tried();
  assert.equal(await queued(), false);
});

test("a due job read in another shape is not dropped from the queue untried", async () => {
  for (const [name, alter] of [
    ["no reply", (b: Batch, a: unknown[]) => (isJobs(b) ? [] : a)],
    ["a number", (b: Batch, a: unknown[]) => (isJobs(b) ? [7] : a)],
    ["a record not JSON", (b: Batch, a: unknown[]) => (isJobs(b) ? ["{not json"] : a)],
  ] as const) {
    await seed("queued");
    await tried(alter);
    assert.equal(await queued(), true, name);
    assert.equal(await held(ID), true, name);
  }
});
