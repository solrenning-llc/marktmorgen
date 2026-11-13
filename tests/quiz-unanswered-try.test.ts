/**
 * A lesson's quiz sent with a question left unanswered (274 [AX1]; WCAG 2.2 3.3.4 Error Prevention, which names
 * "submit user test responses", and 3.3.6 at AAA; 3.3.1 Error Identification; 3.3.3 Error Suggestion; 3.3.7
 * Redundant Entry).
 *
 * Found reading the code on 13 November 2026 (buyer AAA audit, the student's lesson page): "Check my answers"
 * marked a try with blank questions as wrong and spent one of the student's limited tries (three by default), with
 * no check and no chance to correct. A missed radio button cost a try; with one try left it closed the quiz and,
 * when the quiz is required, the lessons after it.
 *
 * Now, with the real route (app/api/store/course/quiz/route.ts) on tests/redis-stub.ts and next/headers from
 * tests/security/next-headers.ts:
 *
 *   - a try with any shown question unanswered is not marked and uses no try; the student is sent back to the
 *     lesson with `quiz=unanswered`, and the answers they did pick come back in the address (`picked`), so nothing
 *     has to be chosen again;
 *   - the page names each unanswered question in a summary at the top of the quiz (the place the redirect lands,
 *     focusable, role="alert"), links to each, says beside each one what to do, and keeps every pick checked;
 *   - every language says it (lib/buyer-words/courses.ts);
 *   - a complete try is marked exactly as before.
 *
 * Synthetic data only; nothing real is reached.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { POST } from "@/app/api/store/course/quiz/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import * as quizLib from "@/lib/quiz";
import { type Answers, type Quiz, attemptOf, readQuiz, saveQuiz, setupOf } from "@/lib/quiz";
import { LessonQuiz } from "@/components/lesson-quiz";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";

const HOST = "marktmorgen.test";
const BUYER = "student@example.com";
const realFetch = globalThis.fetch;

type World = { store: Store; productId: string; courseId: string; lessonId: string; cookie: string; quiz: Quiz };

beforeEach(() => {
  redis.clear();
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  answering(null);
});

function threeQuestions(): Quiz {
  const made = readQuiz({
    passPercent: 100,
    attempts: 3,
    questions: [
      { text: "Flour and water?", choices: ["Dough", "Soup"], correct: [0] },
      { text: "Which are grains?", kind: "multiple", choices: ["Wheat", "Rye", "Salt"], correct: [0, 1] },
      { text: "Oven hot?", choices: ["Yes", "No", "Sometimes"], correct: [0] },
    ],
  });
  if (!made.ok) throw new Error(made.reason);
  return made.quiz;
}

/** A paying store selling one course of one lesson with a three-question quiz, a buyer enrolled in it. */
async function world(handle: string): Promise<World> {
  const owner = `${handle}@example.com`;
  assert.ok((await claimHandle(owner, handle, "School", "")).ok);
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Baking course", "Learn to bake", "49", null);
  assert.ok(made.ok);
  const productId = made.product.id;
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "Bread" });
  assert.ok(added.ok);
  course = added.course;
  const lessonId = course.modules[0].lessons[0].id;
  const quiz = threeQuestions();
  const quizzed = editCourse(course, { op: "quiz", lessonId, quiz: setupOf(quiz) });
  assert.ok(quizzed.ok);
  course = quizzed.course;
  assert.ok((await setProductCourse(owner, productId, { id: course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await saveQuiz(course.id, lessonId, quiz, ROOM);
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60);
  const token = await mintPass(store, BUYER, "all");
  return { store, productId, courseId: course.id, lessonId, cookie: `${passCookieName(store)}=${token}`, quiz };
}

async function send(w: World, picks: [questionAt: number, choice: number][]): Promise<Response> {
  const form = new URLSearchParams({ handle: w.store.handle, product: w.productId, lesson: w.lessonId, shown: w.quiz.questions.map((q) => q.id).join(",") });
  for (const [at, choice] of picks) form.append(`q_${w.quiz.questions[at].id}`, String(choice));
  const request = new Request(`https://${HOST}/api/store/course/quiz`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: HOST, origin: `https://${HOST}`, cookie: w.cookie },
    body: form.toString(),
  });
  answering(request);
  return POST(request as unknown as NextRequest);
}

/** The helpers this fix adds to lib/quiz.ts, read loosely so the RED run fails on the behaviour, not on the build. */
const helpers = quizLib as unknown as {
  unansweredIds?: (questions: Quiz["questions"], answers: Answers) => string[];
  pickedParam?: (questions: Quiz["questions"], answers: Answers) => string;
  readPicked?: (raw: unknown, questions: Quiz["questions"]) => Answers;
};

test("route: a try with a question left blank is not marked, uses no try, and keeps what was picked", async () => {
  const w = await world("qzblank");
  const response = await send(w, [[0, 0], [2, 1]]);
  assert.equal(response.status, 303);
  const location = new URL(String(response.headers.get("location")));
  assert.equal(location.searchParams.get("quiz"), "unanswered", `sent back to say so, not marked: ${location}`);
  assert.equal(location.hash, "#quiz-unanswered", "it lands on the summary that names the blank questions");
  assert.equal((await attemptOf(w.courseId, w.lessonId, emailKey(BUYER))).used, 0, "no try was used");
  assert.ok(helpers.readPicked, "lib/quiz.ts reads the picks back");
  const kept = helpers.readPicked!(location.searchParams.get("picked"), w.quiz.questions);
  const [a, b, c] = w.quiz.questions.map((q) => q.id);
  assert.deepEqual(kept, { [a]: [0], [b]: [], [c]: [1] }, "the answers picked come back, so nothing is chosen again (3.3.7)");
});

