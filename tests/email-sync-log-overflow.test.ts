/**
 * The store's job log (lib/email-sync.ts, nl:esync:log:) keeps the newest LOG_SIZE jobs for the studio, while each
 * job record, which holds the buyer's address, lives for a week. A person's copy (syncJobsOf) and erasure
 * (forgetSyncPerson) must still find every job record of theirs that is alive, whatever pushed it out of the studio's
 * log: a waiting send stays found through the queue, and a record that is in neither the log nor the queue is not
 * left behind holding an address (Codex Q on #2860, the MEDIUM inherited finding; Claude 6 on #2860). An unknown
 * reply on the way is never read as "no job" (CX-123 rule 24). Synthetic data only; nothing is sent anywhere: the
 * queue's lease is emulated here, and a try only ever meets a disconnected platform.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LOG_SIZE, QUEUE_KEY, forgetSyncPerson, queuePerson, syncDue, syncJobsOf, syncView } from "@/lib/email-sync";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "overflowsync01";
const store = { statsId: STATS } as Store;
const FIRST = "first.buyer@example.com";
const logKey = `nl:esync:log:${STATS}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
const jobKey = (id: string) => `nl:esync:j:${id}`;

type Batch = (string | number)[][];
type Alter = (batch: Batch, answers: unknown[]) => unknown[];
const original = redis.pipeline.bind(redis);
/** Every pipeline goes through here: the queue's lease (EVAL) is refused while people are noticed, so nothing is tried. */
let alter: Alter = (_b, a) => a;
let lease: "refused" | "emulated" = "refused";
redis.pipeline = (async (batch: Batch) => {
  const [command] = batch;
  if (batch.length === 1 && command?.[0] === "EVAL") {
    if (lease === "refused") return [0];
    const [, , , key, member, now, until] = command;
    const due = redis.run(["ZSCORE", String(key), String(member)]);
    if (due === null || Number(due) > Number(now)) return [0];
    redis.run(["ZADD", String(key), Number(until), String(member)]);
    return [1];
  }
  return alter(batch, await original(batch));
}) as typeof redis.pipeline;

let n = 0;
const person = (email: string, consent: boolean) => ({ source: "purchase" as const, email, name: "Dana Reyes", products: [], consent, seed: `cs_test_overflow${(n += 1)}`, at: Date.now() });

