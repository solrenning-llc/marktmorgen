/**
 * D2 independent review of #2875, exact 1e8a2925061099070bcb1e0255c5d17e88667088.
 * Rule30 consumer proof; synthetic Redis only, no provider is called.
 * The command ceiling is installed before seeding or reading any fixture.
 */
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { attemptOf, markPassed, readQuiz, resetTries, setupOf, submitQuiz } from "@/lib/quiz";
import type { Course } from "@/lib/course";
import { paidShop } from "./plan-refund-stripe-world";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const underlying = redis.pipeline.bind(redis);
let commandsUsed = 0;
const COMMAND_CEILING = 5_000;
type Commands = (string | number)[][];
let injected: ((commands: Commands) => unknown[] | undefined) | null = null;
redis.pipeline = async (commands) => {
  if (commandsUsed + commands.length > COMMAND_CEILING) throw new Error("D2 synthetic command ceiling exceeded");
  commandsUsed += commands.length;
  const reply = injected?.(commands);
  return reply === undefined ? underlying(commands) : reply;
};
const courseId = "a".repeat(32), lessonId = "lesson000001", learner = "copy-learner";
const passedKey = `nl:course:${courseId}:passed:${learner}`;
const readCopy = (scope: ErasureScope) => COPIERS["lib/quiz.ts"](scope);
const nameOf = (e: unknown) => e instanceof Error ? e.name : String(e);
async function main(): Promise<void> {
  redis.clear();
  const shop = await paidShop();
  const store = await shop.store();
  const scope: ErasureScope = {
    store, sid: store.sid, statsId: store.statsId ?? "synthetic-stats", listId: null,
    email: "learner@example.com", person: "synthetic-person", learner,
    courses: [{ productId: "product00001", courseId, lessonIds: [lessonId], moduleIds: ["module000001"] }],
    productIds: ["product00001"], communityId: null,
  };
  part("Real quiz copier, healthy controls");
  await markPassed(courseId, learner, lessonId, ROOM);
  is("assignment-only pass is included without a quiz attempt", await readCopy(scope),
    [{ course: "product00001", quizzesPassed: [lessonId], attempts: [] }]);
  const nobody: ErasureScope = { ...scope, learner: "nobody" };
  is("exact empty pass list and no attempts is genuinely empty", await readCopy(nobody), []);

  part("Unknown pass list is not a complete empty person-data section");
  const badLists: [string, unknown[]][] = [
    ["null member-list", [null]],
    ["missing envelope", []],
    ["extra envelope entry", [[lessonId], []]],
  ];
  for (const [label, reply] of badLists) {
    injected = commands => commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === passedKey ? reply : undefined;
    const outcome = await readCopy(scope).then(records => ({ status: "ok", records }), error => ({ status: "unavailable", error: nameOf(error) }));
    injected = null;
    is(label + ": real copier refuses an incomplete section", outcome.status, "unavailable");
    is(label + ": stored pass is unchanged", await underlying([["SMEMBERS", passedKey]]), [[lessonId]]);
  }

  part("Reset's second GET pipeline needs value evidence, not only its length");
  const made = readQuiz({ passPercent: 100, attempts: 3, questions: [{ text: "Pick yes", choices: ["Yes", "No"], correct: [0] }] });
  if (!made.ok) throw new Error("fixture quiz");
  const quiz = made.quiz;
  const course: Course = {
    id: courseId, certificate: false, startsAt: null,
    modules: [{ id: "module000001", title: "Module", dripDays: 0, lessons: [
      { id: lessonId, title: "Lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: setupOf(quiz) },
    ] }],
  };
  const wrong = { [quiz.questions[0].id]: [1] };
  for (const [label, reply] of [["objects", [{}, {}]], ["undefined slots", [undefined, undefined]]] as [string, unknown[]][]) {
    const student = "reset-" + label;
    const submitted = await submitQuiz(courseId, lessonId, student, quiz, wrong, "c".repeat(32), undefined, ROOM);
    is(label + ": healthy stuck attempt seeded", submitted.ok, true);
    const before = await attemptOf(courseId, lessonId, student);
    injected = commands => commands.length === 2 && commands[0][0] === "GET" && String(commands[0][1]).endsWith(":result:" + student) ? reply : undefined;
    const outcome = await resetTries(course, student, ROOM).then(() => "completed", nameOf);
    injected = null;
    is(label + ": reset refuses and keeps the attempt", [outcome, await attemptOf(courseId, lessonId, student)], ["UnknownReplyError", before]);
  }
  console.log("Synthetic commands used: " + commandsUsed + "/" + COMMAND_CEILING);
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
