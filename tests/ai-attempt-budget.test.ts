import { UnknownReplyError } from '@/lib/redis-reply';
import { consumeAiCallBudget } from '@/lib/ai-call-budget';
import { test } from "node:test";
import assert from "node:assert/strict";
import { counted, aiAllowance, aiLeft, aiMonthKey } from "@/lib/ai";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.ANTHROPIC_API_KEY = "sk-ant-" + "x".repeat(40);
const now = Date.UTC(2026, 9, 16);
const customer = (id: string, tier: Store["tier"] = "pro") =>
  ({ statsId: id, tier, trialEnds: 0 } as Store);

test("concurrent failed attempts cannot exceed any tier's monthly allowance", async () => {
  // Store includes no writing jobs: every attempt is refused before it is counted.
  const plain = customer("parallel-creator", "creator");
  assert.equal(aiAllowance(plain, now), 0);
  assert.deepEqual(await counted(plain, now, async () => { throw new Error("must not run"); }), {ok: false, reason: "used"});
  assert.equal(redis.run(["GET", aiMonthKey(plain, new Date(now))!]), null);
  for (const tier of ["pro", "scale"] as const) {
    const store = customer("parallel-" + tier, tier);
    const allowance = aiAllowance(store, now);
    let runs = 0;
    const results = await Promise.all(Array.from({length: allowance + 10}, () =>
      counted(store, now, async () => { runs++; return null; })));
    assert.equal(runs, allowance);
    assert.equal(results.filter(r => !r.ok && r.reason === "used").length, 10);
    assert.equal(await aiLeft(store, now), 0);
    assert.equal(redis.run(["GET", aiMonthKey(store, new Date(now))!]), String(allowance));
  }
});
test("timeouts and unusable answers retain their reservation", async () => {
  const store = customer("failures");
  const before = await aiLeft(store, now);
  assert.deepEqual(await counted(store, now, async () => { throw new Error("provider timeout after work"); }), {ok: false, reason: "failed"});
  assert.deepEqual(await counted(store, now, async () => null, 3), {ok: false, reason: "failed"});
  assert.equal(await aiLeft(store, now), before - 4);
});
test("invalid job weights never execute work or alter accounting", async () => {
  const store = customer("invalid-weights");
  for (const jobs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await counted(store, now, async () => { throw new Error("must not run"); }, jobs), {ok: false, reason: "notes"});
  }
  assert.equal(redis.run(["GET", aiMonthKey(store, new Date(now))!]), null);
});
test("a refused weighted reservation is returned without starting provider work", async () => {
  const store = customer("weighted");
  const allowance = aiAllowance(store, now);
  redis.run(["SET", aiMonthKey(store, new Date(now))!, allowance - 2]);
  const result = await counted(store, now, async () => { throw new Error("must not run"); }, 3);
  assert.deepEqual(result, {ok: false, reason: "used"});
  assert.equal(await aiLeft(store, now), 2);
});
test("untrustworthy reservation acknowledgements never authorize work", async () => {
  const original = redis.run.bind(redis);
  try {
    for (const value of [null, undefined, true, {}, "invalid", "0", "-1", "1.5", Infinity]) {
      const store = customer("unknown-" + String(value));
      redis.run = ((command: (string | number)[]) =>
        command[0] === "INCRBY" ? value : original(command)) as typeof redis.run;
      const result = await counted(store, now, async () => { throw new Error("must not run"); });
      assert.deepEqual(result, {ok: false, reason: "off"});
    }
  } finally { redis.run = original; }
});
test("unknown allowance refuses to certify a remaining balance", async () => {
  const store = customer("corrupt");
  for (const raw of ["", " ", "invalid", "-1", "1.5", "9007199254740992"]) {
    redis.run(["SET", aiMonthKey(store, new Date(now))!, raw]);
    await assert.rejects(aiLeft(store, now), UnknownReplyError);
  }
});

test('counted weighted writing jobs enforce two provider attempts per reserved job',async()=>{for(const jobs of [1,3]){const store=customer('envelope-'+jobs);const result=await counted(store,now,async()=>{const attempts=await Promise.all(Array.from({length:30},async()=>{await Promise.resolve();return consumeAiCallBudget(store.statsId!);}));return attempts.filter(Boolean).length;},jobs);assert.equal(result.ok&&result.value,jobs*2);assert.equal(await aiLeft(store,now),aiAllowance(store,now)-jobs);}});
