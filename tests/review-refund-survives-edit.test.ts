/**
 * Reviews: a review whose payment was refunded in full (markRefunded, by the refund sweep) must stay
 * refunded when its buyer saves it again from the SAME order. saveReview writes `refunded: false` unconditionally,
 * so an edit whose proof was read just before the sweep marked it (or whose lost dispute could not be read, which
 * provePurchase counts as "not lost") puts its stars back into the average for good: the sweep keeps the refund as
 * seen and never marks it again.
 */
import { markRefunded, readReview, reviewId, saveReview, summaryOf } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

async function main(): Promise<void> {
  redis.clear();
  const statsId = "a".repeat(32);
  const productId = "prodhunt01";
  const email = "buyer@example.com";
  const order = { productId, email, reference: "cs_test_huntrefund000001", pi: "pi_HuntRefund0001", rating: 5, text: "Loved it", name: "B" };

  part("A refunded review edited again from the same order");
  is("written", (await saveReview(statsId, order, ROOM)).state, "created");
  is("the sweep marks it refunded", await markRefunded(statsId, order.pi), 1);
  is("its stars left the average", (await summaryOf(statsId, productId)).count, 0);
  // The buyer's edit, its proof read from Stripe a moment before the refund (or its lost dispute unread).
  await saveReview(statsId, { ...order, text: "Loved it, edited" }, ROOM);
  const after = await readReview(statsId, productId, reviewId(statsId, productId, email));
  is("still refunded after an edit from the same refunded order", after?.refunded, true);
  is("its stars stay out of the average", (await summaryOf(statsId, productId)).count, 0);

  part("Control: written again from another order that was kept, it counts");
  await saveReview(statsId, { ...order, reference: "cs_test_huntrefund000002", pi: "pi_HuntRefund0002", text: "Bought again, still love it" }, ROOM);
  is("no longer refunded", (await readReview(statsId, productId, reviewId(statsId, productId, email)))?.refunded, false);
  is("its stars are back in the average", (await summaryOf(statsId, productId)).count, 1);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
