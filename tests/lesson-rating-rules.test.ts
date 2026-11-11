/**
 * 296 [SQ7], unit 1: a quick rating of each lesson, as pure rules
 * (lib/lesson-rating-rules.ts). A student may rate a lesson 1 to 5, with an
 * optional short comment, once per lesson, and change it. The creator sees,
 * per lesson, the average, the spread of the ratings and the comments; no
 * rating is ever shown to other students or as social proof. Anything that
 * cannot be read is not counted. Nothing is wired yet.
 */
import { MAX_RATING_COMMENT, RATING_PUBLIC, readComment, readRating, readKeptRating, ratingSummary } from "@/lib/lesson-rating-rules";
import { done, is, part } from "./check";

part("A rating is a whole number from 1 to 5");
for (const ok of [1, 2, 3, 4, 5]) is(`${ok}`, readRating(ok), ok);
is("as text from a form", readRating("4"), 4);
for (const bad of [0, 6, 3.5, -1, "five", "", null, undefined, {}]) is(`refused: ${JSON.stringify(bad)}`, readRating(bad), null);

part("A comment is optional, short and plain");
is("none", readComment(undefined), "");
is("empty", readComment("   "), "");
is("trimmed", readComment("  Clear and short.  "), "Clear and short.");
is("line breaks kept, other control characters refused", readComment("Line one\nLine two"), "Line one\nLine two");
is("a control character", readComment("bad\u0007bell"), null);
is(`at most ${MAX_RATING_COMMENT} characters`, readComment("a".repeat(MAX_RATING_COMMENT)), "a".repeat(MAX_RATING_COMMENT));
is("longer is refused, never cut", readComment("a".repeat(MAX_RATING_COMMENT + 1)), null);
is("not text", readComment(42), null);

part("A kept rating is read whole or not at all");
is("whole", readKeptRating(JSON.stringify({ r: 4, c: "Good", at: 1_700_000_000 })), { rating: 4, comment: "Good", at: 1_700_000_000 });
is("no comment", readKeptRating(JSON.stringify({ r: 2, c: "", at: 1_700_000_000 })), { rating: 2, comment: "", at: 1_700_000_000 });
for (const [label, raw] of [
  ["not JSON", "4"],
  ["a rating out of range", JSON.stringify({ r: 9, c: "", at: 1 })],
  ["no time", JSON.stringify({ r: 4, c: "" })],
  ["an extra field", JSON.stringify({ r: 4, c: "", at: 1, who: "x@example.com" })],
  ["a comment too long", JSON.stringify({ r: 4, c: "a".repeat(MAX_RATING_COMMENT + 1), at: 1 })],
  ["a number", 4],
] as const) is(`unreadable: ${label}`, readKeptRating(raw), null);

part("The creator's summary of a lesson");
const kept = [
  JSON.stringify({ r: 5, c: "Loved it", at: 1 }),
  JSON.stringify({ r: 4, c: "", at: 2 }),
  JSON.stringify({ r: 4, c: "Too fast", at: 3 }),
  JSON.stringify({ r: 1, c: "", at: 4 }),
];
const summary = ratingSummary(kept);
is("how many", summary.count, 4);
is("the average, one decimal", summary.average, 3.5);
is("the spread, 1 to 5", summary.spread, [1, 0, 0, 2, 1]);
is("the comments, newest first, with their rating", summary.comments, [{ rating: 4, comment: "Too fast" }, { rating: 5, comment: "Loved it" }]);
is("complete", summary.unreadable, 0);
const odd = ratingSummary([...kept, "garbage", JSON.stringify({ r: 7, c: "", at: 5 })]);
is("unreadable ones are not counted, and said", [odd.count, odd.unreadable, odd.average], [4, 2, 3.5]);
const none = ratingSummary([]);
is("no ratings: no average, never zero", [none.count, none.average], [0, null]);

part("Never public");
is("ratings are never social proof or shown to other students", RATING_PUBLIC, false);
done();
