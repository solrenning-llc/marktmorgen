/**
 * The MCP read tools of lib/mcp-tools.ts never hand an agent an empty lesson
 * text, a "no quiz", a "no task" or zero visitors for something that was not
 * read (CX-123 rule 24: unknown is never zero, empty, done or no). The second
 * part of tests/mcp-tools-unknown-sweep.test.ts, for the readers that live in
 * other files:
 *
 *   - readLessonTool (get_lesson): a lesson's text (lib/course.ts), quiz
 *     (lib/quiz.ts) or task (lib/assignment.ts) that answered in another shape
 *     fails, never "", "no quiz" or "no task"; one Redis says is not there is
 *     still none;
 *   - readPageReadingTool (get_page_reading): a depth record (lib/page-depth.ts)
 *     that answered in another shape is an error, never zero visitors measured.
 *
 * Each case runs the real tool on a synthetic store, first as a control and
 * then with the one Redis reply it depends on answering in another shape.
 * Synthetic data only; no outside request is made.
 */
import { readLessonTool, readPageReadingTool } from "@/lib/mcp-tools";
import { editCourse, emptyCourse, newItemId, saveBody, saveCourse } from "@/lib/course";
import { type Quiz, saveQuiz } from "@/lib/quiz";
import { saveTask } from "@/lib/assignment";
import { countDepth } from "@/lib/page-depth";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside requests in this test");
}) as typeof fetch;

type Command = (string | number)[];
const OWNER = "mcp-sweep-two@example.com";
const realPipeline = redis.pipeline.bind(redis);
// Changes the answer of the pipelines that touch `prefix`, and only those, to another shape.
let prefix = "";
let twisted = 0;
redis.pipeline = (async (batch: Command[]) => {
  const touches = prefix && batch.some((command) => command.slice(1).some((arg) => String(arg).startsWith(prefix)));
  if (!touches) return realPipeline(batch);
  twisted += 1;
  return batch.map(() => 42);
}) as typeof redis.pipeline;

async function odd<T>(keys: string, run: () => Promise<T>): Promise<{ value?: T; failed: boolean; twisted: number; error?: string }> {
  prefix = keys;
  twisted = 0;
  try {
    return { value: await run(), failed: false, twisted };
  } catch (error) {
    // Which error: only UnknownReplyError says "not known"; a ReferenceError or a TypeError is a defect (Codex T on #3225).
    return { failed: true, twisted, error: error instanceof UnknownReplyError ? "UnknownReplyError" : error instanceof Error ? error.name : "thrown" };
  } finally {
    prefix = "";
  }
}