test("route: a multiple-answer question with no box ticked is unanswered too; nothing ticked at all is the same", async () => {
  const w = await world("qzempty");
  const response = await send(w, []);
  const location = new URL(String(response.headers.get("location")));
  assert.equal(location.searchParams.get("quiz"), "unanswered");
  assert.equal((await attemptOf(w.courseId, w.lessonId, emailKey(BUYER))).used, 0);
});

test("route control: a complete try is marked and counted exactly as before", async () => {
  const w = await world("qzfull");
  const response = await send(w, [[0, 0], [1, 0], [1, 1], [2, 0]]);
  const location = new URL(String(response.headers.get("location")));
  assert.equal(location.searchParams.get("quiz"), "marked");
  const attempt = await attemptOf(w.courseId, w.lessonId, emailKey(BUYER));
  assert.equal(attempt.used, 1);
  assert.equal(attempt.passed, true);
});

test("picks: written and read back exactly; anything else in the address is dropped", () => {
  assert.ok(helpers.pickedParam && helpers.readPicked && helpers.unansweredIds, "lib/quiz.ts has unansweredIds, pickedParam and readPicked");
  const quiz = threeQuestions();
  const [a, b, c] = quiz.questions.map((q) => q.id);
  const answers: Answers = { [a]: [1], [b]: [0, 2], [c]: [] };
  assert.deepEqual(helpers.unansweredIds!(quiz.questions, answers), [c]);
  assert.deepEqual(helpers.unansweredIds!(quiz.questions, {}), [a, b, c]);
  const param = helpers.pickedParam!(quiz.questions, answers);
  assert.match(param, /^[a-z0-9_-]*$/, "only characters an address keeps as they are");
  assert.deepEqual(helpers.readPicked!(param, quiz.questions), answers);
  assert.deepEqual(helpers.readPicked!(null, quiz.questions), { [a]: [], [b]: [], [c]: [] });
  assert.deepEqual(
    helpers.readPicked!(`${a}-0-1_zzzzzzzzzzzz-0_${b}-9_${c}-x`, quiz.questions),
    { [a]: [0], [b]: [], [c]: [] },
    "one pick on a one-answer question, no unknown question, no choice past the last, nothing unreadable",
  );
  assert.deepEqual(helpers.readPicked!("x".repeat(5000), quiz.questions), { [a]: [], [b]: [], [c]: [] });
});

test("page: the blank questions are named at the top, linked, marked beside each, and every pick stays checked", () => {
  const quiz = threeQuestions();
  const [a, b, c] = quiz.questions.map((q) => q.id);
  const props = {
    quiz,
    attempt: null,
    mode: "student" as const,
    action: "/api/store/course/quiz",
    hidden: {},
    storeName: "School",
    justMarked: false,
    unanswered: [b],
    kept: { [a]: [1], [b]: [], [c]: [2] },
  };
  const html = renderToStaticMarkup(createElement(LessonQuiz as unknown as (p: typeof props) => null, props));
  const w = COURSES_WORDS.en as unknown as Record<string, unknown>;
  assert.equal(typeof w.unansweredTry, "function", "the words exist");
  const summary = html.match(/<div[^>]*id="quiz-unanswered"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(summary, "a summary the redirect lands on");
  assert.match(summary, /role="alert"/);
  assert.match(summary, /tabindex="-1"/, "focusable, so landing on it moves the reading point there");
  assert.ok(summary.includes((w.unansweredTry as (n: number) => string)(1)));
  assert.ok(summary.includes(`href="#q-${b}"`), "it links to the question");
  assert.ok(summary.includes((w.questionN as (n: number) => string)(2)), "and names it by its number");
  const fieldset = html.match(new RegExp(`<fieldset[^>]*id="q-${b}"[^>]*>`))?.[0] ?? "";
  assert.ok(fieldset, "the question is the link's target");
  const said = fieldset.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(said, "the question says what is wrong with it");
  assert.match(html, new RegExp(`id="${said}"[^>]*>${String(w.answerThis).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`));
  // Each choice's input, read attribute by attribute: React writes them in an order of its own.
  const checked = [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\schecked=""/.test(tag))
    .map((tag) => `${tag.match(/name="q_([a-z0-9]{12})"/)?.[1]}:${tag.match(/value="(\d+)"/)?.[1]}`);
  assert.deepEqual(checked.sort(), [`${a}:1`, `${c}:2`].sort(), "what was picked is still picked");
  assert.ok(!new RegExp(`<fieldset[^>]*id="q-${a}"[^>]*aria-describedby`).test(html), "an answered question is not marked");
});

test("words: every language says it", () => {
  for (const [code, words] of Object.entries(COURSES_WORDS)) {
    const w = words as unknown as Record<string, unknown>;
    assert.equal(typeof w.unansweredTry, "function", `${code}: unansweredTry`);
    assert.equal(typeof w.questionN, "function", `${code}: questionN`);
    assert.equal(typeof w.answerThis, "string", `${code}: answerThis`);
    const one = (w.unansweredTry as (n: number) => string)(1);
    const two = (w.unansweredTry as (n: number) => string)(2);
    assert.ok(one && two && one !== two, `${code}: one and several are said differently`);
    assert.ok((w.questionN as (n: number) => string)(4).includes("4"), `${code}: the number is said`);
  }
});
