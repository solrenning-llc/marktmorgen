/**
 * #4446: a quiz submission already on its way when the learner is erased
 * never writes their answers, score or pass back after the erasure.
 *
 * submitQuiz counts the try, then writes the result and the pass. The test
 * holds it just before that final write, does what person erasure does for
 * quizzes (the store's suppression print, then forgetQuizPerson) and lets it
 * go on. The final write now checks the print in the same Redis turn, with the
 * Redis-clock rule of lib/lesson-notes.ts NOTE_SAVE: a print from before the
 * submission began (a learner erased long ago who came back) does not refuse
 * it. Synthetic records, in-memory Redis.
 */
import { attemptOf, forgetQuizPerson, readQuiz, submitQuiz } from "@/lib/quiz";
import { suppressCommand } from "@/lib/suppression";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const original = redis.pipeline.bind(redis);
type Pipeline = typeof redis.pipeline;
const COURSE = "a".repeat(32);
const LESSON = "lesson000001";
const LIST = "quizEraseList01";
const sid = "c".repeat(32);
const made = readQuiz({ passPercent: 100, attempts: 3, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
if (!made.ok) throw Error("quiz");
const quiz = made.quiz;
const right = { [quiz.questions[0].id]: [0] };

const view = async (who: string) => {
  const [passed] = await original([["SMEMBERS", `nl:course:${COURSE}:passed:${who}`]]);
  // A result kept without its try count reads as unreadable evidence (lib/quiz.ts attemptOf).
  const attempt = await attemptOf(COURSE, LESSON, who).catch(() => null);
  if (!attempt) return { unreadable: true, passed };
  return { used: attempt.used, hasResult: attempt.last !== null, passed };
};

/** The submission's last write: the result SET before #4446, the script that keeps it since. */
const finalWrite = (commands: (string | number)[][]) =>
  commands.some((c) =>
    (c[0] === "SET" && String(c[1]).startsWith(`nl:course:${COURSE}:quiz:${LESSON}:result:`))
    || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:quiz-keep-unless-erased:")));

async function main(): Promise<void> {
  redis.clear();

  part("A learner not erased");
  const control = "control@example.com";
  const kept = await submitQuiz(COURSE, LESSON, emailKey(control), quiz, right, sid, undefined, ROOM, null, { listId: LIST, email: control });
  is("the result is kept", kept.ok, true);
  is("with the try, the answers and the pass", await view(emailKey(control)), { used: 1, hasResult: true, passed: [LESSON] });

  part("Erased just before the final write");
  const email = "learner@example.com";
  const who = emailKey(email);
  let erased = false;
  const hook = (async (commands: (string | number)[][]) => {
    if (!erased && finalWrite(commands)) {
      erased = true;
      await original([suppressCommand(LIST, email)]);
      await forgetQuizPerson([{ courseId: COURSE, lessonIds: [LESSON] }], who);
    }
    return original(commands);
  }) as Pipeline;
  redis.pipeline = hook;
  const result = await submitQuiz(COURSE, LESSON, who, quiz, right, sid, undefined, ROOM, null, { listId: LIST, email });
  redis.pipeline = original;
  is("the erasure ran in between", erased, true);
  is("the submission is refused, and says why", result.ok ? "ok" : result.reason, "erased");
  is("the try, the answers, the score and the pass do not come back", await view(who), { used: 0, hasResult: false, passed: [] });

  part("Erased long before, and back");
  const back = "back@example.com";
  await original([suppressCommand(LIST, back, Math.floor(Date.now() / 1000) - 600)]);
  const later = await submitQuiz(COURSE, LESSON, emailKey(back), quiz, right, sid, undefined, ROOM, null, { listId: LIST, email: back });
  is("a submission begun after the erasure is kept", later.ok, true);
  is("with its result and pass", await view(emailKey(back)), { used: 1, hasResult: true, passed: [LESSON] });

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
