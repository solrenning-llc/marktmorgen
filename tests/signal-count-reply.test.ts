/**
 * A signal's count (lib/traffic.ts, takeSignal) is made only from Redis's own
 * answer to its two commands, INCR and the EXPIRE with it: two replies, an
 * integer of at least one, then 1 (CX-123, rule 24). Anything else (a `true`,
 * a text, a 0, a missing or extra item) is a count that cannot be made:
 * nothing is written, and the count not made is written down (countGap).
 * Synthetic Redis (tests/redis-stub.ts), synthetic store.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { countGap, takeSignal } from "@/lib/traffic";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

async function seed() {
  redis.clear();
  const owner = "signalreply@example.test";
  assert.equal((await claimHandle(owner, "signalreply", "Synthetic shop", "")).ok, true);
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_SignalReply", subscriptionId: "sub_SignalReply", active: true, tier: "creator", period: paidPeriod() });
  const store = await storeForEmail(owner);
  assert.ok(store?.subscriptionActive);
  return store;
}

test("a signal's count from Redis's exact answer is taken, and the write runs", async () => {
  const store = await seed();
  let wrote = 0;
  assert.equal(await takeSignal(store, async () => { wrote += 1; return true; }), true);
  assert.equal(wrote, 1);
  assert.equal(await countGap(store, "clicks"), null);
});

for (const receipt of [[true, 1], ["1", 1], [1], [1, 1, 1], [1, "1"], [1, true], [null, 1], [1.5, 1], [1, 0], ["OK", 1], [0, 1]]) {
  test(`a signal's count answered ${JSON.stringify(receipt)} is not made: nothing written, and written down`, async () => {
    const store = await seed();
    const original = redis.pipeline.bind(redis);
    redis.pipeline = async (commands) => (commands.some((c) => c[0] === "INCR") ? (receipt as never) : original(commands));
    let wrote = 0;
    let taken: boolean;
    try {
      taken = await takeSignal(store, async () => { wrote += 1; return true; });
    } finally {
      redis.pipeline = original;
    }
    assert.equal(taken, false);
    assert.equal(wrote, 0);
    assert.notEqual(await countGap(store, "clicks"), null, "a count not made is written down");
  });
}

test("a key deleted takes its expiry with it, as in Redis: a count made again gets a new one", async () => {
  // The stand-in kept the expiry of a deleted key, so EXPIRE NX on a count
  // made again under the same name answered 0, which Redis never does there.
  const { MemoryRedis } = await import("@/lib/redis-memory");
  const r = new MemoryRedis();
  assert.deepEqual(await r.pipeline([["INCRBY", "count", 1], ["EXPIRE", "count", 60, "NX"]]), [1, 1]);
  assert.deepEqual(await r.pipeline([["DEL", "count"], ["TTL", "count"]]), [1, -2]);
  assert.deepEqual(await r.pipeline([["INCRBY", "count", 1], ["TTL", "count"], ["EXPIRE", "count", 60, "NX"]]), [1, -1, 1]);
});

test("a count's expiry goes in the same write, never by an EXPIRE with an option", async () => {
  // EXPIRE NX is refused by a Redis or REST service that does not take
  // options (tests/letter-members.test.ts): the expiry is the same point at
  // every count (keepSecondsFor), set again with each.
  const store = await seed();
  const original = redis.pipeline.bind(redis);
  const sent: (string | number)[][][] = [];
  redis.pipeline = async (commands) => { sent.push(commands.map((c) => [...c])); return original(commands); };
  try {
    assert.equal(await takeSignal(store, async () => false), false);
    assert.equal(await takeSignal(store), true);
  } finally {
    redis.pipeline = original;
  }
  assert.equal(sent.flat().some((c) => String(c[0]).toUpperCase() === "EXPIRE" && c.length > 3), false);
  const counts = sent.filter((list) => list.some((c) => c[0] === "INCR" || c[0] === "DECR"));
  assert.ok(counts.length >= 3);
  for (const list of counts) assert.ok(list.length === 2 && list[1][0] === "EXPIRE" && list[1][1] === list[0][1] && Number(list[1][2]) > 0, JSON.stringify(list));
});
