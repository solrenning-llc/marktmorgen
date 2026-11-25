/**
 * Issue #4287, item 10 (Codex P, `P-20261112-2042-course-quiz-ai-unknown-body.md`; rule 24): the studio's AI quiz
 * draft (app/api/store/ai/route.ts, kind "quiz") read the lesson's text with readBody, which turns any reply that is
 * not text into "". An unknown read then drafted a quiz from no lesson and spent one of the month's AI jobs on it. Now
 * the text is read exactly (readBodyExact): an unknown reply answers 503 before any job is taken or the model asked,
 * and a lesson that really has no text is still drafted from its title, as before.
 *
 * Synthetic store and course, in-memory Redis, the model played by a stand-in for fetch; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { aiLeft } from "@/lib/ai";
import { type Course, saveBody, saveCourse } from "@/lib/course";
import { POST as AI } from "@/app/api/store/ai/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  modelCalls += 1;
  const question = (n: number) => ({ text: `Question ${n} about washes?`, choices: ["Thin paint spread evenly", "A brush"], correct: [0], explanation: "A wash is thin paint spread evenly." });
  const quiz = { questions: [1, 2, 3, 4].map(question) };
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(quiz) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
}) as typeof fetch;

const OWNER = "quiz-exact@example.test";
const COURSE = "f".repeat(32);
const LESSON = "lessonaaaaa1";
const original = redis.pipeline.bind(redis);
/** What the next GET of the lesson's text answers instead of Redis, once. */
let bodyAnswer: unknown = undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bodyAnswer !== undefined && commands.length === 1 && commands[0]![0] === "GET" && String(commands[0]![1]) === `nl:course:${COURSE}:body:${LESSON}`) {
    const answer = bodyAnswer;
    bodyAnswer = undefined;
    return [answer];
  }
  return original(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  redis.clear();
  await claimHandle(OWNER, "quiz-exact", "Quiz Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_QuizExact01", subscriptionId: "sub_QuizExact01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const added = await addProduct(OWNER, "Watercolor basics", "", "49", null);
  if (!added.ok) throw new Error("no product");
  const product = added.product.id;
  if (!(await setProductCourse(OWNER, product, { id: COURSE, lessons: 1 })).ok) throw new Error("no course");
  const store = (await storeForEmail(OWNER))!;
  const course: Course = { id: COURSE, modules: [{ id: "moduleaaaaa1", title: "Module 1", dripDays: 0, lessons: [{ id: LESSON, title: "Washes", preview: false, video: null, files: [], link: null, hasBody: true, quiz: null }] }], certificate: false, startsAt: null } as Course;
  await saveCourse(course, store, true);
  await saveBody(COURSE, LESSON, "A wash is thin paint spread evenly over the paper.", store);
  const session = await openSession(OWNER);
  const quiz = () =>
    AI(new NextRequest("https://marktmorgen.com/api/store/ai", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ kind: "quiz", id: product, lessonId: LESSON, count: 4, notes: "Check the basics." }) }));

  for (const [label, answer] of [["a number", 7], ["a list", ["text"]], ["an object", { text: "x" }]] as const) {
    part(`The lesson's text answers ${label}: unknown`);
    const before = await aiLeft((await storeForEmail(OWNER))!);
    modelCalls = 0;
    bodyAnswer = answer;
    const response = await quiz();
    const body = (await response.json()) as { ok?: boolean; error?: string };
    is("answered 503, unavailable", [response.status, body.error], [503, "unavailable"]);
    is("the model was not asked", modelCalls, 0);
    is("no AI job was taken", await aiLeft((await storeForEmail(OWNER))!), before);
  }

  part("A readable lesson still drafts, as before");
  modelCalls = 0;
  const response = await quiz();
  is("answered 200", response.status, 200);
  is("the model was asked", modelCalls > 0, true);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
