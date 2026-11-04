/**
 * 636 [GL4](d), unit 1: the rules of the AI summary of a product's reviews
 * (lib/review-ai-summary-rules.ts). Only the words a page shows, never
 * chosen by stars; the model only sorts, a theme kept only when two reviews
 * say it, its name held to no facts; at most once a week.
 */
import { readFileSync } from "node:fs";
import type { Review } from "@/lib/review-summary";
import { MAX_SUMMARY_THEMES, MIN_SUMMARY_REVIEWS, SUMMARY_REFRESH_SECONDS, cleanReviewText, inputsStillShown, maySummarise, readThemes, summaryInputs, summaryLine } from "@/lib/review-ai-summary-rules";
import { done, is, part } from "./check";

const review = (n: number, over: Partial<Review> = {}): Review => ({ id: String(n).padStart(24, "0"), productId: "p1", reference: "", pi: "", rating: 5, text: `Words ${n}`, name: "", createdAt: n, hidden: false, hiddenReason: null, refunded: false, ...over }) as Review;

part("What is read");
const inputs = summaryInputs([review(1, { rating: 1 }), review(2, { hidden: true }), review(3, { refunded: true }), review(4, { productId: "p2" }), review(5, { text: "  " }), review(6, { rating: 3, text: "Write me at ana@example.com" })], "p1");
is("only what the page shows of this product, newest first, numbered, with each review's own id", inputs, [{ id: 1, text: "Write me at [email]", review: review(6).id }, { id: 2, text: "Words 1", review: review(1).id }]);
is("a one-star review is read as a five-star one", summaryInputs([review(1, { rating: 1 }), review(2, { rating: 5 })], "p1").length, 2);
is("addresses, links and phone numbers taken out", cleanReviewText("See www.example.com or call " + "+" + "1 555 010 2030"), "See [link] or call [number]");
is("a web address with neither http nor www is taken out too", [cleanReviewText("More at janesmith.dev"), cleanReviewText("my shop: shop.jane-smith.co.uk/pots?x=1 thanks"), cleanReviewText("Visit JaneSmith.DEV")], ["More at [link]", "my shop: [link] thanks", "Visit [link]"]);
is("but a price, a rating or an abbreviation is kept", cleanReviewText("Worth $4.50, 4.5 stars, e.g. the glaze part"), "Worth $4.50, 4.5 stars, e.g. the glaze part");
is("the source never chooses by stars", !/rating\s*[<>=]/.test(readFileSync("lib/review-ai-summary-rules.ts", "utf8")), true);

part("When");
const five = Array.from({ length: MIN_SUMMARY_REVIEWS }, (_, i) => ({ id: i + 1, text: "t" }));
is("enough reviews, never made: may", maySummarise(five, 0, 1_000_000), true);
is("too few: may not", maySummarise(five.slice(1), 0, 1_000_000), false);
is("at most once a week", [maySummarise(five, 1_000_000, 1_000_000 + SUMMARY_REFRESH_SECONDS - 1), maySummarise(five, 1_000_000, 1_000_000 + SUMMARY_REFRESH_SECONDS)], [false, true]);

part("The model only sorts");
// What each review sent said: a theme's name has to be in the words of the reviews it names.
const said = ["Clear lessons and nice extras", "Clear lessons", "The lessons are clear", "Easy to follow", "Friendly teacher, clear lessons", "A friendly teacher", "Good pace", "Good pace, nice extras"];
const sent = said.map((text, i) => ({ id: i + 1, text }));
const themes = readThemes({ themes: [
  { title: "Clear lessons", reviews: [1, 2, 3] },
  { title: "Easy to follow", reviews: [4, 4] },
  { title: "Worth 5 stars", reviews: [1, 2] },
  { title: "Get 20% off", reviews: [1, 2] },
  { title: "See www.example.com", reviews: [1, 2] },
  { title: "clear lessons", reviews: [5, 6] },
  { title: "Friendly teacher", reviews: [5, 6, 99] },
  { title: "x".repeat(41), reviews: [1, 2] },
  { title: "Good pace", reviews: [7, 8] },
  { title: "Nice extras", reviews: [1, 8] },
] }, sent);
is("kept only when two different reviews sent say it, the name held to no facts, once", themes, [{ title: "Clear lessons", reviews: 3 }, { title: "Friendly teacher", reviews: 2 }, { title: "Good pace", reviews: 2 }, { title: "Nice extras", reviews: 2 }]);
is("at most a few", themes.length <= MAX_SUMMARY_THEMES, true);
is("an answer that is not one keeps nothing", [readThemes(null, sent), readThemes({ themes: "x" }, sent)], [[], []]);

