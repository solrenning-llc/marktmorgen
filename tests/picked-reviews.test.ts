/**
 * Reviews the creator picks to show first (lib/sales-page.ts, ReviewsBlock;
 * lib/reviews.ts, visibleReviews; added 8 October 2026). Kajabi and Hotmart
 * let a creator type testimonials, which nobody can tell from real ones; here
 * a creator can only choose among reviews buyers who paid wrote. Checked:
 *
 *   - a page keeps up to three picks, each a review id, once;
 *   - the picked ones come first, in the creator's order, then the newest,
 *     read in the same request, and the page still holds as many as before;
 *   - a hidden or refunded review is never put first, and a pick that no
 *     longer exists is passed over;
 *   - the review is marked as picked in every language a store can be in.
 */
import { readFileSync } from "node:fs";
import { MAX_PICKED_REVIEWS, parsePage } from "@/lib/sales-page";
import { markOneRefunded, saveReview, setHidden, visibleReviews } from "@/lib/reviews";
import { wordsIn } from "@/lib/buyer-words";
import { REVIEW_ID_PATTERN } from "@/lib/review-summary";
import { LANGUAGES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const STATS = "c".repeat(32);
const PRODUCT = "knife00001";

async function main(): Promise<void> {
  redis.clear();

  part("What a page keeps");
  const id = (n: number) => String(n).padStart(24, "a");
  const block = (first: unknown) => parsePage({ blocks: [{ id: "revw0001", kind: "reviews", heading: "Reviews", first }] }).blocks[0];
  is("up to three, once each", block([id(1), id(2), id(1), id(3), id(4)]).kind === "reviews" ? (block([id(1), id(2), id(1), id(3), id(4)]) as { first: string[] }).first : null, [id(1), id(2), id(3)]);
  is(`the most is ${MAX_PICKED_REVIEWS}`, MAX_PICKED_REVIEWS, 3);
  is("a review id is read the same way as the reviews read it", /const REVIEW_ID_PATTERN = \/\^\[0-9a-f\]\{24\}\$\/;/.test(readFileSync("lib/sales-page.ts", "utf8")) && String(REVIEW_ID_PATTERN) === "/^[0-9a-f]{24}$/", true);
  is("and the page's file imports nothing, for next.config.ts", /^import /m.test(readFileSync("lib/sales-page.ts", "utf8")), false);
  is("only review ids", (block(["x", 7, id(5), "../a"]) as { first: string[] }).first, [id(5)]);
  is("an older page has none", (parsePage({ blocks: [{ id: "revw0001", kind: "reviews", heading: "" }] }).blocks[0] as { first: string[] }).first, []);

  part("Shown first, then the newest");
  const ids: string[] = [];
  for (let n = 1; n <= 6; n += 1) {
    const saved = await saveReview(STATS, { productId: PRODUCT, email: `buyer${n}@example.com`, reference: `cs_test_${n}`, pi: `pi_${n}`, rating: n % 5 + 1, text: `Review ${n}`, name: `Buyer ${n}` }, ROOM, 1_700_000_000_000 + n * 1000);
    if (saved.state === "created") ids.push(saved.review.id);
  }
  is("six reviews written", ids.length, 6);
  const newest = (await visibleReviews(STATS, PRODUCT, 0, 4)).map((r) => r.text);
  is("without picks, the newest", newest, ["Review 6", "Review 5", "Review 4", "Review 3"]);
  const picked = (await visibleReviews(STATS, PRODUCT, 0, 4, [ids[0], ids[2]])).map((r) => r.text);
  is("picked ones first, in the order picked, then the newest, as many as before", picked, ["Review 1", "Review 3", "Review 6", "Review 5"]);
  const real = redis.pipeline;
  let trips = 0;
  redis.pipeline = (commands) => {
    trips += 1;
    return real(commands);
  };
  await visibleReviews(STATS, PRODUCT, 0, 4, [ids[0]]);
  redis.pipeline = real;
  is("in the same two requests as without picks", trips, 2);
  is("a later page of reviews ignores picks", (await visibleReviews(STATS, PRODUCT, 4, 4, [ids[0]])).map((r) => r.text), ["Review 2", "Review 1"]);

  part("Never a hidden or refunded one");
  await setHidden(STATS, PRODUCT, ids[0], true, "abusive");
  await markOneRefunded(STATS, PRODUCT, ids[1]);
  const after = (await visibleReviews(STATS, PRODUCT, 0, 3, [ids[0], ids[1], "f".repeat(24)])).map((r) => r.text);
  is("hidden, refunded and missing picks are passed over", after, ["Review 6", "Review 5", "Review 4"]);

  part("Said in every language");
  const all = Object.values(LANGUAGES);
  const missing = all.filter((l) => !wordsIn(l.code).pickedByCreator);
  is("every language says it", missing.map((l) => l.code), []);
  const words = new Set(all.map((l) => wordsIn(l.code).pickedByCreator));
  is("in its own words", words.size, all.length);
  const page = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("the product page asks for the picks", /visibleReviews\(store\.statsId, product\.id, 0, REVIEWS_ON_PAGE, pickedFirst\)/.test(page), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
