/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/quiz.ts resetTries (lines 609-624) with passedQuizzes
 * (lines 592-596):
 *   const [raw] = await redisPipeline([["SMEMBERS", passedKey(courseId, who)]]);
 *   return new Set(Array.isArray(raw) ? (raw as string[]) : []);
 * resetTries promises "What they already passed stays passed": it deletes the tries and the result (grade, best,
 * last answers) of every quiz NOT in that set. An SMEMBERS answered in an unknown shape is the empty set, so the
 * creator's "give tries back" deletes the student's results on the quizzes they passed too.
 */
import { attemptOf, readQuiz, resetTries, setupOf, submitQuiz } from "@/lib/quiz";
import type { Course } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const sid = "c".repeat(32);
const made = readQuiz({ passPercent: 100, attempts: 3, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
if (!made.ok) throw Error("quiz");
const quiz = made.quiz;
const lesson = (id: string) => ({ id, title: "Lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: setupOf(quiz) });
const course: Course = { id: "a".repeat(32), certificate: false, startsAt: null, modules: [{ id: "module000001", title: "Module", dripDays: 0, lessons: [lesson("lesson000001"), lesson("lesson000002")] }] };
const right = { [quiz.questions[0].id]: [0] };
const wrong = { [quiz.questions[0].id]: [1] };
const original = redis.pipeline.bind(redis);

async function setUp(who: string) {
  await submitQuiz(course.id, "lesson000001", who, quiz, right, sid, undefined, ROOM); // passed
  await submitQuiz(course.id, "lesson000002", who, quiz, wrong, sid, undefined, ROOM); // stuck
}
const view = async (who: string) => {
  const a = await attemptOf(course.id, "lesson000001", who);
  return { used: a.used, best: a.best, passed: a.passed };
};

async function main() {
  redis.clear();
  part("Healthy control: tries given back on the stuck quiz only; the passed quiz's result stays");
  await setUp("learner");
  const before = await view("learner");
  is("passed quiz before the reset", before, { used: 1, best: 100, passed: true });
  await resetTries(course, "learner", ROOM);
  is("passed quiz after the reset: unchanged", await view("learner"), before);
  is("stuck quiz: its tries are back", (await attemptOf(course.id, "lesson000002", "learner")).used, 0);

  part("DEFECT: the same reset, the SMEMBERS of the student's passes answered in an unknown shape");
  await setUp("second");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SMEMBERS") return [null];
    return original(commands);
  }) as typeof redis.pipeline;
  await resetTries(course, "second", ROOM);
  redis.pipeline = original;
  is("DEFECT: the passed quiz's result (grade, best, tries) is deleted", await view("second"), { used: 0, best: 0, passed: false });
  done();
}
main();