/** A store with a platform connected, and the first buyer's job (a waiting send) followed by `newer` others. */
async function seed(newer: number): Promise<string> {
  redis.clear();
  alter = (_b, a) => a;
  lease = "refused";
  const now = Date.now();
  redis.run(["SET", cfgKey, JSON.stringify({ handle: "overflow", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })]);
  assert.equal(await queuePerson(store, person(FIRST, true)), "queued");
  const [id] = redis.run(["LRANGE", logKey, 0, 0]) as string[];
  assert.equal(JSON.parse(String(redis.run(["GET", jobKey(id)]))).email, FIRST, "the writer keeps the address in the record");
  for (let i = 0; i < newer; i += 1) assert.equal(await queuePerson(store, person(`other${i}@example.com`, false)), "skipped");
  return id;
}
const record = (id: string) => redis.run(["GET", jobKey(id)]);
const queued = (id: string) => redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${id}`]) !== null;
const logged = (id: string) => (redis.run(["LRANGE", logKey, 0, -1]) as string[]).includes(id);
/** The five-minute job, with its lease emulated, the platform disconnected first so a try never leaves this process. */
async function retried(): Promise<{ tried: number }> {
  redis.run(["DEL", cfgKey]);
  lease = "emulated";
  try {
    return await syncDue(Date.now() + 60_000, Date.now() + 60_000);
  } finally {
    lease = "refused";
  }
}
const unknown = async (run: () => Promise<unknown>) =>
  run().then(
    () => false,
    (error: unknown) => error instanceof UnknownReplyError,
  );

test("control: LOG_SIZE jobs in all, the first still in the log, copied and erased", async () => {
  const id = await seed(LOG_SIZE - 1);
  assert.equal(logged(id), true);
  assert.deepEqual((await syncJobsOf(STATS, FIRST)).map((job) => job.id), [id]);
  assert.equal(await forgetSyncPerson(STATS, FIRST), 1);
  assert.deepEqual([record(id), queued(id)], [null, false]);
});

test("a waiting send pushed out of the studio's log by LOG_SIZE newer jobs is still copied, erased and never tried after", async () => {
  const id = await seed(LOG_SIZE);
  assert.equal(logged(id), false, "out of the studio's log");
  assert.equal(queued(id), true, "still waiting");
  assert.deepEqual((await syncJobsOf(STATS, FIRST)).map((job) => job.id), [id], "the copy lists it");
  assert.equal(await forgetSyncPerson(STATS, FIRST), 1, "the erasure counts it");
  assert.deepEqual([record(id), queued(id)], [null, false], "the record with the address and the waiting send are gone");
  assert.equal((await retried()).tried, 0, "nothing of theirs is tried after the erasure");
});

test("a finished job pushed out of the studio's log keeps no address where the copy and the erasure cannot find it", async () => {
  const id = await seed(0);
  const finished = { ...JSON.parse(String(record(id))), state: "added", next: 0, attempts: 1, lastAt: Date.now() };
  redis.run(["SET", jobKey(id), JSON.stringify(finished)]);
  redis.run(["ZREM", QUEUE_KEY, `${STATS}|${id}`]);
  for (let i = 0; i < LOG_SIZE; i += 1) await queuePerson(store, person(`later${i}@example.com`, false));
  assert.equal(logged(id), false, "out of the studio's log");
  const copied = (await syncJobsOf(STATS, FIRST)).length;
  assert.equal(copied, record(id) === null ? 0 : 1, "a record still alive is in the copy");
  await forgetSyncPerson(STATS, FIRST);
  assert.equal(record(id), null, "no record with the address survives the erasure");
});

test("a waiting send that finishes after it left the studio's log is not left behind holding the address", async () => {
  const id = await seed(LOG_SIZE);
  assert.equal((await retried()).tried, 1);
  assert.equal(queued(id), false, "it failed, the platform being disconnected, and left the queue");
  const copied = (await syncJobsOf(STATS, FIRST)).length;
  assert.equal(copied, record(id) === null ? 0 : 1, "a record still alive is in the copy");
  await forgetSyncPerson(STATS, FIRST);
  assert.equal(record(id), null, "no record with the address survives the erasure");
});

test("the studio still shows the newest LOG_SIZE jobs, and the log stays that long", async () => {
  await seed(LOG_SIZE + 3);
  assert.equal(Number(redis.run(["LLEN", logKey])), LOG_SIZE);
  assert.equal((await syncView(store)).log?.length, LOG_SIZE);
});

const isQueueScan = (batch: Batch) => batch.length === 1 && batch[0]?.[1] === QUEUE_KEY && (batch[0]?.[0] === "ZSCAN" || batch[0]?.[0] === "ZRANGEBYSCORE");
for (const [name, answer] of [
  ["no reply", []],
  ["a number", [7]],
  ["a cursor with no members", [["0"]]],
  ["a member not a string", [["0", [`${STATS}|esj_${"c".repeat(24)}`, 7]]]],
] as [string, unknown[]][]) {
  test(`the queue read for a person's copy and erasure answered as ${name}: both throw, the waiting send is kept`, async () => {
    const id = await seed(LOG_SIZE);
    alter = (b, a) => (isQueueScan(b) ? answer : a);
    assert.equal(await unknown(() => syncJobsOf(STATS, FIRST)), true, "copy");
    assert.equal(await unknown(() => forgetSyncPerson(STATS, FIRST)), true, "erasure");
    alter = (_b, a) => a;
    assert.deepEqual([record(id) !== null, queued(id)], [true, true]);
  });
}

test("a job pushed out of the log whose place on the queue reads unknown stays where it is found", async () => {
  const id = await seed(LOG_SIZE - 1);
  alter = (b, a) => (b.some((c) => c[0] === "ZSCORE") ? a.map((reply, i) => (b[i]?.[0] === "ZSCORE" ? "not a score" : reply)) : a);
  await queuePerson(store, person("pusher@example.com", false));
  alter = (_b, a) => a;
  assert.equal(record(id) !== null, true, "the record is kept");
  assert.deepEqual((await syncJobsOf(STATS, FIRST)).map((job) => job.id), [id], "and still found");
});

