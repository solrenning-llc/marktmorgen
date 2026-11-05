/**
 * A signal's count (lib/traffic.ts, takeSignal) is made only from Redis's own
 * answer to its two commands, INCR and EXPIRE NX: two replies, the first an
 * integer of at least one, the second 0 or 1 (CX-123, rule 24). Anything else
 * (a `true`, a text, a missing or extra item) is a count that cannot be made:
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
  assert.equal(await countGap(store), null);
});

for (const receipt of [[true, 1], ["1", 1], [1], [1, 1, 1], [1, "1"], [1, true], [null, 1], [1.5, 1]]) {
  test(`a signal's count answered ${JSON.stringify(receipt)} is not made: nothing written, and written down`, async () => {
    const store = await seed();
    const original = redis.pipeline.bind(redis);
    redis.pipeline = async (commands) => (commands[0]?.[0] === "INCR" ? (receipt as never) : original(commands));
    let wrote = 0;
    let taken: boolean;
    try {
      taken = await takeSignal(store, async () => { wrote += 1; return true; });
    } finally {
      redis.pipeline = original;
    }
    assert.equal(taken, false);
    assert.equal(wrote, 0);
    assert.notEqual(await countGap(store), null, "a count not made is written down");
  });
}
