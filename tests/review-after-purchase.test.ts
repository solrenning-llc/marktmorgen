/**
 * 606 [WP5], unit 1: a new review keeps when its order was paid, an edit of
 * the same order keeps the first, and the review list says how long after
 * purchase it was written, in the store's language; a review from before
 * says nothing rather than guessing (lib/buyer-words/reviews.ts,
 * lib/reviews.ts, components/review-list.tsx). Synthetic store and reviews.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewItem } from "@/components/review-list";
import { afterPurchase, afterPurchaseLine } from "@/lib/buyer-words/reviews";
import { parseReview, readReview, reviewId, saveReview } from "@/lib/reviews";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const DAY = 86_400;

async function main(): Promise<void> {
  redis.clear();

  part("How long after paying");
  const paid = 1_780_000_000;
  is("the same day", afterPurchase(paid, paid + 3_600), { unit: "same", count: 0 });
  is("days up to 13", afterPurchase(paid, paid + 13 * DAY), { unit: "day", count: 13 });
  is("weeks from 14 days", afterPurchase(paid, paid + 20 * DAY), { unit: "week", count: 2 });
  is("months from 60 days", afterPurchase(paid, paid + 95 * DAY), { unit: "month", count: 3 });
  is("years from 730 days", afterPurchase(paid, paid + 800 * DAY), { unit: "year", count: 2 });
  is("unknown purchase time: nothing", afterPurchase(0, paid), null);
  is("written before it was paid: nothing", afterPurchase(paid, paid - 10), null);

  part("In every language the store speaks");
  is("English", afterPurchaseLine("en", paid, paid + 3 * DAY), "Written 3 days after purchase");
  is("English, the same day", afterPurchaseLine("en", paid, paid + 60), "Written on the day of purchase");
  is("Portuguese", afterPurchaseLine("pt", paid, paid + 3 * DAY), "Escrita 3 dias depois da compra");
  is("German", afterPurchaseLine("de", paid, paid + 3 * DAY), "3 Tage nach dem Kauf geschrieben");
  is("Spanish, French, Italian and Dutch say it too", ["es", "fr", "it", "nl"].every((l) => afterPurchaseLine(l, paid, paid + 3 * DAY).includes("3")), true);
  is("unknown: no sentence", afterPurchaseLine("en", 0, paid), "");

  part("Kept when the review is written, the first one kept through an edit");
  const owner = "review-after-purchase@example.com";
  await claimHandle(owner, "review-after-purchase", "Review After Purchase", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const made = await addProduct(owner, "Bread Course", "", "29", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  const writtenAt = (paid + 10 * DAY) * 1000;
  const input = { productId: product, email: "ana@example.com", reference: "cs_test_after0001", pi: "pi_after0001", rating: 5, text: "Clear and kind lessons.", name: "Ana", paidAt: paid };
  const first = await saveReview(statsId, input, ROOM, writtenAt);
  is("written", first.state, "created");
  const id = reviewId(statsId, product, "ana@example.com");
  is("the order's time is kept", (await readReview(statsId, product, id))?.paidAt, paid);
  await saveReview(statsId, { ...input, text: "Clear and kind lessons, edited.", paidAt: paid + 5 }, ROOM, writtenAt + DAY * 1000);
  is("an edit of the same order keeps the first time", (await readReview(statsId, product, id))?.paidAt, paid);
  await saveReview(statsId, { ...input, email: "ben@example.com", paidAt: 0 }, ROOM, writtenAt);
  is("an order with no known time keeps none", (await readReview(statsId, product, reviewId(statsId, product, "ben@example.com")))?.paidAt, undefined);
  is("a review stored before reads with none", parseReview(JSON.stringify({ id: "a".repeat(24), productId: product, rating: 4, text: "Old.", name: "", createdAt: 1, editedAt: 0 }))?.paidAt, undefined);

  part("The list says it, and says nothing when unknown");
  const kept = (await readReview(statsId, product, id))!;
  const shown = renderToStaticMarkup(createElement(ReviewItem, { review: kept, storeName: "Review After Purchase", lang: "en" }));
  is("ten days after: said in days", shown.includes("Written 10 days after purchase"), true);
  const old = renderToStaticMarkup(createElement(ReviewItem, { review: { ...kept, paidAt: undefined }, storeName: "Review After Purchase", lang: "en" }));
  is("a review from before: no sentence", old.includes("after purchase"), false);

  done();
}

void main();
