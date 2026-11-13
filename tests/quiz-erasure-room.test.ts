/**
 * Deleting a person's quiz records (lib/quiz.ts, forgetQuizPerson) gives back
 * to the store's data room what those records hold, as giving a student their
 * tries back does (resetTries): each try's result and count, and each pass.
 * It deleted them and kept their room counted for good, so every erased
 * student left the store's room fuller. Given back only when the deletion
 * confirmed every record that was read, so a deletion that raced another one
 * never gives the same room back twice.
 *
 * Real submitQuiz, markPassed, erasure and data room against tests/redis-stub.ts. Synthetic data only.
 */
import { forgetQuizPerson, markPassed, readQuiz, submitQuiz } from "@/lib/quiz";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "e".repeat(32);
const QUIZ_LESSON = "lessonquiz01";
const TASK_LESSON = "lessontask01";
const WHO = "f".repeat(32);

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const made = readQuiz({ passPercent: 100, attempts: 3, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
  if (!made.ok) throw new Error("fixture quiz");
  const quiz = made.quiz;

  part("A student's try, its count and two passes, then their deletion");
  const tried = await submitQuiz(COURSE, QUIZ_LESSON, WHO, quiz, { [quiz.questions[0].id]: [0] }, "c".repeat(32), undefined, ROOM);
  is("the try passed", tried.ok && tried.grade.passed, true);
  await markPassed(COURSE, WHO, TASK_LESSON, ROOM);
  const before = await used();
  const result = redis.run(["GET", `nl:course:${COURSE}:quiz:${QUIZ_LESSON}:result:${WHO}`]) as string;
  const tries = redis.run(["GET", `nl:course:${COURSE}:quiz:${QUIZ_LESSON}:tries:${WHO}`]) as string;
  const held = dataBytes([result], 1) + dataBytes([tries], 1) + dataBytes([QUIZ_LESSON], 1) + dataBytes([TASK_LESSON], 1);
  const courses = [{ courseId: COURSE, lessonIds: [QUIZ_LESSON, TASK_LESSON] }];
  is("three records deleted", await forgetQuizPerson(courses, WHO, ROOM), 3);
  is("what they held is given back", before - (await used()) >= held, true);
  is("the quiz records take no room any more", await used(), 0);

  part("A second deletion gives back nothing more");
  const after = await used();
  is("nothing left to delete", await forgetQuizPerson(courses, WHO, ROOM), 0);
  is("the room is unchanged", await used(), after);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
