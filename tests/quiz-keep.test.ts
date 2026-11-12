/**
 * A quiz's answers kept in the student's own browser (297 [SQ8];
 * lib/quiz-keep-rules.ts, components/quiz-keep.tsx; added 12 November 2026).
 * The rules with synthetic drafts, and the real quiz drawn on the server:
 *
 *   - the draft holds every question of the try, answered or not, and only
 *     the quiz's own choices, never a hidden field;
 *   - it is put back only for exactly the same questions, when readable, not
 *     older than 30 days, not from the future and not empty;
 *   - putting it back sets each question it names and leaves the others;
 *   - the quiz offers the keeping only while the student may answer, never
 *     to the owner or a visitor, nor after passing or with no tries left;
 *   - every buyer language says it, and the privacy policy and the personal
 *     data register say where it is kept.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QUIZ_KEEP_DAYS, checkedAfter, draftOf, draftToRestore, hasAnswers, quizKeepKey } from "@/lib/quiz-keep-rules";
import { LessonQuiz } from "@/components/lesson-quiz";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { PERSON_DATA } from "@/lib/person-data";
import type { Quiz } from "@/lib/quiz";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 12);
const shown = "aaaaaaaaaaa1,aaaaaaaaaaa2";
const inputs = [
  { name: "q_aaaaaaaaaaa1", value: "0", checked: false },
  { name: "q_aaaaaaaaaaa1", value: "1", checked: true },
  { name: "q_aaaaaaaaaaa2", value: "0", checked: false },
  { name: "q_aaaaaaaaaaa2", value: "1", checked: false },
  { name: "handle", value: "store", checked: false },
  { name: "q_aaaaaaaaaaa2", value: "x", checked: true },
];

part("What is kept");
{
  const draft = draftOf(inputs, shown, NOW);
  is("every question of the try, answered or not; never a hidden field or a value that is not a choice", draft, { at: NOW, shown, answers: { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] } });
  is("worth keeping only with an answer", [hasAnswers(draft), hasAnswers(draftOf(inputs.map((i) => ({ ...i, checked: false })), shown, NOW))], [true, false]);
  is("kept per store, course and lesson", quizKeepKey("shop", "prod", "lesson"), "mm:quiz:shop:prod:lesson");
}

part("When it is put back");
{
  const kept = JSON.stringify(draftOf(inputs, shown, NOW - 3_600_000));
  is("the same questions, an hour later", draftToRestore(kept, shown, NOW)?.answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] });
  is("other questions (a bank drew again): never", draftToRestore(kept, "aaaaaaaaaaa3,aaaaaaaaaaa2", NOW), null);
  const old = JSON.stringify({ ...draftOf(inputs, shown, 0), at: NOW - (QUIZ_KEEP_DAYS * 86_400_000 + 1) });
  is(`older than ${QUIZ_KEEP_DAYS} days: never`, draftToRestore(old, shown, NOW), null);
  is("from the future: never", draftToRestore(JSON.stringify({ ...JSON.parse(kept), at: NOW + 60_000 }), shown, NOW), null);
  is("unreadable, empty or not a draft: never", [draftToRestore("{", shown, NOW), draftToRestore(null, shown, NOW), draftToRestore("[]", shown, NOW), draftToRestore(JSON.stringify({ at: NOW, shown, answers: { q_aaaaaaaaaaa1: [] } }), shown, NOW)], [null, null, null, null]);
  is("a choice that is not a small whole number: the whole draft is refused", draftToRestore(JSON.stringify({ at: NOW, shown, answers: { q_aaaaaaaaaaa1: [1.5] } }), shown, NOW), null);
  is("a field that is not a question: refused", draftToRestore(JSON.stringify({ at: NOW, shown, answers: { handle: [1] } }), shown, NOW), null);
}

part("Putting it back");
{
  const draft = { at: NOW, shown, answers: { q_aaaaaaaaaaa1: [0], q_aaaaaaaaaaa2: [] } };
  is("each named question as the draft says", inputs.slice(0, 4).map((i) => checkedAfter(i, draft)), [true, false, false, false]);
  is("a question the draft does not name keeps its state", checkedAfter({ name: "q_bbbbbbbbbbb1", value: "0", checked: true }, draft), true);
}

part("Offered only while the student may answer");
{
  const quiz: Quiz = {
    questions: [
      { id: "aaaaaaaaaaa1", text: "One?", kind: "single", choices: ["A", "B"], correct: [1], explanation: "" },
      { id: "aaaaaaaaaaa2", text: "Two?", kind: "multiple", choices: ["C", "D"], correct: [0, 1], explanation: "" },
    ],
    passPercent: 50,
    attempts: 3,
  } as unknown as Quiz;
  const draw = (mode: "student" | "owner" | "visitor", attempt: unknown = null) =>
    renderToStaticMarkup(createElement(LessonQuiz, { quiz, attempt: attempt as never, mode, action: "/api/store/course/quiz", hidden: { handle: "shop", product: "prod", lesson: "lessonaaaaa1" }, storeName: "Shop", justMarked: false }));
  is("a student who may answer", draw("student").includes("data-quiz-keep"), true);
  is("the owner, a visitor: no", [draw("owner").includes("data-quiz-keep"), draw("visitor").includes("data-quiz-keep")], [false, false]);
  is("before scripts run it draws nothing visible: the quiz is the plain form it was", /<span class="block" data-quiz-keep="true"><\/span>/.test(draw("student")), true);
}

part("Said in every language, and in the privacy policy");
{
  const keys = ["quizKeptBack", "quizKeptClear", "quizKeptCleared"] as const;
  for (const [lang, w] of Object.entries(COURSES_WORDS)) {
    is(`${lang}: three phrases`, keys.every((k) => typeof w[k] === "string" && w[k].length > 3), true);
    if (lang !== "en") is(`${lang}: not left in English`, keys.filter((k) => w[k] === COURSES_WORDS.en[k]), []);
  }
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy names the key and when it goes", /id="quiz-drafts"[\s\S]{0,1400}<code>mm:quiz:<\/code>[\s\S]{0,900}30\s+days/.test(privacy), true);
  is("and says the button the student presses", privacy.includes("&quot;Clear my answers&quot;") && COURSES_WORDS.en.quizKeptClear === "Clear my answers", true);
  is("the personal data register says it is never ours", PERSON_DATA.some((r) => r.file === "lib/quiz-keep-rules.ts" && r.how === "none" && r.what.includes("#quiz-drafts")), true);
}

done();
