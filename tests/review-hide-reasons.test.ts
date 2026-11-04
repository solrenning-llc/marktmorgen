/**
 * 567 [GD1] (e): a creator hides a review only for one of the fixed review
 * rules, the same for every rating, and the reason is kept with the review
 * (lib/review-summary.ts HIDE_REASONS, lib/reviews.ts setHidden). Low stars or
 * criticism are never a reason. Hiding never takes stars out of the average,
 * and the stars stay on the page when every review is hidden.
 *
 * What fails here:
 *   - a review hidden with no reason, or with a reason not on the list;
 *   - a reason about stars, criticism or how negative a review is;
 *   - a rule that treats a low-rated review differently from a high-rated one;
 *   - the reason lost when the review is read again, or kept after it is shown again;
 *   - the stars or the sales page's rating fact gone when every review is hidden;
 *   - the reason lost when the buyer edits, or a review hidden before reasons
 *     were kept left with no way to name one;
 *   - the studio offering a hide without the reasons, or the API taking one.
 */
import { readFileSync } from "node:fs";
import { HIDE_REASONS, isHideReason, showsRating } from "@/lib/review-summary";
import { parseReview, saveReview, setHidden, summaryOf } from "@/lib/reviews";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { pageFacts } from "@/lib/page-facts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

async function main(): Promise<void> {
  part("The reasons: the review rules, never the stars");
  is("five fixed reasons", HIDE_REASONS.map((r) => r.id), ["private", "abusive", "unrelated", "false", "unlawful"]);
  is("none is about stars, criticism or being negative", HIDE_REASONS.filter((r) => /star|rating|negative|criticis|complain|bad review|low/i.test(`${r.label} ${r.hint}`)).map((r) => r.id), []);
  is("each has words the creator can read", HIDE_REASONS.every((r) => r.label.length > 5 && r.hint.length > 20), true);
  is("only a listed reason counts", [isHideReason("abusive"), isHideReason("low rating"), isHideReason(""), isHideReason(undefined)], [true, false, false, false]);

  part("Hiding needs a reason, the same for any rating");
  redis.clear();
  const owner = "hide@example.com";
  await claimHandle(owner, "hideshop", "Hide Shop", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const made = await addProduct(owner, "Bread Book", "", "19", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  const review = async (n: number, rating: number) => {
    const saved = await saveReview(statsId, { productId: product, email: `h${n}@example.com`, reference: `cs_test_h${n}`, pi: `pi_h${n}`, rating, text: `Review number ${n}, with enough words to show.`, name: `Reader ${n}` }, ROOM, Date.now() - n * 1000);
    if (saved.state !== "created") throw new Error(`review ${n}: ${saved.state}`);
    return saved.review.id;
  };
  const low = await review(1, 1);
  const high = await review(2, 5);
  const raw = async (id: string) => parseReview((await redis.pipeline([["HGET", `nl:rev:${statsId}:${product}`, id]]))[0]);
  is("no reason: refused, not hidden", [await setHidden(statsId, product, low, true), (await raw(low))?.hidden], [null, false]);
  is("a reason not on the list: refused", [await setHidden(statsId, product, low, true, "one star" as never), (await raw(low))?.hidden], [null, false]);
  const hidLow = await setHidden(statsId, product, low, true, "abusive");
  const hidHigh = await setHidden(statsId, product, high, true, "abusive");
  is("the same reason hides a one-star and a five-star review alike", [typeof hidLow === "object" && hidLow?.hidden, typeof hidHigh === "object" && hidHigh?.hidden], [true, true]);
  is("the reason is kept with the review", [(await raw(low))?.hiddenReason, (await raw(high))?.hiddenReason], ["abusive", "abusive"]);
  const all = await summaryOf(statsId, product);
  is("both hidden: still in the average and the count", [all.count, all.hidden, all.visible], [2, 2, 0]);
  is("and the stars stay on the page", showsRating(all), true);
  await setHidden(statsId, product, high, false);
  is("shown again: no reason kept", [(await raw(high))?.hidden, (await raw(high))?.hiddenReason], [false, null]);
  is("a stored reason that is not on the list is read as none", parseReview(JSON.stringify({ ...(await raw(low)), hiddenReason: "low" }))?.hiddenReason, null);

  part("A buyer's own edit, a review hidden before reasons were kept, and the page's rating fact");
  const edited = await saveReview(statsId, { productId: product, email: "h1@example.com", reference: "cs_test_h1", pi: "pi_h1", rating: 2, text: "Changed my words, with enough of them to show.", name: "Reader 1" }, ROOM, Date.now());
  is("the buyer changes their review: it stays hidden, for the same rule", [edited.state, (await raw(low))?.hidden, (await raw(low))?.hiddenReason], ["updated", true, "abusive"]);
  const legacy = { ...(await raw(high))!, hidden: true } as Record<string, unknown>;
  delete legacy.hiddenReason;
  await redis.pipeline([["HSET", `nl:rev:${statsId}:${product}`, high, JSON.stringify(legacy)]]);
  is("hidden before reasons were kept: read as hidden, with no reason", [(await raw(high))?.hidden, (await raw(high))?.hiddenReason], [true, null]);
  is("the creator can name the rule without showing it first", [typeof (await setHidden(statsId, product, high, true, "private")), (await raw(high))?.hiddenReason, (await raw(high))?.hidden], ["object", "private", true]);
  const facts = pageFacts({ language: "en", locale: "en-US", product: {}, bundleItems: null, sold: null, reviews: { count: 2, stars: 3, visible: 0 } });
  is("every review hidden: the sales page's rating fact stays", facts.rating?.value, "1.5");
  is("no review that counts: no rating fact", pageFacts({ language: "en", locale: "en-US", product: {}, bundleItems: null, sold: null, reviews: { count: 0, stars: 0, visible: 0 } }).rating, undefined);

  part("No reviews, or only refunded ones: no stars");
  is("nothing counted, nothing shown", showsRating({ count: 0, stars: 0, visible: 0, hidden: 0, refunded: 0, dist: [0, 0, 0, 0, 0] }), false);

  part("The studio and the API");
  const route = readFileSync("app/api/store/reviews/route.ts", "utf8");
  is("the API passes the reason it was sent, and nothing else decides it", /setHidden\(statsId, productId, id, body\.hidden === true, body\.reason\)/.test(route), true);
  const studio = readFileSync("components/review-studio.tsx", "utf8");
  is("the studio asks for the reason from the same list, and says low stars are not one", [/HIDE_REASONS/.test(studio), /low star rating or criticism is not a reason/i.test(studio)], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
