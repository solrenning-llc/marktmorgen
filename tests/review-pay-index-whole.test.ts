/**
 * Which reviews a payment paid for (lib/reviews.ts, nl:rev:pay:<statsId>), kept whole for its refund (Claude 7's
 * reviews hunt, 14 November 2026; synthetic store, products and reviews only):
 *
 *   - one order can hand over more than twenty products a buyer may review (deliveredIds: the product, three bumps,
 *     a bundle of twenty, each bump's bundle, the affiliate's extras); the list kept only the last twenty, so after a
 *     full refund the first review's stars still counted;
 *   - two reviews of the same order saved at once each read the list, added their own and wrote it back: the second
 *     write lost the first, which then still counted after the refund. The list is now read and written under the
 *     payment's own lock.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { markRefunded, readReview, reviewId, saveReview, summaryOf } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const statsId = "0123456789abcdef0123456789abcdef";
const PAY = `nl:rev:pay:${statsId}`;
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

const review = (productId: string, pi: string) =>
  saveReview(statsId, { productId, email: "lee@example.com", reference: `cs_test_${pi}`, pi, rating: 5, text: "Clear lessons.", name: "Lee", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);
const product = (n: number) => `synthpay${String(n).padStart(4, "0")}`;

test("an order of twenty-four products: a full refund marks all twenty-four reviews", async () => {
  redis.clear();
  const pi = "pi_wholelist0001";
  for (let n = 1; n <= 24; n += 1) assert.equal((await review(product(n), pi)).state, "created");
  assert.equal(await markRefunded(statsId, pi), 24, "every review the payment paid for is marked");
  const first = await readReview(statsId, product(1), reviewId(statsId, product(1), "lee@example.com"));
  assert.equal(first?.refunded, true, "the first review is marked refunded");
  assert.equal((await summaryOf(statsId, product(1))).count, 0, "and no longer counts");
});

test("two reviews of one order saved at once: both are kept for its refund", async () => {
  redis.clear();
  const pi = "pi_twoatonce0001";
  // Each save's read of the payment's list waits until both have read it, as two requests at once would.
  let waiting: (() => void)[] = [];
  let reads = 0;
  redis.pipeline = (async (batch: Batch) => {
    const replies = await pipeline(batch);
    if (batch.length === 1 && batch[0][0] === "HGET" && batch[0][1] === PAY && reads < 2) {
      reads += 1;
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) {
          waiting.forEach((go) => go());
          waiting = [];
        }
        setTimeout(resolve, 300);
      });
    }
    return replies;
  }) as typeof redis.pipeline;
  try {
    const [one, two] = await Promise.all([review(product(1), pi), review(product(2), pi)]);
    assert.deepEqual([one.state, two.state], ["created", "created"]);
  } finally {
    redis.pipeline = pipeline;
  }
  assert.equal(await markRefunded(statsId, pi), 2, "both reviews are marked by the refund");
});
