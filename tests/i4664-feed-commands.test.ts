/**
 * #4664, review 5bNDa (LEVE): the grant's re-read of its index (lib/podcast-access.ts, stillIndexed) adds a read, and
 * a grant taken back adds a write, to what one private podcast feed makes. ORDERS_FEED_COMMANDS (lib/buyer-orders-
 * rules.ts) is what the orders page takes from its meter for each feed, in commands: every read one, every write two
 * (the write and the room it is counted in). Driven here down its heaviest path, an index another request kept first
 * whose grant is missing and whose index has moved on by the time the grant is written, every command counted.
 * Synthetic store and listener only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken } from "@/lib/podcast-access";
import { ORDERS_FEED_COMMANDS } from "@/lib/buyer-orders-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const OWNER = "podcast-feed-commands@example.test";
const original: Pipeline = redis.pipeline.bind(redis);

test("the heaviest path of one feed stays inside ORDERS_FEED_COMMANDS", async () => {
  redis.clear();
  redis.pipeline = original;
  await claimHandle(OWNER, "podcount", "Podcast Count", "");
  await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodCount", subscriptionId: "sub_PodCount", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
  assert.ok(made.ok);
  const shop = (await storeForEmail(OWNER))!;
  const email = "listener@example.test";
  // Another request kept its token in the index first, and its grant was never written.
  const kept = "a".repeat(48);
  await feedToken(shop, made.product.id, email);
  const index = redis.keys().find((k) => k.startsWith("nl:pod:by:"))!;
  for (const k of redis.keys().filter((k) => k.startsWith("nl:pod:t:"))) await original([["DEL", k]]);
  await original([["SET", index, kept]]);

  let commands = 0;
  let indexReads = 0;
  redis.pipeline = (async (batch: Commands) => {
    for (const c of batch) commands += c[0] === "EVAL" ? 2 : 1;
    if (batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === index) {
      indexReads += 1;
      // The first read finds none yet (the other request's SET NX lands after it); the last finds the index moved on.
      if (indexReads === 1) return [null];
      if (indexReads === 3) return ["b".repeat(48)];
    }
    return original(batch);
  }) as Pipeline;
  try {
    assert.equal(await feedToken(shop, made.product.id, email), null, "no link to a grant whose index moved on");
  } finally { redis.pipeline = original; }
  assert.equal(indexReads, 3, "the path driven is the heaviest one: the index read three times");
  assert.ok(commands <= ORDERS_FEED_COMMANDS, `one feed made ${commands} commands; ORDERS_FEED_COMMANDS is ${ORDERS_FEED_COMMANDS}`);
});
