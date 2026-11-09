/**
 * One student and the store's monthly quiz allowance and data room
 * (lib/quiz.ts submitQuiz, app/api/store/course/quiz/route.ts).
 *
 * A try is checked, counted and charged to the store at once: a burst of
 * parallel tries from one student never spends more of the store's monthly
 * submissions than the tries it marks, a creator's wait between tries holds
 * against a burst, and a refused try gives back exactly the data room it took.
 * The route takes a per-connection limit before it reads the student's access,
 * and a per-student limit and one of the store's buyer actions before the try.
 */
import { readFileSync } from "node:fs";
import { readQuiz, submitQuiz, type Quiz } from "@/lib/quiz";
import { QUIZ_MONTHLY_SUBMISSIONS, quizUsageKey } from "@/lib/quiz-usage-rules";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

function quizWith(attempts: number, waitMinutes = 0): Quiz {
  const made = readQuiz({ passPercent: 100, attempts, waitMinutes, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
  if (!made.ok) throw Error(`quiz: ${made.reason}`);
  return made.quiz;
}
const course = "a".repeat(32);
const sid = "c".repeat(32);
const key = quizUsageKey(sid)!;
const wrongFor = (quiz: Quiz) => ({ [quiz.questions[0].id]: [1] });
const spent = async () => Number((await redis.pipeline([["GET", key]]))[0] ?? 0);
const tries = async (lesson: string, who: string) => (await redis.pipeline([["GET", `nl:course:${course}:quiz:${lesson}:tries:${who}`]]))[0] ?? null;
const burst = (n: number, quiz: Quiz, lesson: string, who: string) =>
  Promise.all(Array.from({ length: n }, () => submitQuiz(course, lesson, who, quiz, wrongFor(quiz), sid, undefined, ROOM)));

async function main() {
  part("A burst of 60 parallel tries on a quiz of 3 tries");
  redis.clear();
  const three = quizWith(3);
  const a = await burst(60, three, "lesson000001", "student-a");
  is("three tries are marked", a.filter((r) => r.ok).length, 3);
  is("the store's allowance lost only the three tries marked", await spent(), 3);
  is("the student's count is three", await tries("lesson000001", "student-a"), "3");
  is("every other try is refused without being counted", a.filter((r) => !r.ok).every((r) => !r.ok && (r.reason === "no_tries" || r.reason === "unavailable")), true);

  part("A burst against the creator's wait between tries");
  redis.clear();
  const slow = quizWith(5, 60);
  const w = await burst(30, slow, "lesson000002", "student-w");
  is("one try is marked; the wait holds the rest", w.filter((r) => r.ok).length, 1);
  is("one submission spent", await spent(), 1);

  part("Unlimited tries (a quiz kept from before tries had a ceiling): what is spent is exactly what is marked");
  redis.clear();
  const open: Quiz = { ...quizWith(3), attempts: 0 };
  const u = await burst(20, open, "lesson000003", "student-u");
  const marked = u.filter((r) => r.ok).length;
  is("at least one try is marked", marked >= 1, true);
  is("spent equals marked", await spent(), marked);
  is("the count equals marked", await tries("lesson000003", "student-u"), String(marked));

  part("Two tabs a moment apart, no wait: both count, one after the other");
  redis.clear();
  const two = await burst(2, three, "lesson000004", "student-t");
  is("both marked", two.map((r) => r.ok), [true, true]);
  is("their tries are one and two", two.map((r) => (r.ok ? r.attempt.used : 0)).sort(), [1, 2]);
  is("two submissions spent", await spent(), 2);

  part("The allowance spent: refused tries give back the room they took");
  redis.clear();
  await redis.pipeline([["SET", key, String(QUIZ_MONTHLY_SUBMISSIONS)]]);
  const before = (await dataUsed(ROOM))!.used;
  const reasons = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const r = await submitQuiz(course, "lesson000005", "student-b", three, wrongFor(three), sid, undefined, ROOM);
    reasons.add(r.ok ? "ok" : r.reason);
  }
  is("every try answers usage_limit", [...reasons], ["usage_limit"]);
  is("the student's tries were never counted", await tries("lesson000005", "student-b"), null);
  is("the data room is where it was", (await dataUsed(ROOM))!.used, before);
  is("the allowance did not move past its figure", await spent(), QUIZ_MONTHLY_SUBMISSIONS);

  part("A try whose answer cannot be read is unavailable, counts nothing here and keeps its room");
  const original = redis.pipeline.bind(redis);
  const unreadable: (() => unknown)[] = [
    () => [["ok", "1"]], () => [["ok", 1, 2]], () => [["maybe", 1]], () => [["ok", 1.5]], () => [["ok", 0]],
    () => [], () => [null], () => [["ok", 1], "extra"], () => { throw Error("network"); },
  ];
  for (const [i, answer] of unreadable.entries()) {
    redis.clear();
    const roomBefore = (await dataUsed(ROOM))!.used;
    redis.pipeline = (async (batch) => (batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:quiz-try:") ? answer() : original(batch))) as typeof redis.pipeline;
    let result: Awaited<ReturnType<typeof submitQuiz>>;
    try {
      result = await submitQuiz(course, "lesson000006", "student-x", three, wrongFor(three), sid, undefined, ROOM);
    } finally {
      redis.pipeline = original;
    }
    is(`unreadable answer ${i}: unavailable`, result.ok ? "ok" : result.reason, "unavailable");
    is(`unreadable answer ${i}: the room it took stays taken`, (await dataUsed(ROOM))!.used > roomBefore, true);
  }

  part("A try that keeps losing the race is unavailable after its rounds, and gives back every round's room");
  redis.clear();
  {
    const roomBefore = (await dataUsed(ROOM))!.used;
    let evals = 0;
    redis.pipeline = (async (batch) => {
      if (batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:quiz-try:")) { evals += 1; return [["stale", 0]]; }
      return original(batch);
    }) as typeof redis.pipeline;
    let result: Awaited<ReturnType<typeof submitQuiz>>;
    try {
      result = await submitQuiz(course, "lesson000007", "student-y", three, wrongFor(three), sid, undefined, ROOM);
    } finally {
      redis.pipeline = original;
    }
    is("unavailable, nothing counted", result.ok ? "ok" : result.reason, "unavailable");
    is("three rounds", evals, 3);
    is("the data room is where it was", (await dataUsed(ROOM))!.used, roomBefore);
    is("nothing spent", await spent(), 0);
  }

  part("The route: a limit per connection before access, a limit per student and a buyer action before the try");
  const route = readFileSync("app/api/store/course/quiz/route.ts", "utf8");
  const at = (needle: string) => route.indexOf(needle);
  is("a per-connection limit", at("withinLimit(\"quiz-connection\"") > 0, true);
  is("it comes before the student's access is read", at("withinLimit(\"quiz-connection\"") < at("courseAccess(store"), true);
  is("a per-student limit", at("withinLimit(\"quiz-student\"") > 0, true);
  is("a buyer action", at("takeBuyerAction(store)") > 0, true);
  is("the buyer action follows the access check (a stranger spends none)", at("takeBuyerAction(store)") > at("access.state !== \"open\""), true);
  is("the buyer action comes before the try", at("takeBuyerAction(store)") < at("submitQuiz(course.id"), true);
  is("the per-student limit comes before the buyer action", at("withinLimit(\"quiz-student\"") < at("takeBuyerAction(store)"), true);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