const charge = async () => null;
type Lesson = { text?: string; quiz?: unknown; task?: unknown } | null;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mcp-sweep-two", "Sweep Bakery", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_McpSweep002", subscriptionId: "sub_McpSweep002", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const course = await addProduct(OWNER, "Bread Course", "", "49", null);
  if (!course.ok) throw new Error("no course product");
  let outline = emptyCourse();
  for (const title of ["Starter dough", "Shaping", "Baking"]) {
    const added = editCourse(outline, { op: "lesson-add", moduleId: outline.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    outline = added.course;
  }
  await saveCourse(outline, ROOM);
  const [full, bare, quizzed] = outline.modules[0].lessons.map((l) => l.id);
  await saveBody(outline.id, full, "Mix flour and water.", ROOM);
  const quizOf = (text: string): Quiz => ({ passPercent: 70, attempts: 0, required: false, questions: [{ id: newItemId(), kind: "single", text, choices: ["Yes", "No"], correct: [0], explanation: "" }] });
  await saveQuiz(outline.id, full, quizOf("Flour and water?"), ROOM);
  await saveTask(outline.id, full, { prompt: "Bake one loaf.", review: false, gate: false, file: false }, ROOM);
  await saveQuiz(outline.id, quizzed, quizOf("Oven hot?"), ROOM);
  const linked = await setProductCourse(OWNER, course.product.id, { id: outline.id, lessons: 3 });
  if (!linked.ok) throw new Error("not a course");
  const store = (await storeForEmail(OWNER)) as Store;
  if (!store.statsId) throw new Error("no stats id");
  const product = course.product.id;
  const lessonKey = (kind: string, lesson: string) => `nl:course:${outline.id}:${kind}:${lesson}`;

  part("readLessonTool: a lesson's text, quiz and task are read exactly");
  const control = (await readLessonTool(store, product, full, charge)) as Lesson;
  is("control: the text as written", control?.text, "Mix flour and water.");
  is("control: the quiz and the task as written", [(control?.quiz as { questions?: unknown[] } | null)?.questions?.length, (control?.task as { prompt?: string } | null)?.prompt], [1, "Bake one loaf."]);
  const none = (await readLessonTool(store, product, bare, charge)) as Lesson;
  is("a lesson Redis says has no text, quiz or task has none", [none?.text, none?.quiz, none?.task], ["", null, null]);

  const body = await odd(lessonKey("body", full), () => readLessonTool(store, product, full, charge) as Promise<Lesson>);
  is("the text's read is really answered in another shape", body.twisted > 0, true);
  is("a text that could not be read fails, never \"\"", [body.failed, body.value?.text ?? "not given", body.error], [true, "not given", "UnknownReplyError"]);
  const quiz = await odd(lessonKey("quiz", quizzed), () => readLessonTool(store, product, quizzed, charge) as Promise<Lesson>);
  is("the quiz's read is really answered in another shape", quiz.twisted > 0, true);
  is("a quiz that could not be read fails, never \"no quiz\"", [quiz.failed, quiz.value?.quiz === undefined ? "not given" : quiz.value.quiz, quiz.error], [true, "not given", "UnknownReplyError"]);
  const task = await odd(lessonKey("task", full), () => readLessonTool(store, product, full, charge) as Promise<Lesson>);
  is("the task's read is really answered in another shape", task.twisted > 0, true);
  is("a task that could not be read fails, never \"no task\"", [task.failed, task.value?.task === undefined ? "not given" : task.value.task, task.error], [true, "not given", "UnknownReplyError"]);
  // A record that is there but does not read as a quiz or a task is not "none" either.
  await realPipeline([["SET", lessonKey("quiz", bare), "{not json"], ["SET", lessonKey("task", bare), JSON.stringify({ prompt: "" })]]);
  const broken = await odd("nothing-twisted", () => readLessonTool(store, product, bare, charge) as Promise<Lesson>);
  is("a quiz or task record that does not read fails, never none", [broken.failed, broken.error], [true, "UnknownReplyError"]);
  await realPipeline([["DEL", lessonKey("quiz", bare), lessonKey("task", bare)]]);

  part("readPageReadingTool: a depth record in another shape is not zero visitors");
  await countDepth(store.statsId, product, "blok0001");
  await countDepth(store.statsId, product, "blok0002");
  type Reading = { visitors_measured?: number | null; error?: string } | null;
  const reading = (await readPageReadingTool(store, product, charge)) as Reading;
  is("control: the visitors measured", reading?.visitors_measured, 2);
  const depth = await odd(`nl:depth:${store.statsId}:${product}`, () => readPageReadingTool(store, product, charge) as Promise<Reading>);
  is("the depth's read is really answered in another shape", depth.twisted > 0, true);
  is("a depth that could not be read is an error, never 0 visitors", [depth.value?.visitors_measured ?? "not given", typeof depth.value?.error], ["not given", "string"]);
  await realPipeline([["HSET", `nl:depth:${store.statsId}:${product}`, "blok0003", "many"]]);
  const garbled = (await readPageReadingTool(store, product, charge)) as Reading;
  is("a depth count that is not a whole number is an error, never skipped", [garbled?.visitors_measured ?? "not given", typeof garbled?.error], ["not given", "string"]);
  // A count HINCRBY never leaves below zero (Codex T on #3225, LOW): not a count, so not read as none counted.
  await realPipeline([["DEL", `nl:depth:${store.statsId}:${product}`], ["HSET", `nl:depth:${store.statsId}:${product}`, "blok0001", "-1"]]);
  const negative = (await readPageReadingTool(store, product, charge)) as Reading;
  is("a depth count below zero is an error, never 0 visitors", [negative?.visitors_measured ?? "not given", typeof negative?.error], ["not given", "string"]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
