/**
 * Hunt: a person erased while their email-platform job is being tried must not come back.
 * runClaimed writes the job record (with the address) and puts it back on the queue after the try,
 * unconditionally, so an erasure that ran during the try is undone and the person is sent again later.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUEUE_KEY, forgetSyncPerson, queuePerson, syncDue } from "@/lib/email-sync";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "hunt3erase01";
const store = { statsId: STATS } as Store;
const EMAIL = "erased.buyer@example.com";
const logKey = `nl:esync:log:${STATS}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
const badKey = `nl:esync:bad:${STATS}`;
const jobKey = (id: string) => `nl:esync:j:${id}`;
type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
let lease: "refused" | "emulated" = "refused";
let duringTry: (() => Promise<unknown>) | null = null;
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
  // The try writes the key problem in the middle of the attempt: the erasure runs right then.
  if (batch.length === 1 && command?.[0] === "SET" && command[1] === badKey && duringTry) {
    const run = duringTry; duringTry = null; await run();
  }
  return original(batch);
}) as typeof redis.pipeline;

test("an erasure that lands while the job is being tried is not undone by the try's write-back", async () => {
  redis.clear();
  const now = Date.now();
  redis.run(["SET", cfgKey, JSON.stringify({ handle: "h", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "List" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })]);
  assert.equal(await queuePerson(store, { source: "purchase", email: EMAIL, name: "Dana", products: [], consent: true, seed: "cs_hunt3_1", at: now }), "queued");
  const [id] = redis.run(["LRANGE", logKey, 0, 0]) as string[];
  let erased = -1;
  duringTry = async () => { erased = await forgetSyncPerson(STATS, EMAIL); };
  lease = "emulated";
  const r = await syncDue(Date.now() + 60_000, Date.now() + 60_000);
  lease = "refused";
  assert.equal(r.tried, 1);
  assert.equal(erased, 1, "the erasure found and deleted the job");
  assert.equal(redis.run(["GET", jobKey(id)]), null, "no record holding the erased address is written back");
  assert.equal(redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${id}`]), null, "the erased person is not queued to be sent again");
});
