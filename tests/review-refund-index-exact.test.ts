/**
 * Rule 24: which reviews a payment paid for (nl:rev:pay:<statsId>, one HGET
 * per payment) is read exactly.
 *
 *   - markRefunded: a reply cut short or of another shape is unknown, never
 *     "this payment paid for no review": it throws, so the refund sweep
 *     (lib/review-proof.ts) does not take the refund as seen and tries again,
 *     instead of leaving a refunded buyer's review public and counted;
 *   - payEntry (inside saveReview): a reply of another shape throws instead of
 *     writing the payment's list again with only the newest review, which lost
 *     the others for a later refund.
 *
 * Synthetic store, product and reviews only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { markRefunded, readReview, reviewId, saveReview } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const statsId = "fedcba9876543210fedcba9876543210";
const PI = "pi_refundindex01";
const PAY = `nl:rev:pay:${statsId}`;
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const payRead = (batch: Batch) => batch.length === 1 && batch[0][0] === "HGET" && batch[0][1] === PAY;

async function withPayReply<T>(reply: unknown[], run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  redis.pipeline = (async (batch: Batch) => (payRead(batch) ? reply : pipeline(batch))) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = pipeline;
  }
}

const review = (productId: string, email: string) =>
  saveReview(statsId, { productId, email, reference: `cs_test_${productId}000001`, pi: PI, rating: 5, text: "Clear lessons.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);

redis.clear();
const fixture = (async () => {
  for (const [product, email] of [["synthbread01", "ana@example.com"], ["synthcake001", "ana@example.com"]]) {
    const saved = await review(product, email);
    assert.equal(saved.state, "created");
  }
})();

const SHAPES: [string, unknown[]][] = [
  ["no reply", []],
  ["two slots for one command", [null, null]],
  ["a number", [7]],
  ["a list", [["synthbread01|x"]]],
  ["an object", [{}]],
];

for (const [label, reply] of SHAPES) {
  test(`markRefunded: ${label} throws, never "no review" (the refund is tried again)`, async () => {
    await fixture;
    const result = await withPayReply(reply, () => markRefunded(statsId, PI));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
    const first = await readReview(statsId, "synthbread01", reviewId(statsId, "synthbread01", "ana@example.com"));
    assert.equal(first?.refunded ?? false, false, "nothing marked on an unknown read");
  });
}

for (const [label, reply] of SHAPES) {
  test(`saveReview: the payment's list answered as ${label} is never written again with one review only`, async () => {
    await fixture;
    const [before] = await pipeline([["HGET", PAY, PI]]);
    const result = await withPayReply(reply, () => review("synthjam0001", "ana@example.com"));
    const [after] = await pipeline([["HGET", PAY, PI]]);
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
    assert.equal(after, before, "the payment's list is kept as it was");
  });
}

test("an exact empty read is still no review, and a full refund marks every review the payment paid for", async () => {
  await fixture;
  assert.equal(await markRefunded(statsId, "pi_nothingpaid01"), 0);
  assert.equal(await markRefunded(statsId, PI), 2);
  for (const product of ["synthbread01", "synthcake001"]) {
    assert.equal((await readReview(statsId, product, reviewId(statsId, product, "ana@example.com")))?.refunded, true);
  }
});
