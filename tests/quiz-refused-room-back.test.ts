/**
 * A quiz try that is refused takes no room in the store's data room
 * (lib/quiz.ts, submitQuiz). The room a try may need is taken first, before
 * the store's monthly allowance of submissions and the student's count of
 * tries are asked; when either refused (the month's submissions spent, the
 * allowance not readable, or a try from another tab using the last one), the
 * try was not written and its room stayed taken for good, so every refused
 * press filled the store's room a little more. Now it goes back.
 *
 * Real submitQuiz and data room against tests/redis-stub.ts. Synthetic data only.
 */
import { readQuiz, submitQuiz } from "@/lib/quiz";
import { QUIZ_MONTHLY_SUBMISSIONS, quizUsageKey } from "@/lib/quiz-usage-rules";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "e".repeat(32);
const LESSON = "lessonquiz01";
const WHO = "f".repeat(32);
const SID = "c".repeat(32);

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const original = redis.pipeline;
  const made = readQuiz({ passPercent: 100, attempts: 3, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
  if (!made.ok) throw new Error("fixture quiz");
  const quiz = made.quiz;
  const wrong = { [quiz.questions[0].id]: [1] };
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;

  part("The month's submissions are spent");
  redis.clear();
  await redis.pipeline([["SET", quizUsageKey(SID)!, String(QUIZ_MONTHLY_SUBMISSIONS)]]);
  const before = await used();
  const spent = await submitQuiz(COURSE, LESSON, WHO, quiz, wrong, SID, undefined, ROOM);
  is("the try is refused", spent.ok ? "taken" : spent.reason, "usage_limit");
  is("and takes no room", await used(), before);

  part("The allowance cannot be read");
  redis.clear();
  const unread = await submitQuiz(COURSE, LESSON, WHO, quiz, wrong, null as unknown as string, undefined, ROOM);
  is("the try is refused", unread.ok ? "taken" : unread.reason, "unavailable");
  is("and takes no room", await used(), 0);

  part("Another tab used the last try in between");
  redis.clear();
  redis.pipeline = async (commands) => {
    const replies = (await original.call(redis, commands)) as unknown[];
    return commands.map((c, i) => (c[0] === "INCR" && String(c[1]).includes(":tries:") ? 4 : replies[i]));
  };
  let last;
  try {
    last = await submitQuiz(COURSE, LESSON, WHO, quiz, wrong, SID, undefined, ROOM);
  } finally {
    redis.pipeline = original;
  }
  is("the try is refused", last.ok ? "taken" : last.reason, "no_tries");
  is("and takes no room", await used(), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
