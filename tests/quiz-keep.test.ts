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
import { deviceQuizKey } from "@/lib/quiz-keep-key";
import { devicePlaceKey } from "@/lib/lesson-position";
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
  const draft = draftOf(inputs, shown, 0, NOW);
  is("every question of the try, answered or not; never a hidden field or a value that is not a choice", draft, { at: NOW, shown, tries: 0, answers: { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] } });
  is("worth keeping only with an answer", [hasAnswers(draft), hasAnswers(draftOf(inputs.map((i) => ({ ...i, checked: false })), shown, 0, NOW))], [true, false]);
  is("kept per store, course, lesson and student", quizKeepKey("shop", "prod", "lesson", "abc"), "mm:quiz:shop:prod:lesson:abc");
}

part("When it is put back");
{
  const kept = JSON.stringify(draftOf(inputs, shown, 0, NOW - 3_600_000));
  is("the same questions, an hour later", draftToRestore(kept, shown, 0, NOW)?.answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] });
  is("other questions (a bank drew again): never", draftToRestore(kept, "aaaaaaaaaaa3,aaaaaaaaaaa2", 0, NOW), null);
  const old = JSON.stringify({ ...draftOf(inputs, shown, 0, 0), at: NOW - (QUIZ_KEEP_DAYS * 86_400_000 + 1) });
  is(`older than ${QUIZ_KEEP_DAYS} days: never`, draftToRestore(old, shown, 0, NOW), null);
  is("from the future: never", draftToRestore(JSON.stringify({ ...JSON.parse(kept), at: NOW + 60_000 }), shown, 0, NOW), null);
  is("unreadable, empty or not a draft: never", [draftToRestore("{", shown, 0, NOW), draftToRestore(null, shown, 0, NOW), draftToRestore("[]", shown, 0, NOW), draftToRestore(JSON.stringify({ at: NOW, shown, tries: 0, answers: { q_aaaaaaaaaaa1: [] } }), shown, 0, NOW)], [null, null, null, null]);
  is("a choice that is not a small whole number: the whole draft is refused", draftToRestore(JSON.stringify({ at: NOW, shown, tries: 0, answers: { q_aaaaaaaaaaa1: [1.5] } }), shown, 0, NOW), null);
  is("a send that was refused or never arrived (no try recorded): still put back", draftToRestore(kept, shown, 0, NOW) !== null, true);
  is("a try recorded since (the server's count went up): never, it was sent and counted", draftToRestore(kept, shown, 1, NOW), null);
  is("a draft from before this rule, with no count: never", draftToRestore(JSON.stringify({ ...JSON.parse(kept), tries: undefined }), shown, 0, NOW), null);
  is("a field that is not a question: refused", draftToRestore(JSON.stringify({ at: NOW, shown, tries: 0, answers: { handle: [1] } }), shown, 0, NOW), null);
}

part("One student's draft is never another's (review of #4324)");
{
  const keyBefore = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "k".repeat(64);
  try {
    const ada = deviceQuizKey("course1", "ada@example.com"), bo = deviceQuizKey("course1", "bo@example.com");
    is("a code per student, made on the server, the same each visit", [Boolean(ada && /^[0-9a-f]{32}$/.test(ada)), ada === deviceQuizKey("course1", " ADA@example.com "), ada !== bo], [true, true, true]);
    is("so the two students' drafts live under different keys", quizKeepKey("shop", "prod", "lesson", ada ?? "") !== quizKeepKey("shop", "prod", "lesson", bo ?? ""), true);
    is("never the address, nor the video place's code", [ada?.includes("ada"), ada === devicePlaceKey("course1", "ada@example.com"), ada === deviceQuizKey("course2", "ada@example.com")], [false, false, false]);
  } finally {
    if (keyBefore === undefined) delete process.env.NIMBUS_DATA_KEY;
    else process.env.NIMBUS_DATA_KEY = keyBefore;
  }
  const stripeBefore = process.env.STRIPE_SECRET_KEY;
  const dataBefore = process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  is("no server key: no code, so nothing is kept", deviceQuizKey("course1", "ada@example.com"), null);
  if (stripeBefore !== undefined) process.env.STRIPE_SECRET_KEY = stripeBefore;
  if (dataBefore !== undefined) process.env.NIMBUS_DATA_KEY = dataBefore;
}

part("Putting it back");
{
  const draft = { at: NOW, shown, tries: 0, answers: { q_aaaaaaaaaaa1: [0], q_aaaaaaaaaaa2: [] } };
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
    renderToStaticMarkup(createElement(LessonQuiz, { quiz, attempt: attempt as never, mode, action: "/api/store/course/quiz", hidden: { handle: "shop", product: "prod", lesson: "lessonaaaaa1" }, storeName: "Shop", justMarked: false, keeper }));
  let keeper: string | null = "c".repeat(32);
  is("a student who may answer", draw("student").includes("data-quiz-keep"), true);
  keeper = null;
  is("without the server's code for the student, nothing is kept", draw("student").includes("data-quiz-keep"), false);
  keeper = "c".repeat(32);
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  is("the lesson page makes the code for the signed-in student only, and hands it to the quiz", [/const quizKeeper = student \? deviceQuizKey\(course\.id, student\.email\) : null;/.test(page), /keeper=\{quizKeeper\}/.test(page)], [true, true]);
  is("pressing the quiz's button forgets nothing: only a recorded try does", /addEventListener\("submit"/.test(readFileSync("components/quiz-keep.tsx", "utf8")), false);
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
