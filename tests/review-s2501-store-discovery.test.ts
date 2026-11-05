import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { recountStep, RECOUNT_VERSION, STATE_KEY, SUM_KEY } from "@/lib/data-recount";
import { dataKey } from "@/lib/store-data";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const clock = Date.now;
beforeEach(() => { redis.clear(); const now = clock(); Date.now = () => now; });
afterEach(() => { Date.now = clock; redis.pipeline = pipeline; });

async function fixture() {
  const owner = "recount-discovery@example.test";
  await claimHandle(owner, "recount-discovery", "Synthetic discovery", "");
  await ensureStatsId(owner);
  let storeKey = "";
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0][0] === "GET") storeKey = String(commands[0][1]);
    return pipeline(commands);
  };
  const store = (await storeForEmail(owner))!;
  redis.pipeline = pipeline;
  assert.ok(store && storeKey);
  redis.run(["HSET", STATE_KEY, "phase", "apply", "cursor", "0", "version", RECOUNT_VERSION]);
  redis.run(["HSET", SUM_KEY, owner, 4096]);
  return { owner, storeKey, roomKey: dataKey(store)! };
}

test("a confirmed store receives its pending legacy measurement", async () => {
  const f = await fixture();
  const report = await recountStep(Date.now() + 1000);
  assert.equal(report.done, true);
  assert.equal(redis.run(["HGET", SUM_KEY, f.owner]), null);
  assert.ok(Number(redis.run(["HGET", f.roomKey, "legacy"])) > 0);
});

test("an explicitly missing store can leave the recount", async () => {
  const f = await fixture();
  redis.run(["DEL", f.storeKey]);
  const report = await recountStep(Date.now() + 1000);
  assert.equal(report.done, true);
  assert.equal(redis.run(["HGET", SUM_KEY, f.owner]), null);
});

for (const [name, receipt] of [
  ["missing GET envelope slot", []],
  ["undefined GET result", [undefined]],
  ["unreadable store JSON", ["{"]],
  ["non-string store record", [{}]],
] as [string, unknown[]][]) test(name + " must preserve the real store's pending measurement", async () => {
  const f = await fixture();
  let accountingCalls = 0;
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === f.storeKey) return receipt;
    if (commands[0][0] === "EVAL") accountingCalls += 1;
    return pipeline(commands);
  };
  let report: Awaited<ReturnType<typeof recountStep>> | null = null;
  try { report = await recountStep(Date.now() + 1000); } catch { /* unknown must stop before the pending sum is removed */ }
  assert.equal(typeof redis.run(["GET", f.storeKey]), "string", "the real store still exists");
  assert.equal(accountingCalls, 0, "this is before the separately reported noteData receipt boundary");
  assert.deepEqual({ done: report?.done ?? false, pending: redis.run(["HGET", SUM_KEY, f.owner]), legacy: redis.run(["HGET", f.roomKey, "legacy"]) }, { done: false, pending: "4096", legacy: null });
});

for (const receipt of [[], [["0"]]]) test("unknown initial store discovery " + JSON.stringify(receipt) + " must not certify the inventory", async () => {
  const f = await fixture();
  redis.run(["HSET", STATE_KEY, "phase", "ids", "cursor", "0"]);
  redis.run(["HDEL", SUM_KEY, f.owner]);
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0][0] === "SCAN" && commands[0][3] === "nl:store:owner:*") return receipt;
    return pipeline(commands);
  };
  let report: Awaited<ReturnType<typeof recountStep>> | null = null;
  try { report = await recountStep(Date.now() + 1000); } catch { /* discovery uncertainty must remain resumable */ }
  assert.equal(typeof redis.run(["GET", f.storeKey]), "string");
  assert.deepEqual({ done: report?.done ?? false, phase: redis.run(["HGET", STATE_KEY, "phase"]) }, { done: false, phase: "ids" });
});
