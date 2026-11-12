/**
 * Hunt: a configuration read that comes back off its shape during a try is unknown, not "disconnected".
 * attempt() reads the config with `const [raw] = ...; parseConfig(raw)`, so a reply that is not a string or null
 * marks the job failed for good ("disconnected") and the consenting person is never sent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUEUE_KEY, queuePerson, syncDue } from "@/lib/email-sync";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "hunt3cfg01";
const store = { statsId: STATS } as Store;
const logKey = `nl:esync:log:${STATS}`;
const cfgKey = `nl:esync:cfg:${STATS}`;
const jobKey = (id: string) => `nl:esync:j:${id}`;
type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
let lease: "refused" | "emulated" = "refused";
let garbleConfig = false;
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
  // One read of the settings answers off its shape (an envelope with no result): unknown.
  if (garbleConfig && batch.length === 1 && command?.[0] === "GET" && command[1] === cfgKey) { garbleConfig = false; return [undefined]; }
  return original(batch);
}) as typeof redis.pipeline;

test("an unreadable settings reply during a try leaves the job waiting, not failed as disconnected", async () => {
  redis.clear();
  const now = Date.now();
  redis.run(["SET", cfgKey, JSON.stringify({ handle: "h", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "List" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })]);
  assert.equal(await queuePerson(store, { source: "purchase", email: "keep@example.com", name: "Dana", products: [], consent: true, seed: "cs_hunt3_cfg", at: now }), "queued");
  const [id] = redis.run(["LRANGE", logKey, 0, 0]) as string[];
  garbleConfig = true;
  lease = "emulated";
  await syncDue(Date.now() + 60_000, Date.now() + 60_000);
  lease = "refused";
  const job = JSON.parse(String(redis.run(["GET", jobKey(id)])));
  assert.notEqual(job.state, "failed", `the job was failed for good: ${job.lastError}`);
  assert.notEqual(redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${id}`]), null, "still waiting for a try");
});
