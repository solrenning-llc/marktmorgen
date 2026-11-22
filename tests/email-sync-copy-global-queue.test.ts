/**
 * A person's copy and erasure read only their own store's email platform jobs, never the whole platform queue
 * (#5125, email-sync row: lib/email-sync.ts queuedOf ZSCANned the global nl:esync:q, every store's waiting jobs, up to
 * 10,000 rounds of 500). The queue is shared by every store, so its size is no store's own: a copy whose cost grows
 * with it is unbounded for the store that asked. Here the queue holds a worst case of other stores' jobs, and the
 * person's own store has one waiting job pushed out of its log; the copy must still find that job, and read nothing of
 * the global queue but its own members. Synthetic data only; nothing is sent anywhere.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LOG_SIZE, QUEUE_KEY, forgetSyncPerson, queuePerson, syncJobsOf } from "@/lib/email-sync";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "globalqueue01";
const store = { statsId: STATS } as Store;
const FIRST = "first.buyer@example.com";
const logKey = `nl:esync:log:${STATS}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
/** Other stores' waiting jobs on the shared queue: far more than any one store's (a worst case for the scan). */
const OTHERS = 20_000;

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
const seen: Batch = [];
redis.pipeline = (async (batch: Batch) => {
  // The queue's lease is refused, so nothing is ever tried while the store is set up.
  if (batch.length === 1 && batch[0]?.[0] === "EVAL" && !String(batch[0][1]).startsWith("-- marktmorgen:")) return [0];
  seen.push(...batch);
  return original(batch);
}) as typeof redis.pipeline;

let n = 0;
const person = (email: string, consent: boolean) => ({ source: "purchase" as const, email, name: "Dana Reyes", products: [], consent, seed: `cs_test_globalq${(n += 1)}`, at: Date.now() });

async function seed(): Promise<string> {
  redis.clear();
  // The indexes were filled from the shared queue (#5135); before that, a copy reads the shared queue as main did.
  redis.run(["SET", "nl:esync:qdfill:done", "1"]);
  const now = Date.now();
  redis.run(["SET", cfgKey, JSON.stringify({ handle: "globalq", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })]);
  assert.equal(await queuePerson(store, person(FIRST, true)), "queued");
  const [id] = redis.run(["LRANGE", logKey, 0, 0]) as string[];
  // Pushed out of the studio's log by newer jobs, so only the queue still names it.
  for (let i = 0; i < LOG_SIZE + 5; i += 1) await queuePerson(store, person(`other${i}@example.com`, false));
  assert.equal((redis.run(["LRANGE", logKey, 0, -1]) as string[]).includes(id), false, "(the first job left the log)");
  for (let i = 0; i < OTHERS; i += 1) redis.run(["ZADD", QUEUE_KEY, now + i, `otherstore${String(i % 997).padStart(4, "0")}|job${i}`]);
  return id;
}

const scannedGlobal = () => seen.filter((c) => (c[0] === "ZSCAN" || c[0] === "ZRANGE" || c[0] === "ZRANGEBYSCORE" || c[0] === "ZRANGEBYLEX") && c[1] === QUEUE_KEY).length;

test("a person's copy finds their job pushed out of the log without scanning the global queue", async () => {
  const id = await seed();
  seen.length = 0;
  const jobs = await syncJobsOf(STATS, FIRST);
  assert.deepEqual(jobs.map((j) => j.id), [id], "the waiting job is still found");
  assert.equal(scannedGlobal(), 0, "the global queue of every store is never scanned for one store's copy");
});

test("a person's erasure finds their job pushed out of the log without scanning the global queue", async () => {
  const id = await seed();
  seen.length = 0;
  assert.equal(await forgetSyncPerson(STATS, FIRST), 1);
  assert.equal(redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${id}`]), null, "its queue member is gone");
  assert.equal(scannedGlobal(), 0, "the global queue of every store is never scanned for one person's erasure");
});
