/**
 * #5285, row of #3862 (Codex X6's MEDIUM, comment 6867519464, still in main): each review a payment paid for
 * (nl:rev:pay:<statsId>, "<product>|<review id>" joined by ";") is read exactly. A member of another shape used to be
 * skipped by markRefunded (`if (!productId || !id) continue`) or answered "missing", so the refund sweep
 * (lib/review-proof.ts) took the refund as seen and a refunded buyer's paid review stayed public, not marked. Now a
 * member that is not a product id, a "|" and a review id makes the list unknown: UnknownReplyError, nothing marked,
 * and the sweep tries the refund again. A well-formed list is marked as before.
 *
 * Synthetic store, product and reviews only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { markRefunded, readReview, reviewId, saveReview } from "@/lib/reviews";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const statsId = "0123456789abcdef0123456789abcdef";
const PI = "pi_paymemberexact1";
const PAY = `nl:rev:pay:${statsId}`;
const PRODUCTS = ["synthbread01", "synthcake001"];

async function fixture(): Promise<string> {
  redis.clear();
  for (const product of PRODUCTS) {
    const saved = await saveReview(statsId, { productId: product, email: "ana@example.com", reference: `cs_test_${product}000001`, pi: PI, rating: 5, text: "Clear lessons.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, 1_780_100_000_000);
    assert.equal(saved.state, "created");
  }
  const kept = redis.run(["HGET", PAY, PI]);
  assert.equal(typeof kept, "string");
  return kept as string;
}

const refunded = async (product: string) => (await readReview(statsId, product, reviewId(statsId, product, "ana@example.com")))?.refunded ?? false;

for (const [label, bad] of [
  ["a member with no bar", "junk"],
  ["a member with an empty review id", "synthbread01|"],
  ["a member with an extra part", "synthbread01|abc|def"],
  ["a member whose product id is not one", "BAD!|abcdef"],
] as [string, string][]) {
  test(`markRefunded: ${label} makes the list unknown, and nothing is marked`, async () => {
    const kept = await fixture();
    redis.run(["HSET", PAY, PI, `${bad};${kept}`]);
    await assert.rejects(markRefunded(statsId, PI), UnknownReplyError);
    for (const product of PRODUCTS) assert.equal(await refunded(product), false, `${product} marked on an unknown list`);
  });
}

test("markRefunded: a well-formed list marks every review it names, as before", async () => {
  await fixture();
  assert.equal(await markRefunded(statsId, PI), 2);
  for (const product of PRODUCTS) assert.equal(await refunded(product), true);
});
