/**
 * AX274 (WCAG 2.2 3.3.4 and 3.3.6, error prevention for test responses): a
 * quiz try sent with a question left blank used one of the student's limited
 * tries and marked the blank wrong, with no chance to see and fix it first.
 * Every question needs at least one right answer (lib/quiz.ts parseQuestion),
 * so a blank is never an answer: it is checked before anything is counted.
 *
 *   - lib/quiz-answer-check.ts finds the blank questions of the try the page
 *     showed, in its order;
 *   - the route refuses such a try before it is counted and goes back to the
 *     quiz saying which questions are blank;
 *   - the quiz says so in an alert, beside each blank question (tied to its
 *     group by aria-describedby), and in every store language;
 *   - with scripts on, the form is held in the page first, so what was
 *     ticked is not lost (3.3.7).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Quiz } from "@/lib/quiz";
import { LessonQuiz } from "@/components/lesson-quiz";
import { COURSES_WORDS, coursesWords } from "@/lib/buyer-words/courses";
import { blankFromQuery, blankQuestions } from "@/lib/quiz-answer-check";
import { done, is, part } from "./check";

const quiz: Quiz = {
  passPercent: 70,
  attempts: 2,
  required: false,
  questions: [
    { id: "qa1", text: "One?", kind: "single", choices: ["A", "B"], correct: [0], explanation: "" },
    { id: "qb2", text: "Two?", kind: "multiple", choices: ["A", "B", "C"], correct: [0, 2], explanation: "" },
    { id: "qc3", text: "Three?", kind: "single", choices: ["A", "B"], correct: [1], explanation: "" },
  ],
} as Quiz;

part("Blank questions are found in the order shown");
is("all answered: none", blankQuestions(quiz, { qa1: [0], qb2: [2], qc3: [1] }, []), []);
is("blanks without a shown list: by the quiz's order", blankQuestions(quiz, { qa1: [], qb2: [1] }, []), ["qa1", "qc3"]);
is("blanks by the order the page showed", blankQuestions(quiz, { qb2: [] }, ["qc3", "qb2", "qa1"]), ["qc3", "qb2", "qa1"]);
is("an id the quiz does not hold is never named", blankQuestions(quiz, {}, ["zz9", "qa1"]), ["qa1"]);
is("the query is read back to this quiz's ids only", blankFromQuery("qa1.zz9.qc3.qa1", quiz), ["qa1", "qc3"]);
is("…and nothing from something else", blankFromQuery(["qa1"], quiz), []);
is("…or from nothing", blankFromQuery(undefined, quiz), []);

part("The route refuses a blank try before counting it");
const route = readFileSync("app/api/store/course/quiz/route.ts", "utf8");
const check = route.indexOf("blankQuestions(");
const submit = route.indexOf("submitQuiz(course.id");
is("the route checks for blanks", check > 0, true);
is("…before the try is counted", check > 0 && check < submit, true);
is("…and goes back to the quiz naming them", /quiz=blank&blank=/.test(route), true);

part("The quiz says which questions are blank");
const w = coursesWords("en");
const html = renderToStaticMarkup(
  createElement(LessonQuiz, {
    quiz,
    attempt: null,
    mode: "student",
    action: "/api/store/course/quiz",
    hidden: { lesson: "l" },
    storeName: "Fay's Store",
    justMarked: false,
    blank: ["qb2"],
  }),
);
const escape = (s: string) => s.replace(/'/g, "&#x27;");
is("an alert says nothing was counted", html.includes('role="alert"') && html.includes(escape(w.blankTry)), true);
is("the blank question says so beside it", html.includes('id="quiz-qb2-blank"') && html.includes(escape(w.blankQuestion)), true);
is("…tied to its group", /<fieldset[^>]*aria-describedby="quiz-qb2-blank"/.test(html), true);
is("an answered question carries a hidden note only", /id="quiz-qa1-blank"[^>]*hidden/.test(html) || /hidden=""[^>]*id="quiz-qa1-blank"/.test(html), true);
is("the in-page check is on the form", html.includes("data-quiz-check"), true);
const quiet = renderToStaticMarkup(
  createElement(LessonQuiz, { quiz, attempt: null, mode: "student", action: "/x", hidden: {}, storeName: "S", justMarked: false }),
);
is("without blanks the alert is there for the in-page check, hidden", /<p id="quiz-blank" role="alert"[^>]*hidden=""/.test(quiet), true);
is("…and shown when the server named blanks", /<p id="quiz-blank" role="alert"[^>]*hidden=""/.test(html), false);

part("Every store language says it");
for (const [code, words] of Object.entries(COURSES_WORDS)) {
  is(`${code}: blank try`, typeof words.blankTry === "string" && words.blankTry.length > 20, true);
  is(`${code}: blank question`, typeof words.blankQuestion === "string" && words.blankQuestion.length > 3, true);
}

part("The in-page check keeps the answers");
const client = readFileSync("components/quiz-answer-check.tsx", "utf8");
is("it is a client part", client.startsWith('"use client"'), true);
is("it stops the send", client.includes("preventDefault()"), true);
is("it moves focus to the first blank question", client.includes(".focus()"), true);

done();
