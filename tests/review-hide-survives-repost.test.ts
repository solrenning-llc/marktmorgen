/**
 * Reviews: lib/reviews.ts says an edit keeps "the creator's choice to hide it". A buyer whose review was
 * hidden (for one of HIDE_REASONS, e.g. private information) can undo that choice without the creator: delete the
 * review through the same door, then write it again from the same order. The new review has the same id (store,
 * product, address) but `hidden: false`, so the same words are back on the product page and in the store's quotes.
 */
import { deleteReview, forgetReviewsPerson, readReview, reviewId, saveReview, setHidden, visibleReviews } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

async function main(): Promise<void> {
  redis.clear();
  const statsId = "b".repeat(32);
  const productId = "prodhunt02";
  const email = "buyer@example.com";
  const order = { productId, email, reference: "cs_test_hunthide00000001", pi: "pi_HuntHide000001", rating: 1, text: "Call the teacher at her home, 12 Elm St", name: "B" };
  const id = reviewId(statsId, productId, email);

  part("A hidden review deleted and written again by its buyer");
  await saveReview(statsId, order, ROOM);
  const hidden = await setHidden(statsId, productId, id, true, "private");
  is("hidden by the creator for private information", typeof hidden === "object" && hidden !== null && hidden.hidden, true);
  is("an edit keeps it hidden (as documented)", (await saveReview(statsId, { ...order, text: order.text + "!" }, ROOM), (await readReview(statsId, productId, id))?.hidden), true);
  is("the buyer deletes it", await deleteReview(statsId, productId, id, ROOM), "deleted");
  await saveReview(statsId, order, ROOM);
  is("written again from the same order: still hidden", (await readReview(statsId, productId, id))?.hidden, true);
  is("and its words are not back on the product page", (await visibleReviews(statsId, productId)).map((r) => r.text), []);
  is("the creator's reason comes back with it", (await readReview(statsId, productId, id))?.hiddenReason, "private");
  const marks = async () => (await redis.pipeline([["HLEN", `nl:rev:hid:${statsId}:${productId}`]]))[0];
  is("the hide it left is taken off once the review carries it again", await marks(), 0);

  part("The person's erasure leaves no hide behind");
  is("deleted again by the buyer: a hide is left", (await deleteReview(statsId, productId, id, ROOM), await marks()), 1);
  await forgetReviewsPerson(statsId, [productId], email, ROOM);
  is("erased: nothing is left under their review", await marks(), 0);
  await saveReview(statsId, order, ROOM);
  await setHidden(statsId, productId, id, true, "abusive");
  await forgetReviewsPerson(statsId, [productId], email, ROOM);
  is("a hidden review erased with its person leaves no hide either", [await readReview(statsId, productId, id), await marks()], [null, 0]);

  part("Control: a review never hidden, deleted and written again, is shown");
  const other = { ...order, email: "kind@example.com", text: "Clear and useful", pi: "pi_HuntHide000002", reference: "cs_test_hunthide00000002" };
  const otherId = reviewId(statsId, productId, other.email);
  await saveReview(statsId, other, ROOM);
  await deleteReview(statsId, productId, otherId, ROOM);
  await saveReview(statsId, other, ROOM);
  is("shown", (await visibleReviews(statsId, productId)).map((r) => r.text), ["Clear and useful"]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
