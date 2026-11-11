/**
 * The reviews a payment paid for (lib/reviews.ts, payKey) are read exactly (CX-123 rule 24, rule 30; VR item 2).
 * Found by Claude 3 (cloud D)'s audit of main @7b04206e7 (11 November 2026):
 *
 * - markRefunded read a reply of another shape as "this payment paid for no review", answered 0 and did not throw,
 *   so the refund pass (lib/review-proof.ts, markRefundedReviews) took the refund as seen for good: the review of a
 *   buyer who got their money back went on showing as a buyer who kept what they bought.
 * - payEntry, its sibling, read such a reply as an empty list and wrote the payment's list back as only the new
 *   review: the other reviews that payment paid for (a bundle's products) lost their link to it, and a later refund
 *   in full marked only one of them.
 *
 * Now both throw UnknownReplyError on such a reply: the refund is not taken as seen and the pass tries it again, and
 * the review is not saved (the review page says nothing was changed). Synthetic store, products and reviews only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { markRefunded, readReview, reviewId, saveReview } from "@/lib/reviews";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const statsId = "0123456789abcdef0123456789abcdef";
const pi = "pi_bundle0001";
const email = "refund-exact@example.com";
const first = "synthbook001";
const second = "synthbook002";

const real = redis.pipeline.bind(redis);
let odd: { command: string; reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = (await real(commands)) as unknown[];
  if (!odd) return replies;
  // Only the read of the payment's list (HGET on its key) answers oddly.
  const hit = (c: (string | number)[]) => c[0] === odd!.command && String(c[1]).includes(":pay");
  if (odd.reply === "LOST" && commands.some(hit)) return [];
  return commands.map((c, i) => (hit(c) ? odd!.reply : replies[i]));
}) as typeof redis.pipeline;

async function twoReviewsOnePayment() {
  redis.clear();
  odd = null;
  for (const productId of [first, second]) {
    const saved = await saveReview(statsId, { productId, email, reference: "cs_test_bundle0001", pi, rating: 5, text: "Kept it.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);
    assert.equal(saved.state, "created");
  }
}

for (const reply of ["LOST", 7, { a: 1 }, ["x"]]) {
  test(`a refund whose payment's reviews read ${JSON.stringify(reply)} is unknown: it throws, never "no review" taken as seen`, async () => {
    await twoReviewsOnePayment();
    odd = { command: "HGET", reply };
    await assert.rejects(markRefunded(statsId, pi), (e) => e instanceof UnknownReplyError);
    odd = null;
    // Nothing was marked on the unknown: the next pass marks both.
    assert.equal((await readReview(statsId, first, reviewId(statsId, first, email)))?.refunded ?? false, false);
    assert.equal(await markRefunded(statsId, pi), 2);
  });
}

for (const reply of ["LOST", 7, { a: 1 }]) {
  test(`a review saved while its payment's list reads ${JSON.stringify(reply)} is not saved over the list`, async () => {
    await twoReviewsOnePayment();
    odd = { command: "HGET", reply };
    await assert.rejects(
      saveReview(statsId, { productId: "synthbook003", email, reference: "cs_test_bundle0001", pi, rating: 4, text: "Third.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000),
      (e) => e instanceof UnknownReplyError,
    );
    odd = null;
    // The payment still names both reviews it paid for: a refund in full marks both.
    assert.equal(await markRefunded(statsId, pi), 2);
  });
}

test("readable replies: a refund in full marks every review its payment paid for, and none twice", async () => {
  await twoReviewsOnePayment();
  assert.equal(await markRefunded(statsId, pi), 2);
  assert.equal(await markRefunded(statsId, pi), 0);
  assert.equal(await markRefunded(statsId, "pi_nothing0001"), 0);
});
