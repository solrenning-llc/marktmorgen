/**
 * The orders a store had in its window decide how many free copies it may still give (lib/free.ts, freeCopiesLimitFor
 * with storeOrdersThisMonth); for a store that pays, nothing else holds that ceiling (admitOrders has no paid limit).
 * Read exactly (CX-123 rule 24, MR): a count that does not read is unknown (null: no free copy is given), never 0,
 * which would give free copies, each one costing its email and its file, past the plan's figure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOrdersThisMonth } from "@/lib/orders";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const owner = "free-copies-count@example.test";
async function fixture() {
  redis.clear();
  assert.equal((await claimHandle(owner, "freecopiescount", "Free Copies", "")).ok, true);
  await ensureStatsId(owner);
  assert.ok(await setSubscription(owner, { customerId: "cus_FreeCopiesCnt", subscriptionId: "sub_FreeCopiesCnt", active: true, tier: "creator", period: paidPeriod() }));
  return (await storeForEmail(owner))!;
}
async function withCountReply(reply: unknown, run: () => Promise<unknown>) {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (batch) => {
    const replies = (await original(batch)) as unknown[];
    return batch.map((c, i) => (c[0] === "GET" && String(c[1]).startsWith("nl:orders:n:") ? reply : replies[i])) as never;
  };
  try { return await run(); } finally { redis.pipeline = original; }
}

test("control: no order counted is 0, a count is that count", async () => {
  const store = await fixture();
  assert.equal(await storeOrdersThisMonth(store), 0);
  assert.equal(await withCountReply("7", () => storeOrdersThisMonth(store)), 7);
});

for (const [name, reply] of [["text", "abc"], ["a number type", 7], ["a negative count", "-3"], ["a list", ["7"]]] as const) {
  test(`a count read as ${name} is unknown, never 0`, async () => {
    const store = await fixture();
    assert.equal(await withCountReply(reply, () => storeOrdersThisMonth(store)), null);
  });
}

test("a count that throws is unknown, never 0", async () => {
  const store = await fixture();
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (batch) => {
    if (batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:orders:n:"))) throw new Error("Redis request timed out (test)");
    return original(batch);
  };
  try { assert.equal(await storeOrdersThisMonth(store), null); } finally { redis.pipeline = original; }
});
