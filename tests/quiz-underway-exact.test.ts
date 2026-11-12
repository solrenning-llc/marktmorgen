/**
 * Exact reads (CX-123 rules 24 and 30) for two defects of sweep A5 (docs/reviews/c5-sweep-a5.md, findings 6 and 9),
 * from the proofs tests/sweep-a5-quiz-reset.proof.test.ts and tests/sweep-a5-refund-underway.proof.test.ts with
 * their expectations turned around. Synthetic only: the stand-in Redis, Stripe and Resend, nothing real is reached.
 *
 *   - lib/quiz.ts resetTries: giving a student their tries back never deletes the result of a quiz they passed.
 *     The SMEMBERS of their passes answered in an unknown shape is not "nothing passed": the reset throws
 *     UnknownReplyError before anything is deleted.
 *   - lib/plan-refund-underway.ts refundUnderway: replies in an unknown shape are not "not underway": it throws, and
 *     its callers (`.catch(() => true)`) treat that as underway, so the refund route says "We could not confirm your
 *     refund yet" ("unsure") or "already being handled" ("busy"), never "Nothing was refunded" ("error") or a fresh
 *     confirmation ("review") while a note says money may have moved.
 */
import { NextRequest } from "next/server";
import { attemptOf, readQuiz, resetTries, setupOf, submitQuiz } from "@/lib/quiz";
import type { Course } from "@/lib/course";
import { ENDING_KEY, flowKeyOf, issueReview } from "@/lib/plan-refund-flow";
import { refundUnderway } from "@/lib/plan-refund-underway";
import { POST } from "@/app/api/billing/refund/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { who } from "./plan-refund-route-world";
import { paidShop, world } from "./plan-refund-stripe-world";

const original = redis.pipeline.bind(redis);
type Pipeline = typeof redis.pipeline;
const nameOf = (error: unknown) => (error instanceof Error ? error.name : String(error));

