/**
 * A quiz passed stays passed (lib/quiz.ts, submitQuiz): "a pass can never be
 * undone by a worse try afterward". Two tabs that both read the quiz as not
 * passed can each send a try; when the one that passes is written first and
 * the one that fails lands after it, the failing try's record used to be
 * written over the pass. The lesson stayed in the passed set (later lessons
 * open), but the quiz showed "not passed", opened again for more tries, and
 * the person's data copy said passed: false beside a quiz listed as passed.
 *
 * Real submitQuiz and attemptOf against tests/redis-stub.ts. Synthetic data only.
 */
import { attemptOf, passedQuizzes, readQuiz, submitQuiz } from "@/lib/quiz";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "e".repeat(32);
const LESSON = "lessonquiz01";
const WHO = "f".repeat(32);

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  const made = readQuiz({ passPercent: 100, attempts: 5, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
  if (!made.ok) throw new Error("fixture quiz");
  const quiz = made.quiz;
  const right = { [quiz.questions[0].id]: [0] };
  const wrong = { [quiz.questions[0].id]: [1] };

  part("Two tabs: the passing try is written first, the failing one lands after it");
  const original = redis.pipeline;
  let release: () => void = () => {};
  const passedFirst = new Promise<void>((resolve) => (release = resolve));
  // Holds the failing try's record until the passing try has finished.
  redis.pipeline = async (commands) => {
    const write = commands.find((c) => c[0] === "SET" && String(c[1]).includes(WHO) && String(c[2]).includes('"passed":false}'));
    if (write) await passedFirst;
    return original.call(redis, commands);
  };
  try {
    const failing = submitQuiz(COURSE, LESSON, WHO, quiz, wrong, "c".repeat(32), undefined, ROOM);
    const passing = await submitQuiz(COURSE, LESSON, WHO, quiz, right, "c".repeat(32), undefined, ROOM);
    is("the passing tab's try passed", passing.ok && passing.grade.passed, true);
    release();
    const failed = await failing;
    is("the failing tab's try was counted and failed", failed.ok && !failed.grade.passed, true);
  } finally {
    redis.pipeline = original;
  }
  const attempt = await attemptOf(COURSE, LESSON, WHO);
  is("the lesson is in the passed set", (await passedQuizzes(COURSE, WHO)).has(LESSON), true);
  is("the quiz still reads as passed", attempt.passed, true);
  is("its best is the pass", attempt.best, 100);
  is("both tries counted", attempt.used, 2);
  const again = await submitQuiz(COURSE, LESSON, WHO, quiz, wrong, "c".repeat(32), undefined, ROOM);
  is("no further try is taken", again.ok ? "taken" : again.reason, "passed");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
