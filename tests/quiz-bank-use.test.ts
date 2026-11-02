/**
 * 630 [HN6](7), unit 2: a quiz's question bank in use. A try is marked on
 * the questions it draws, worked out again on the server, never on what the
 * form claims; a form from another try or an older set of questions counts
 * nothing; a try before the creator's wait is over is refused; the page
 * shows the next try's questions only when the student may try now; the
 * studio and the student see the settings in plain words.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Quiz, attemptOf, questionsPerTry, quizForTry, readQuiz, studentQuiz, submitQuiz } from "@/lib/quiz";
import { LessonQuiz } from "@/components/lesson-quiz";
import { coursesWords } from "@/lib/buyer-words/courses";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const COURSE = "c".repeat(32);
const SID = "b".repeat(32);
const question = (n: number) => ({ text: `Question ${n}?`, choices: ["Right", "Wrong"], correct: [0], explanation: `Because ${n}.` });
function bank(extra: Record<string, unknown>): Quiz {
  const r = readQuiz({ passPercent: 100, attempts: 5, questions: [1, 2, 3, 4, 5, 6].map(question), ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r.quiz;
}
/** Every drawn question answered right. */
const allRight = (quiz: Quiz) => Object.fromEntries(quiz.questions.map((q) => [q.id, [0]]));
const ids = (quiz: Quiz) => quiz.questions.map((q) => q.id);

