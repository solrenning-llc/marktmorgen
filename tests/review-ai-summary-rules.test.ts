/**
 * 636 [GL4](d), unit 1: the rules of the AI summary of a product's reviews
 * (lib/review-ai-summary-rules.ts). Only the words a page shows, never
 * chosen by stars; the model only sorts, a theme kept only when two reviews
 * say it, its name held to no facts; at most once a week.
 */
import { readFileSync } from "node:fs";
import type { Review } from "@/lib/review-summary";
import { MAX_SUMMARY_THEMES, MIN_SUMMARY_REVIEWS, SUMMARY_REFRESH_SECONDS, cleanReviewText, maySummarise, readThemes, summaryInputs, summaryLine } from "@/lib/review-ai-summary-rules";
import { done, is, part } from "./check";

const review = (n: number, over: Partial<Review> = {}): Review => ({ id: String(n).padStart(24, "0"), productId: "p1", reference: "", pi: "", rating: 5, text: `Words ${n}`, name: "", createdAt: n, hidden: false, hiddenReason: null, refunded: false, ...over }) as Review;

part("What is read");
const inputs = summaryInputs([review(1, { rating: 1 }), review(2, { hidden: true }), review(3, { refunded: true }), review(4, { productId: "p2" }), review(5, { text: "  " }), review(6, { rating: 3, text: "Write me at ana@example.com" })], "p1");
is("only what the page shows of this product, newest first, numbered", inputs, [{ id: 1, text: "Write me at [email]" }, { id: 2, text: "Words 1" }]);
is("a one-star review is read as a five-star one", summaryInputs([review(1, { rating: 1 }), review(2, { rating: 5 })], "p1").length, 2);
is("addresses, links and phone numbers taken out", cleanReviewText("See www.example.com or call " + "+" + "1 555 010 2030"), "See [link] or call [number]");
is("the source never chooses by stars", !/rating\s*[<>=]/.test(readFileSync("lib/review-ai-summary-rules.ts", "utf8")), true);

part("When");
const five = Array.from({ length: MIN_SUMMARY_REVIEWS }, (_, i) => ({ id: i + 1, text: "t" }));
is("enough reviews, never made: may", maySummarise(five, 0, 1_000_000), true);
is("too few: may not", maySummarise(five.slice(1), 0, 1_000_000), false);
is("at most once a week", [maySummarise(five, 1_000_000, 1_000_000 + SUMMARY_REFRESH_SECONDS - 1), maySummarise(five, 1_000_000, 1_000_000 + SUMMARY_REFRESH_SECONDS)], [false, true]);

part("The model only sorts");
const sent = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: "t" }));
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

done();
