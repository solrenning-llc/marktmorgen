/** Independent remaining write-receipt boundary; persisted synthetic rows, no transport/provider. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addSpend } from "@/lib/ad-spend";
import { store as redis } from "./redis-stub";
const SID = "z2924-write-proof";
const KEY = `nl:stats:${SID}:spend`;
const today = new Date().toISOString().slice(0, 10);
const line = { channel: "instagram", campaign: "", cents: 1200, from: today, to: today };
const original = redis.pipeline.bind(redis);
async function rows(): Promise<number[]> {
  const [raw] = await original([["HGETALL", KEY]]);
  const flat = raw as string[];
  return flat.filter((_, i) => i % 2 === 1).map(text => (JSON.parse(text) as { cents: number }).cents);
}
test("control: a healthy add records one real line", async () => {
  redis.clear();
  const result = await addSpend(SID, line);
  assert.deepEqual([result.ok, await rows()], [true, [1200]]);
});
test("a lost receipt after applying a write must not make the same retry record the expense twice", async () => {
  redis.clear();
  let firstFailed = false;
  redis.pipeline = async commands => {
    const result = await original(commands);
    if (commands.some(c => c[0] === "HSET")) throw new Error("Synthetic applied write receipt lost");
    return result;
  };
  try { await addSpend(SID, line); } catch { firstFailed = true; }
  finally { redis.pipeline = original; }
  const beforeRetry = await rows();
  await addSpend(SID, line);
  const afterRetry = await rows();
  console.log(JSON.stringify({ firstFailed, beforeRetry, afterRetry, total: afterRetry.reduce((a, b) => a + b, 0) }));
  assert.deepEqual(afterRetry, [1200], "one real expense remains one after retry of the refused operation");
});
test("a write not applied with an unknown empty receipt must not be reported saved", async () => {
  redis.clear();
  redis.pipeline = async commands => commands.some(c => c[0] === "HSET") ? [] : original(commands);
  let result: Awaited<ReturnType<typeof addSpend>> | undefined;
  try { result = await addSpend(SID, line); } catch { /* refusal is acceptable */ }
  finally { redis.pipeline = original; }
  const kept = await rows();
  console.log(JSON.stringify({ ok: result?.ok, kept }));
  assert.equal(result?.ok === true && kept.length === 0, false, "unknown write is never saved success with no saved row");
});
