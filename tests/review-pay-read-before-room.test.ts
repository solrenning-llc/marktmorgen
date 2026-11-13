/**
 * Review of #3862 (Claude 3 clouds O and N): saveReview reads the payment's review list (payEntry) before it takes
 * any room in the store's data room, so a list that does not read stops the save with the room as it was, never
 * with room taken for a review that was not written (as #3812 orders it).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { saveReview } from "@/lib/reviews";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const statsId = "fedcba9876543210fedcba9876543211";
const PAY = `nl:rev:pay:${statsId}`;
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

test("a payment list that does not read takes no room", async () => {
  redis.clear();
  const before = await dataUsed(ROOM);
  redis.pipeline = (async (batch: Batch) => (batch.length === 1 && batch[0][0] === "HGET" && batch[0][1] === PAY ? [7] : pipeline(batch))) as typeof redis.pipeline;
  let failed = false;
  try {
    await saveReview(statsId, { productId: "synthroom001", email: "ana@example.com", reference: "cs_test_synthroom001000001", pi: "pi_roomorder01", rating: 5, text: "Clear lessons.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);
  } catch {
    failed = true;
  } finally {
    redis.pipeline = pipeline;
  }
  assert.ok(failed, "the save is refused");
  assert.deepEqual(await dataUsed(ROOM), before, "the store's room is as it was");
});
