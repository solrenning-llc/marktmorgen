/**
 * The rules of a lesson's quick rating (296 [SQ7], unit 1;
 * lib/lesson-rating-rules.ts; added 12 November 2026), with synthetic
 * ratings only:
 *
 *   - only a whole score from 1 to 5 is a rating; the comment is optional,
 *     cleaned like any student's text, cut, and made well formed;
 *   - a student's newer rating replaces the older one;
 *   - the creator's summary: the count, the average to one decimal, the
 *     spread, the comments newest first with nothing about who wrote them,
 *     and how many more there are;
 *   - the bytes one rating takes, measured on the worst comments that can be
 *     kept, never pass ratingRecordMaxBytes.
 */
import { RATING_COMMENTS_SHOWN, RATING_COMMENT_MAX, type LessonRating, cleanRating, latestPerStudent, ratingRecordMaxBytes, ratingSummary } from "@/lib/lesson-rating-rules";
import { done, is, part } from "./check";

part("What a rating is");
{
  is("a whole score from 1 to 5, as a number or a form's text", [cleanRating(1, ""), cleanRating("5", " ")], [{ score: 1, comment: "" }, { score: 5, comment: "" }]);
  is("anything else is not a rating", [0, 6, 2.5, "3.0", "", null, "five", Number.NaN, [3]].map((s) => cleanRating(s, "")), [null, null, null, null, null, null, null, null, null]);
  is("the comment cleaned like any student's text", cleanRating(4, "  Great​ lesson\r\n\r\n\r\nthanks  ")?.comment, "Great lesson\n\nthanks");
  is(`and cut at ${RATING_COMMENT_MAX}`, cleanRating(3, "x".repeat(RATING_COMMENT_MAX + 50))?.comment.length, RATING_COMMENT_MAX);
  is("a lone half of a surrogate pair is not kept as such", cleanRating(3, "ok \ud800")?.comment, "ok �");
  is("a comment that is not text is no comment", cleanRating(2, { evil: true })?.comment, "");
}

part("One per student, the latest");
{
  const r = (who: string, score: number, at: number, comment = ""): LessonRating => ({ who, score, comment, at });
  is("a newer rating replaces the older", latestPerStudent([r("a", 2, 10), r("b", 4, 11), r("a", 5, 12)]).map((x) => [x.who, x.score]), [["a", 5], ["b", 4]]);
  is("the same second: the one read last stands", latestPerStudent([r("a", 2, 10), r("a", 3, 10)])[0].score, 3);
}

part("What the creator is shown");
{
  const r = (who: string, score: number, at: number, comment = ""): LessonRating => ({ who, score, comment, at });
  const empty = ratingSummary([]);
  is("no rating: nothing to average", [empty.count, empty.average, empty.spread, empty.comments, empty.moreComments], [0, null, [0, 0, 0, 0, 0], [], 0]);
  const s = ratingSummary([r("a", 5, 1, "Loved it"), r("b", 4, 2), r("c", 4, 3, "Too fast"), r("a", 3, 4, "Changed my mind"), r("d", 9, 5)]);
  is("the latest of each student; a score out of range is not counted", [s.count, s.average, s.spread], [3, 3.7, [0, 0, 1, 2, 0]]);
  is("comments newest first, with no one's key", s.comments, [{ score: 3, comment: "Changed my mind", at: 4 }, { score: 4, comment: "Too fast", at: 3 }]);
  const many = ratingSummary(Array.from({ length: RATING_COMMENTS_SHOWN + 7 }, (_, i) => r(`s${i}`, 5, i, `c${i}`)));
  is(`at most ${RATING_COMMENTS_SHOWN} comments, the rest counted`, [many.comments.length, many.moreComments, many.comments[0].comment], [RATING_COMMENTS_SHOWN, 7, `c${RATING_COMMENTS_SHOWN + 6}`]);
  is("the average to one decimal", ratingSummary([r("a", 5, 1), r("b", 4, 1), r("c", 4, 1)]).average, 4.3);
}

part("The most one rating takes to keep");
{
  const WHO = 32;
  const max = ratingRecordMaxBytes(WHO);
  const bytes = (comment: string) => new TextEncoder().encode(JSON.stringify({ who: "w".repeat(WHO), score: 5, comment, at: 9_999_999_999 })).length;
  const worst = ["€", '"', "\\", "😀", "\n", "a", " ", "\ud800"].map((ch) => cleanRating(5, ch.repeat(RATING_COMMENT_MAX))?.comment ?? "");
  is("every worst comment, cleaned, fits", worst.filter((c) => bytes(c) > max).map((c) => c.slice(0, 2)), []);
  is("and the bound is tight: a three-byte character fills it", bytes(worst[0]) === max, true);
}

done();
