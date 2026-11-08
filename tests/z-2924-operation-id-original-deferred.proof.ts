/** Synthetic in-flight command ordering; not a real Redis outage or an observed incident. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addSpend } from "@/lib/ad-spend";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const SID = "z2924-deferred";
const KEY = `nl:stats:${SID}:spend`;
const day = new Date().toISOString().slice(0, 10);
const LINE = { channel: "instagram", cents: 1200, from: day, to: day };
const real = redis.pipeline.bind(redis);

async function rows() {
  const [flat] = await real([["HGETALL", KEY]]);
  return (flat as string[]).filter((_, i) => i % 2 === 1)
    .map(text => (JSON.parse(text) as { cents: number }).cents);
}

async function interrupted(deferred: boolean) {
  const pending: Command[][] = [];
  let result: Awaited<ReturnType<typeof addSpend>> | undefined;
  let error: unknown;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "HSET")) {
      if (deferred) pending.push(commands);
      throw new Error("synthetic client transport failed; command completion is unresolved");
    }
    return real(commands);
  };
  try { result = await addSpend(SID, LINE); } catch (caught) { error = caught; }
  finally { redis.pipeline = real; }
  return { result, error, pending };
}

test("control: a healthy write records one expense", async () => {
  redis.clear();
  assert.equal((await addSpend(SID, LINE)).ok, true);
  assert.deepEqual(await rows(), [1200]);
});

test("control: failure before dispatch leaves nothing and a healthy retry records one", async () => {
  redis.clear();
  const first = await interrupted(false);
  assert.equal(first.result?.ok === true, false);
  assert.deepEqual(await rows(), []);
  assert.equal((await addSpend(SID, LINE)).ok, true);
  assert.deepEqual(await rows(), [1200]);
});

test("cleanup count zero cannot prove a still-pending write will never apply", async () => {
  redis.clear();
  const first = await interrupted(true);
  assert.equal(first.pending.length, 1);
  assert.deepEqual(await rows(), [], "the first write has not applied yet");
  console.log(JSON.stringify({ phase: "before delayed completion", result: first.result, threw: !!first.error }));
  assert.ok(first.error, "an unresolved write must remain an unknown outcome, not confirmed not-saved");
});

test("a pending first write completing after cleanup and retry must not duplicate the expense", async () => {
  redis.clear();
  const first = await interrupted(true);
  assert.equal(first.pending.length, 1);
  assert.deepEqual(await rows(), []);
  assert.equal((await addSpend(SID, LINE)).ok, true);
  for (const commands of first.pending) await real(commands);
  const kept = await rows();
  console.log(JSON.stringify({ phase: "after retry and delayed completion", kept }));
  assert.deepEqual(kept, [1200], "one expense remains one even when the first transport completes late");
});
