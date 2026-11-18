/**
 * A quiz draft kept in the student's browser (297 [SQ8]) is removed once a
 * recorded try makes it useless, even when the lesson shows only the result
 * (Codex L's MEDIUM on #4324 @10b31a83b4, 17 November 2026): after a passing
 * try, or the last allowed one, the quiz no longer draws QuizKeep, so the
 * draft used to stay in the browser although the privacy policy says it is
 * removed the next time the lesson opens.
 *
 *   - passed or out of tries: any kept draft for that lesson and student goes;
 *   - waiting between tries: a draft made before a try that was recorded since
 *     goes; a draft at the same count (never recorded) stays, to come back
 *     once the wait is over;
 *   - the result-only view and the wait both draw the forgetter, only for a
 *     signed-in student with the server's code, never for the owner or a
 *     visitor, and never next to QuizKeep.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { draftOf, forgetClosedDraft, quizKeepKey } from "@/lib/quiz-keep-rules";
import { LessonQuiz } from "@/components/lesson-quiz";
import type { Quiz } from "@/lib/quiz";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 18, 12);
const shown = "aaaaaaaaaaa1,aaaaaaaaaaa2";
const key = quizKeepKey("c".repeat(32));
const kept = (tries: number) => JSON.stringify(draftOf([{ name: "q_aaaaaaaaaaa1", value: "1", checked: true }], shown, tries, NOW - 60_000));

/** A synthetic browser storage holding one entry. */
const storage = (raw: string | null) => {
  const items = new Map<string, string>(raw === null ? [] : [[key, raw]]);
  return {
    getItem: (k: string) => items.get(k) ?? null,
    removeItem: (k: string) => void items.delete(k),
    has: () => items.has(key),
  };
};

part("Removed once a recorded try makes it useless");
{
  const passed = storage(kept(0));
  forgetClosedDraft(passed, key, 1, true, NOW);
  is("passed (the try was recorded): removed", passed.has(), false);
  const lastTry = storage(kept(2));
  forgetClosedDraft(lastTry, key, 3, true, NOW);
  is("the last allowed try recorded: removed", lastTry.has(), false);
  const finalSameCount = storage(kept(3));
  forgetClosedDraft(finalSameCount, key, 3, true, NOW);
  is("no try can be sent any more: removed whatever its count", finalSameCount.has(), false);
  const waitingAfter = storage(kept(0));
  forgetClosedDraft(waitingAfter, key, 1, false, NOW);
  is("waiting, a try recorded since the draft: removed", waitingAfter.has(), false);
  const unreadable = storage("{");
  forgetClosedDraft(unreadable, key, 1, false, NOW);
  is("waiting, unreadable: removed", unreadable.has(), false);
}

part("Kept while it can still come back");
{
  const waitingSame = storage(kept(1));
  forgetClosedDraft(waitingSame, key, 1, false, NOW);
  is("waiting, never recorded (same count): kept for after the wait", waitingSame.has(), true);
  const nothing = storage(null);
  forgetClosedDraft(nothing, key, 1, true, NOW);
  is("nothing kept: nothing to do", nothing.has(), false);
  const closed = {
    getItem: () => {
      throw new Error("storage closed");
    },
    removeItem: () => {
      throw new Error("storage closed");
    },
  };
  is("storage closed (a private window): no error", (() => {
    try {
      forgetClosedDraft(closed, key, 1, true, NOW);
      return true;
    } catch {
      return false;
    }
  })(), true);
}

part("The lesson draws the forgetter where QuizKeep is not");
{
  const quiz = {
    questions: [
      { id: "aaaaaaaaaaa1", text: "One?", kind: "single", choices: ["A", "B"], correct: [1], explanation: "" },
      { id: "aaaaaaaaaaa2", text: "Two?", kind: "single", choices: ["C", "D"], correct: [0], explanation: "" },
    ],
    passPercent: 50,
    attempts: 3,
  } as unknown as Quiz;
  const grade = { right: 2, total: 2, percent: 100, marks: { aaaaaaaaaaa1: true, aaaaaaaaaaa2: true } };
  const attempt = (used: number, ok: boolean) => ({ used, best: ok ? 100 : 0, passed: ok, last: { answers: {}, grade, at: NOW } });
  const draw = (mode: "student" | "owner" | "visitor", a: unknown, keeper: string | null = "c".repeat(32), waitSeconds = 0) =>
    renderToStaticMarkup(createElement(LessonQuiz, { quiz, attempt: a as never, mode, action: "/api/store/course/quiz", hidden: { handle: "shop", product: "prod", lesson: "lessonaaaaa1" }, storeName: "Shop", justMarked: false, keeper, waitSeconds }));
  const forgets = (html: string) => html.includes("data-quiz-forget");
  const keeps = (html: string) => html.includes("data-quiz-keep");
  is("passed: the forgetter, not QuizKeep", [forgets(draw("student", attempt(1, true))), keeps(draw("student", attempt(1, true)))], [true, false]);
  is("out of tries: the forgetter", forgets(draw("student", attempt(3, false))), true);
  is("waiting between tries: the forgetter", forgets(draw("student", attempt(1, false), "c".repeat(32), 600)), true);
  is("may answer: QuizKeep only", [forgets(draw("student", attempt(1, false))), keeps(draw("student", attempt(1, false)))], [false, true]);
  is("no server code, the owner, a visitor: nothing", [forgets(draw("student", attempt(1, true), null)), forgets(draw("owner", attempt(1, true))), forgets(draw("visitor", attempt(1, true)))], [false, false, false]);
}

done();
