/**
 * 285 [SX1], unit 1: a short, optional satisfaction survey when a student
 * finishes a course, as pure rules (lib/course-survey-rules.ts). The exact
 * public question, a score 0 to 10 and an optional comment; the creator sees
 * the average, the spread and the comments of their own students only. Asked
 * by email only with news consent exactly "yes", once per student per
 * course. Asking for a public review never depends on the score. Nothing is
 * wired yet.
 */
import {
  MAX_SURVEY_COMMENT,
  REVIEW_ASK_DEPENDS_ON_SCORE,
  SURVEY_QUESTION,
  mayEmailSurvey,
  readKeptAnswer,
  readScore,
  readSurveyComment,
  surveyOnceName,
  surveySummary,
} from "@/lib/course-survey-rules";
import { done, is, part } from "./check";

part("The question, word for word");
is("exact", SURVEY_QUESTION, "How likely are you to recommend this course to a friend?");

part("A score is a whole number from 0 to 10");
for (const ok of [0, 5, 10]) is(`${ok}`, readScore(ok), ok);
is("as text from a form", readScore("9"), 9);
is("10 as text", readScore("10"), 10);
for (const bad of [11, -1, 7.5, "ten", "", null, undefined, "010"]) is(`refused: ${JSON.stringify(bad)}`, readScore(bad), null);

part("A comment is optional, short and plain");
is("none", readSurveyComment(undefined), "");
is("trimmed", readSurveyComment("  Great pace.  "), "Great pace.");
is("a control character", readSurveyComment("x\u0000y"), null);
is(`longer than ${MAX_SURVEY_COMMENT} is refused, never cut`, readSurveyComment("a".repeat(MAX_SURVEY_COMMENT + 1)), null);

part("A kept answer is read whole or not at all");
is("whole", readKeptAnswer(JSON.stringify({ s: 9, c: "Great", at: 5 })), { score: 9, comment: "Great", at: 5 });
for (const [label, raw] of [
  ["a score out of range", JSON.stringify({ s: 11, c: "", at: 5 })],
  ["an extra field", JSON.stringify({ s: 9, c: "", at: 5, email: "x@example.com" })],
  ["no time", JSON.stringify({ s: 9, c: "" })],
  ["not JSON", "nine"],
] as const) is(`unreadable: ${label}`, readKeptAnswer(raw), null);

part("The creator's summary");
const summary = surveySummary([
  JSON.stringify({ s: 10, c: "Loved it", at: 1 }),
  JSON.stringify({ s: 9, c: "", at: 2 }),
  JSON.stringify({ s: 3, c: "Too long", at: 3 }),
  "garbage",
]);
is("how many, and the unreadable left out and counted", [summary.count, summary.unreadable], [3, 1]);
is("the average, one decimal", summary.average, 7.3);
is("the spread, 0 to 10", summary.spread, [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1]);
is("comments newest first, with their score", summary.comments, [{ score: 3, comment: "Too long" }, { score: 10, comment: "Loved it" }]);
is("no answers: no average, never zero", surveySummary([]).average, null);

part("Asked by email only with consent, once per student per course");
is("yes", mayEmailSurvey("yes"), true);
for (const other of ["no", "YES", "", null, undefined, true]) is(`not: ${JSON.stringify(other)}`, mayEmailSurvey(other), false);
const once = surveyOnceName("st_1", "course_1", "contact-hash-a");
is("the same student and course: the same name", once, surveyOnceName("st_1", "course_1", "contact-hash-a"));
is("another course: another name", once === surveyOnceName("st_1", "course_2", "contact-hash-a"), false);
is("never an address", once !== null && /@/.test(once), false);
is("an unreadable part: no name", surveyOnceName("st_1", "course_1", "a@b.c"), null);

part("Asking for a public review never depends on the score");
is("independent", REVIEW_ASK_DEPENDS_ON_SCORE, false);
done();