// ---- The quiz ------------------------------------------------------------------------------------------------
const sid = "c".repeat(32);
const made = readQuiz({ passPercent: 100, attempts: 3, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
if (!made.ok) throw Error("quiz");
const quiz = made.quiz;
const lesson = (id: string) => ({ id, title: "Lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: setupOf(quiz) });
const course: Course = { id: "a".repeat(32), certificate: false, startsAt: null, modules: [{ id: "module000001", title: "Module", dripDays: 0, lessons: [lesson("lesson000001"), lesson("lesson000002")] }] };
const right = { [quiz.questions[0].id]: [0] };
const wrong = { [quiz.questions[0].id]: [1] };

async function setUp(student: string) {
  await submitQuiz(course.id, "lesson000001", student, quiz, right, sid, undefined, ROOM); // passed
  await submitQuiz(course.id, "lesson000002", student, quiz, wrong, sid, undefined, ROOM); // stuck
}
const view = async (student: string, lessonId: string) => {
  const a = await attemptOf(course.id, lessonId, student);
  return { used: a.used, best: a.best, passed: a.passed };
};
const PASSED = { used: 1, best: 100, passed: true };
const STUCK = { used: 1, best: 0, passed: false };

// ---- The refund ----------------------------------------------------------------------------------------------
const refundSid = "0123456789abcdef0123456789abcdef";
const post = async (review: string) => {
  const response = await POST(new NextRequest("https://local.example/api/billing/refund", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `review=${encodeURIComponent(review)}` }));
  return new URL(response.headers.get("location")!).searchParams.get("done");
};
/** refundUnderway's own read (HEXISTS then EXISTS) answered with `reply`; every other read as the store has it. */
const underwayAnswers = (reply: unknown) => {
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 2 && commands[0]?.[0] === "HEXISTS" && commands[0][1] === ENDING_KEY && commands[1]?.[0] === "EXISTS" ? reply : original(commands)) as Pipeline;
};

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";

  part("Quiz, healthy control: tries back on the stuck quiz only; the passed quiz's result stays");
  await setUp("learner");
  is("before the reset", [await view("learner", "lesson000001"), await view("learner", "lesson000002")], [PASSED, STUCK]);
  await resetTries(course, "learner", ROOM);
  is("passed quiz unchanged, stuck quiz's tries back", [await view("learner", "lesson000001"), (await view("learner", "lesson000002")).used], [PASSED, 0]);

  part("Quiz, healthy control: a student who passed nothing gets every quiz's tries back");
  await submitQuiz(course.id, "lesson000001", "fresh", quiz, wrong, sid, undefined, ROOM);
  await submitQuiz(course.id, "lesson000002", "fresh", quiz, wrong, sid, undefined, ROOM);
  await resetTries(course, "fresh", ROOM);
  is("both quizzes' tries back (an empty set read exactly is nothing passed)", [(await view("fresh", "lesson000001")).used, (await view("fresh", "lesson000002")).used], [0, 0]);

  part("Quiz: the SMEMBERS of the student's passes answered in an unknown shape");
  const shapes: [string, unknown][] = [
    ["null", [null]],
    ["a number", [3]],
    ["a list with a number", [["lesson000001", 7]]],
    ["no reply", []],
    ["two replies", [["lesson000001"], ["lesson000001"]]],
    ["not a list", { 0: ["lesson000001"] }],
    ["a Proxy", [new Proxy(["lesson000001"], {})]],
  ];
  for (const [label, reply] of shapes) {
    const student = `unknown-${label.replace(/\W+/g, "-")}`;
    await setUp(student);
    redis.pipeline = (async (commands: (string | number)[][]) => (commands.length === 1 && commands[0][0] === "SMEMBERS" ? reply : original(commands))) as Pipeline;
    const thrown = await resetTries(course, student, ROOM).then(() => "no throw", nameOf);
    redis.pipeline = original;
    is(`${label}: the reset throws UnknownReplyError, nothing deleted`, [thrown, await view(student, "lesson000001"), await view(student, "lesson000002")], ["UnknownReplyError", PASSED, STUCK]);
  }

  part("Refund underway, healthy controls");
  await redis.pipeline([["HSET", ENDING_KEY, refundSid, JSON.stringify({ s: "sub_x", at: 1, t: 1, m: 1 })], ["SET", flowKeyOf(refundSid), "held", "EX", 60]]);
  is("a note and a running request: underway", await refundUnderway(refundSid), true);
  await redis.pipeline([["DEL", flowKeyOf(refundSid)]]);
  is("a note only: underway", await refundUnderway(refundSid), true);
  await redis.pipeline([["HDEL", ENDING_KEY, refundSid], ["SET", flowKeyOf(refundSid), "held", "EX", 60]]);
  is("a running request only: underway", await refundUnderway(refundSid), true);
  await redis.pipeline([["DEL", flowKeyOf(refundSid)]]);
  is("neither: not underway", await refundUnderway(refundSid), false);

  part("Refund underway: its replies in an unknown shape throw, never answer 'settled'");
  await redis.pipeline([["HSET", ENDING_KEY, refundSid, JSON.stringify({ s: "sub_x", at: 1, t: 1, m: 1 })]]);
  const replies: [string, unknown][] = [
    ["no reply", []],
    ["text", ["yes", "yes"]],
    ["objects", [{}, {}]],
    ["null", [null, 0]],
    ["a count out of range", [2, 0]],
    ["EXISTS in text", [0, "1"]],
    ["one reply short", [0]],
    ["a Proxy", new Proxy([1, 1], {})],
  ];
  for (const [label, reply] of replies) {
    underwayAnswers(reply);
    const thrown = await refundUnderway(refundSid).then((answer) => `answered ${answer}`, nameOf);
    redis.pipeline = original;
    is(`${label}: UnknownReplyError`, thrown, "UnknownReplyError");
  }
  is("the note is still there", (await redis.pipeline([["HEXISTS", ENDING_KEY, refundSid]]))[0], 1);
  await redis.pipeline([["HDEL", ENDING_KEY, refundSid]]);

  part("Refund route, healthy control: the refund write fails with the stop set by the creator");
  const e = await paidShop({ stopSet: true });
  who.store = await e.store();
  world.refundsDown = true;
  is("'could not confirm' (unsure), the note kept", [await post(await issueReview(who.store.sid, 6_900)), Boolean(await e.note())], ["unsure", true]);
  world.refundsDown = false;
  is("no pass while it is being settled: 'already being handled'", await post(""), "busy");

  part("Refund route: the same, with the underway read answered in an unknown shape");
  const f = await paidShop({ stopSet: true });
  who.store = await f.store();
  world.refundsDown = true;
  const pass = await issueReview(who.store.sid, 6_900);
  underwayAnswers([[], []]);
  const failed = await post(pass);
  redis.pipeline = original;
  world.refundsDown = false;
  is("'could not confirm' (unsure), never 'Nothing was refunded' (error), the note kept", [failed, Boolean(await f.note())], ["unsure", true]);
  underwayAnswers(["yes", "yes"]);
  const again = await post("");
  redis.pipeline = original;
  is("no pass: 'already being handled' (busy), never a fresh confirmation (review)", again, "busy");

  part("Refund route, healthy control: no note, no pass: a fresh confirmation");
  const g = await paidShop();
  who.store = await g.store();
  is("review", await post(""), "review");

  done();
}
main();
