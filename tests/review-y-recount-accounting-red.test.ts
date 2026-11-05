import assert from "node:assert/strict";
import { test } from "node:test";
import { recountStep, RECOUNT_VERSION, STATE_KEY, SUM_KEY } from "@/lib/data-recount";
import { TAKE_DATA, dataKey } from "@/lib/store-data";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

// Intentionally RED: occupied lib/store-data.ts is not changed by this proof.
for (const receipt of [[], [[1]], [[-1, 0]]]) test(`unconfirmed accounting ${JSON.stringify(receipt)} must keep the recount pending`, async () => {
  redis.clear(); const owner = "recount-accounting@example.com";
  await claimHandle(owner, "recount-accounting", "Accounting evidence", ""); await ensureStatsId(owner);
  const store = (await storeForEmail(owner))!;
  redis.run(["HSET", STATE_KEY, "phase", "apply", "cursor", "0", "version", RECOUNT_VERSION]);
  redis.run(["HSET", SUM_KEY, owner, 4096]);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async commands => commands[0][0] === "EVAL" && commands[0][1] === TAKE_DATA ? receipt : pipeline(commands);
  let report: Awaited<ReturnType<typeof recountStep>> | null = null;
  try { report = await recountStep(Date.now() + 1000); } catch { /* a rejected receipt should fail closed */ }
  finally { redis.pipeline = pipeline; }
  assert.equal(redis.run(["HGET", dataKey(store)!, "legacy"]), null, "the accounting script was never applied");
  assert.deepEqual({ done: report?.done ?? false, pending: redis.run(["HGET", SUM_KEY, owner]) }, { done: false, pending: "4096" });
});