async function main() {
  redis.clear();

  part("A try is marked on the questions it draws");
  const quiz = bank({ draw: 3 });
  is("three questions per try", questionsPerTry(quiz), 3);
  const first = quizForTry(quiz, COURSE, "lesson000001", "ana", 1);
  is("the first try draws three", first.questions.length, 3);
  is("drawing again gives the same three", ids(quizForTry(quiz, COURSE, "lesson000001", "ana", 1)), ids(first));
  // Answers to the questions the try did not draw are left out of the mark.
  const extra = Object.fromEntries(quiz.questions.map((q) => [q.id, [1]]));
  const marked = await submitQuiz(COURSE, "lesson000001", "ana", { ...quiz, passPercent: 100 }, { ...extra, ...allRight(first) }, SID, undefined, ROOM, ids(first));
  is("answered right on the drawn three: passed", marked.ok ? marked.grade.passed : marked.reason, true);
  is("marked out of three, not six", marked.ok ? marked.grade.total : null, 3);
  is("only the drawn questions are kept", marked.ok ? Object.keys(marked.attempt.last?.answers ?? {}).sort() : null, ids(first).sort());

  part("A form from another try or another set counts nothing");
  const ben1 = quizForTry(quiz, COURSE, "lesson000001", "ben", 1);
  const others = quiz.questions.filter((q) => !ids(ben1).includes(q.id)).map((q) => q.id);
  const foreign = await submitQuiz(COURSE, "lesson000001", "ben", quiz, allRight(quiz), SID, undefined, ROOM, others);
  is("ids of questions the try did not draw: stale", foreign.ok ? "counted" : foreign.reason, "stale");
  const cara1 = quizForTry(quiz, COURSE, "lesson000001", "cara", 1);
  await submitQuiz(COURSE, "lesson000001", "cara", quiz, {}, SID, undefined, ROOM, ids(cara1));
  // The page still showed try 1; try 2 draws again.
  const cara2 = quizForTry(quiz, COURSE, "lesson000001", "cara", 2);
  const sameSet = ids(cara1).slice().sort().join() === ids(cara2).slice().sort().join();
  const late = await submitQuiz(COURSE, "lesson000001", "cara", quiz, allRight(cara1), SID, undefined, ROOM, ids(cara1));
  is("the old page's questions: refused as stale unless try 2 drew the same set", late.ok ? "counted" : late.reason, sameSet ? "counted" : "stale");
  const before = await attemptOf(COURSE, "lesson000001", "cara");
  is("a stale form used no try", before.used, sameSet ? 2 : 1);
  is("no ids at all: stale", (await submitQuiz(COURSE, "lesson000001", "dan", quiz, {}, SID, undefined, ROOM, null)).ok, false);
  is("…and no try used", (await attemptOf(COURSE, "lesson000001", "dan")).used, 0);
  const plain = bank({});
  is("a quiz with no draw needs no ids", (await submitQuiz(COURSE, "lesson000002", "dan", plain, allRight(plain), SID, undefined, ROOM)).ok, true);

  part("The wait between tries");
  const slow = bank({ waitMinutes: 30 });
  const tried = await submitQuiz(COURSE, "lesson000003", "eve", slow, {}, SID, undefined, ROOM);
  is("the first try is counted", tried.ok, true);
  const again = await submitQuiz(COURSE, "lesson000003", "eve", slow, allRight(slow), SID, undefined, ROOM);
  is("a second try at once is refused", again.ok ? "counted" : again.reason, "wait");
  is("…and used no try", (await attemptOf(COURSE, "lesson000003", "eve")).used, 1);
  const eve = await attemptOf(COURSE, "lesson000003", "eve");
  const at = (eve.last?.at ?? 0) * 1000;
  is("the page says thirty minutes are left", studentQuiz(slow, COURSE, "lesson000003", "eve", eve, at).wait, 30 * 60);
  is("after thirty minutes: no wait", studentQuiz(slow, COURSE, "lesson000003", "eve", eve, at + 30 * 60_000).wait, 0);
  is("a passed quiz never says to wait", studentQuiz(slow, COURSE, "lesson000003", "eve", { ...eve, passed: true }, at).wait, 0);

  part("What the page shows a student");
  const drawsTwo = bank({ draw: 2, waitMinutes: 60 });
  const none = { used: 0, last: null, best: 0, passed: false };
  is("before any try: try 1's questions", ids(studentQuiz(drawsTwo, COURSE, "l", "fay", none).quiz), ids(quizForTry(drawsTwo, COURSE, "l", "fay", 1)));
  const last = { answers: {}, grade: { right: 0, total: 2, percent: 0, passed: false, marks: {} }, at: 1_000 };
  const waiting = studentQuiz(drawsTwo, COURSE, "l", "fay", { used: 1, last, best: 0, passed: false }, 1_000_000);
  is("waiting: still the last try's questions, never the next", ids(waiting.quiz), ids(quizForTry(drawsTwo, COURSE, "l", "fay", 1)));
  const ready = studentQuiz(drawsTwo, COURSE, "l", "fay", { used: 1, last, best: 0, passed: false }, 1_000_000 + 3_600_000);
  is("after the wait: the next try's questions", ids(ready.quiz), ids(quizForTry(drawsTwo, COURSE, "l", "fay", 2)));
  const out = studentQuiz(drawsTwo, COURSE, "l", "fay", { used: 5, last, best: 0, passed: false }, 1_000_000);
  is("out of tries: the last try's questions", ids(out.quiz), ids(quizForTry(drawsTwo, COURSE, "l", "fay", 5)));
  is("out of tries: no wait shown", out.wait, 0);

  part("The lesson's quiz in words");
  const w = coursesWords("en");
  const page = (props: Partial<Parameters<typeof LessonQuiz>[0]>) =>
    renderToStaticMarkup(
      createElement(LessonQuiz, {
        quiz: waiting.quiz,
        attempt: { used: 1, last, best: 0, passed: false },
        mode: "student",
        action: "/api/store/course/quiz",
        hidden: { lesson: "l" },
        storeName: "Fay's Store",
        justMarked: false,
        ...props,
      }),
    );
  const shut = page({ waitSeconds: 59 * 60 + 1 });
  is("the wait is said in minutes, rounded up", shut.includes(w.waitAgain("1 hour")), true);
  is("while waiting the answers are shut", shut.includes("Check my answers"), false);
  is("…and nothing to send", shut.includes('name="shown"'), false);
  const open = page({ quiz: ready.quiz });
  is("the heading counts the questions of a try", open.includes("2 questions"), true);
  is("the form names the questions it showed", open.includes(`name="shown" value="${ids(ready.quiz).join(",")}"`), true);
  is("a drawn bank does not point at the last try's marks", open.includes("Not quite” and try again"), false);
  is("a stale form is explained", page({ quiz: ready.quiz, stale: true }).includes(w.staleTry.replace("'", "&#x27;")), true);
  const owner = page({ quiz: bank({ draw: 4, shuffle: true, waitMinutes: 90 }), mode: "owner", attempt: null });
  is("the creator reads the draw", owner.includes(w.bankDraw(4, 6)), true);
  is("…the shuffle", owner.includes(w.bankShuffle), true);
  is("…and the wait", owner.includes(w.bankWait("90 minutes")), true);
  is("a whole day is said in hours", w.span(1_440), "24 hours");
  for (const lang of ["es", "fr", "de", "it", "nl", "pt"] as const) {
    const t = coursesWords(lang);
    is(`${lang}: every new sentence is its own`, [t.bankShuffle, t.staleTry, t.waitAgain(t.span(5))].every((line, i) => line !== [w.bankShuffle, w.staleTry, w.waitAgain(w.span(5))][i]), true);
  }

  done();
}

void main();
