/**
 * Rule 24: which reviews a payment paid for (nl:rev:pay:<statsId>, one HGET
 * per payment) is read exactly.
 *
 *   - markRefunded: a reply cut short or of another shape is unknown, never
 *     "this payment paid for no review": it throws, so the refund sweep
 *     (lib/review-proof.ts) does not take the refund as seen and tries again,
 *     instead of leaving a refunded buyer's review public and counted;
 *   - payEntry (inside saveReview): a reply of another shape throws, before the
 *     review is written, instead of writing the payment's list again with only
 *     the newest review, which lost the others for a later refund.
 *
 * Synthetic store, product and reviews only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dropReviews, markRefunded, readReview, reviewId, saveReview } from "@/lib/reviews";
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

const review = (productId: string, email: string, pi = PI) =>
  saveReview(statsId, { productId, email, reference: `cs_test_${productId}000001`, pi, rating: 5, text: "Clear lessons.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);

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
    assert.equal(await readReview(statsId, "synthjam0001", reviewId(statsId, "synthjam0001", "ana@example.com")), null, "and the review is not saved half");
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

// dropReviews (a product removed, app/api/store/product): its reviews' ids and photos are read once, exactly. A reply
// cut short or of another shape throws before anything is deleted, so no review leaves the store's indexes behind
// and no buyer's photo is left in the picture folder with nothing pointing at it any more.
const PHOTO_PRODUCT = "synthphoto01";
const PHOTO_PATH = `images/${"a".repeat(24)}/${"b".repeat(32)}.jpg`;
const photoFixture = (async () => {
  await fixture;
  const saved = await review(PHOTO_PRODUCT, "photo@example.com", "pi_photoreview01");
  assert.equal(saved.state, "created");
  const key = `nl:rev:${statsId}:${PHOTO_PRODUCT}`;
  const [fields] = await pipeline([["HGETALL", key]]);
  const [id, raw] = fields as string[];
  await pipeline([["HSET", key, id, JSON.stringify({ ...JSON.parse(raw), photo: { path: `${PHOTO_PATH}`, width: 10, height: 10 } })]]);
  return key;
})();

for (const [label, alter] of [
  ["no replies", () => []],
  ["one reply short", (r: unknown[]) => r.slice(0, 1)],
  ["the ids as a number", (r: unknown[]) => [7, r[1]]],
  ["the reviews as null", (r: unknown[]) => [r[0], null]],
  ["an id that is not text", (r: unknown[]) => [[1], r[1]]],
] as [string, (r: unknown[]) => unknown[]][]) {
  test(`dropReviews: ${label} throws before anything is deleted`, async () => {
    const key = await photoFixture;
    redis.pipeline = (async (batch: Batch) => {
      const real = await pipeline(batch);
      return batch.length === 2 && batch[0][0] === "HKEYS" && batch[1][0] === "HVALS" ? alter(real) : real;
    }) as typeof redis.pipeline;
    let result: { value?: unknown; error?: unknown };
    try {
      result = { value: await dropReviews(statsId, PHOTO_PRODUCT) };
    } catch (error) {
      result = { error };
    } finally {
      redis.pipeline = pipeline;
    }
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
    assert.equal((await pipeline([["HLEN", key]]))[0], 1, "the review and its photo are kept for a retry");
  });
}

test("dropReviews read exactly hands back the photo to delete", async () => {
  await photoFixture;
  assert.deepEqual(await dropReviews(statsId, PHOTO_PRODUCT), [`${PHOTO_PATH}`]);
});
