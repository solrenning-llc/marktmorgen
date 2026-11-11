/**
 * Rule 24 in the daily walk of stores whose members are held (lib/closing-holds.ts, releaseRestarted): a store is
 * "gone", and leaves the index, only when its owner key is confirmed absent (EXISTS answers exactly 0,
 * lib/store.ts storeRefGone). A store record read in another shape, or a read that fails, keeps the entry for the next
 * day ("held"), so its paused members are released once it reads again, instead of being left paused for good with
 * nothing left to release them. The index's own pages are read exactly too.
 *
 * Synthetic store only; nothing reaches Stripe (the store whose record does not read is never acted on).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HELD_INDEX, releaseRestarted } from "@/lib/closing-holds";
import { claimHandle, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const OWNER = "held-owner@example.com";
const stays = async () => true;

const fixture = (async () => {
  redis.clear();
  const made = await claimHandle(OWNER, "heldshop", "Held Shop", "");
  assert.equal(made.ok, true);
  const store = (await storeForEmail(OWNER))!;
  return storeRef(store);
})();

async function walk(alter: ((batch: Batch, real: unknown[]) => unknown[] | null) | null): Promise<{ value?: unknown; error?: unknown }> {
  redis.pipeline = (async (batch: Batch) => {
    const real = await pipeline(batch);
    return (alter && alter(batch, real)) ?? real;
  }) as typeof redis.pipeline;
  try {
    return { value: await releaseRestarted(Date.now() + 60_000, stays) };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = pipeline;
  }
}
const indexed = async (key: string) => (await pipeline([["ZSCORE", HELD_INDEX, key]]))[0] !== null;
const ownerGet = (batch: Batch) => batch.length === 1 && batch[0][0] === "GET" && String(batch[0][1]).startsWith("nl:store:owner:");

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]], ["text that is not a store", ["{not json"]]] as [string, unknown[]][]) {
  test(`the store's record read as ${label}: kept in the index, never "gone"`, async () => {
    const key = await fixture;
    await pipeline([["ZADD", HELD_INDEX, "1700000000000", key]]);
    const result = await walk((batch) => (ownerGet(batch) ? reply : null));
    const states = (result.value as { key: string; state: string }[] | undefined) ?? [];
    assert.notDeepEqual(states.find((r) => r.key === key)?.state, "gone");
    assert.equal(await indexed(key), true, "its paused members can still be released later");
  });
}

test("the store's record read failing: kept in the index", async () => {
  const key = await fixture;
  await pipeline([["ZADD", HELD_INDEX, "1700000000000", key]]);
  redis.pipeline = (async (batch: Batch) => {
    if (ownerGet(batch)) throw new Error("synthetic Redis failure");
    return pipeline(batch);
  }) as typeof redis.pipeline;
  try {
    await releaseRestarted(Date.now() + 60_000, stays).catch(() => []);
  } finally {
    redis.pipeline = pipeline;
  }
  assert.equal(await indexed(key), true);
});

test("a store whose owner key is confirmed gone leaves the index", async () => {
  await fixture;
  const ghost = "ghost-owner@example.com";
  await pipeline([["ZADD", HELD_INDEX, "1700000000000", ghost]]);
  const result = await walk(null);
  assert.equal((result.value as { key: string; state: string }[]).find((r) => r.key === ghost)?.state, "gone");
  assert.equal(await indexed(ghost), false);
});

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an odd count", [["a"]]]] as [string, unknown[]][]) {
  test(`the index page read as ${label}: an error, never "nobody is held"`, async () => {
    const key = await fixture;
    await pipeline([["ZADD", HELD_INDEX, "1700000000000", key]]);
    const result = await walk((batch) => (batch.length === 1 && batch[0][0] === "ZRANGEBYSCORE" && batch[0][1] === HELD_INDEX ? reply : null));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}