// Retire reads the whole log before the job leaves the queue and, for a job in the log, once more after (Claude 4 on
// #2860); either read answering in another shape keeps the job on the queue, or puts it back there.
for (const [name, newer, read] of [
  ["out of the log, at the read before it leaves the queue", LOG_SIZE, 1],
  ["in the log, at the read after it leaves the queue", 0, 2],
] as [string, number, number][]) {
  test(`a finished job whose log reads unknown (${name}) stays on the queue, still found, rather than lost`, async () => {
    const id = await seed(newer);
    let reads = 0;
    const wholeLog = (c: (string | number)[]) => c[0] === "LRANGE" && c[1] === logKey && c[2] === 0 && c[3] === -1;
    alter = (b, a) => (b.some(wholeLog) && (reads += 1) === read ? a.map((reply, i) => (wholeLog(b[i] ?? []) ? 7 : reply)) : a);
    await retried();
    alter = (_b, a) => a;
    assert.equal(reads >= read, true, "the read was reached");
    assert.equal(queued(id), true, "on the queue");
    assert.deepEqual((await syncJobsOf(STATS, FIRST)).map((job) => job.id), [id], "and still found");
  });
}

/**
 * A reply lost after Redis ran the commands (a timeout, a dropped connection) must never leave a job's record, which
 * holds the buyer's address, outside both the log and the queue, where the copy would say 0 jobs and the erasure 0
 * while the record lives on for up to a week (Claude 4's focal return on #2860, comment 6709710311). Each step that
 * moves a job off one of its indexes is tried with its reply lost, one step at a time: Redis runs the batch, then the
 * caller gets a throw instead of the answer.
 */
let losing = -1;
let seenBatches = 0;
function loseReplyOf(step: number): void {
  losing = step;
  seenBatches = 0;
  alter = (_b, a) => {
    seenBatches += 1;
    if (seenBatches - 1 === losing) throw new Error("synthetic: the reply was lost after the batch ran");
    return a;
  };
}
function stopLosing(): boolean {
  alter = (_b, a) => a;
  const reached = seenBatches > losing;
  losing = -1;
  return reached;
}
async function stillFoundOrGone(id: string, step: number, where: string): Promise<void> {
  const alive = record(id) !== null;
  assert.equal(!alive || logged(id) || queued(id), true, `${where}, reply of batch ${step} lost: a record still alive is in the log or on the queue`);
  const copied = (await syncJobsOf(STATS, FIRST)).length;
  assert.equal(copied, alive ? 1 : 0, `${where}, reply of batch ${step} lost: the copy lists a record still alive`);
  assert.equal(await forgetSyncPerson(STATS, FIRST), copied, `${where}, reply of batch ${step} lost: the erasure counts it`);
  assert.equal(record(id), null, `${where}, reply of batch ${step} lost: no record with the address survives the erasure`);
}

test("a lost reply while a push moves a finished job out of the studio's log never leaves its record unfound", async () => {
  for (let step = 0; step < 20; step += 1) {
    const id = await seed(0);
    const finished = { ...JSON.parse(String(record(id))), state: "added", next: 0, attempts: 1, lastAt: Date.now() };
    redis.run(["SET", jobKey(id), JSON.stringify(finished)]);
    redis.run(["ZREM", QUEUE_KEY, `${STATS}|${id}`]);
    for (let i = 0; i < LOG_SIZE - 1; i += 1) await queuePerson(store, person(`later${i}@example.com`, false));
    assert.equal(logged(id), true, "still the oldest job in the studio's log");
    loseReplyOf(step);
    await queuePerson(store, person("pusher@example.com", false)).catch(() => "threw");
    if (!stopLosing()) break;
    await stillFoundOrGone(id, step, "the push");
  }
});

test("a lost reply while the five-minute run retires a waiting send already out of the log never leaves its record unfound", async () => {
  for (let step = 0; step < 20; step += 1) {
    const id = await seed(LOG_SIZE);
    assert.deepEqual([logged(id), queued(id)], [false, true], "out of the studio's log, still waiting");
    loseReplyOf(step);
    await retried().catch(() => ({ tried: -1 }));
    if (!stopLosing()) break;
    await stillFoundOrGone(id, step, "the five-minute run");
  }
});