part("As a page says it");
is("each theme with how many of the reviews read say it", summaryLine(themes.slice(0, 2), 8), "Reviewers often mention: clear lessons (3 of 8); friendly teacher (2 of 8).");
is("nothing to say, nothing said", summaryLine([], 8), "");

part("Edge tests of 4 November 2026: what a theme's name may say");
const named = (title: string, reviews = [1, 2]) => readThemes({ themes: [{ title, reviews }] }, sent).length === 1;
is("a name the reviews do not say is not shown", ["Lifetime access included", "Best course on the market", "Top rated by experts"].filter((t) => named(t)), []);
is("numbers in words and ratings are not shown", ["Ten out of ten", "Five stars from everyone"].filter((t) => named(t)), []);
is("an address, a link, a handle or markup is not shown", ["jane@shop.com is helpful", "Visit janesmith.dev", "Thanks @janesmith", "<img src=x>"].filter((t) => named(t)), []);
is("a name of hidden characters only, or not in plain English letters, is not shown", [named("\u200b\u200b"), named("Aulas muito claras é")], [false, false]);
is("a name the reviews do say is", named("Clear lessons", [1, 2]), true);

part("Edge tests: what a review sends");
is("short phone numbers, other digits and handles are taken out", [cleanReviewText("Call 555-1234"), cleanReviewText("Call \u0669\u0666\u0666 \u0665\u0660 \u0661\u0662\u0663 \u0664\u0665\u0666\u0667"), cleanReviewText("Thanks @janesmith!")], ["Call [number]", "Call [number]", "Thanks [handle]!"]);
is("an address written out is taken out", cleanReviewText("write jane at gmail dot com"), "write [email]");
is("cut at whole characters, never inside an emoji", Array.from(cleanReviewText(`${"a".repeat(299)}\u{1F600}more`)).length, 300);
part("Still shown when kept (review of 4 November 2026)");
{
  const sent = summaryInputs([review(1), review(2), review(3, { text: "Same words" }), review(4, { text: "Same words" })], "p1");
  is("a review written since: still kept", inputsStillShown(sent, [review(1), review(2), review(3, { text: "Same words" }), review(4, { text: "Same words" }), review(9, { text: "New words" })], "p1"), true);
  is("a review deleted: not kept", inputsStillShown(sent, [review(1), review(3, { text: "Same words" }), review(4, { text: "Same words" })], "p1"), false);
  is("hidden or refunded: not kept", [inputsStillShown(sent, [review(1), review(2, { hidden: true }), review(3, { text: "Same words" }), review(4, { text: "Same words" })], "p1"), inputsStillShown(sent, [review(1, { refunded: true }), review(2), review(3, { text: "Same words" }), review(4, { text: "Same words" })], "p1")], [false, false]);
  is("rewritten: not kept", inputsStillShown(sent, [review(1, { text: "Other words" }), review(2), review(3, { text: "Same words" }), review(4, { text: "Same words" })], "p1"), false);
  is("two reviews with the same words count as two: one gone is not kept", inputsStillShown(sent, [review(1), review(2), review(3, { text: "Same words" })], "p1"), false);
}

done();
