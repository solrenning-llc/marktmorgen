/**
 * A quiz drafted with AI from a lesson (POST /api/store/ai, kind "quiz") reads
 * the lesson's text exactly before any AI job is reserved: a reply that is
 * neither text nor Redis's own null is unknown, so the request is refused and
 * no monthly AI job is spent on a quiz drafted without the lesson (issue #4287,
 * item 10; Codex P). The text, and a lesson with no text, draft as before.
 */
import { NextRequest } from "next/server";
import { POST as aiRoute } from "@/app/api/store/ai/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { type Course, saveBody, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "quiz-body-exact@example.test";
const COURSE = "c".repeat(32);
const LESSON = "lessonqzbdy1";
let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.anthropic.com") {
    modelCalls += 1;
    const questions = [{ text: "What feeds a starter?", choices: ["Flour and water", "Sugar"], correct: [0], explanation: "The lesson says so." }];
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ questions }) }], usage: { input_tokens: 10, output_tokens: 10 } }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const original = redis.pipeline.bind(redis);
let bodyReply: unknown[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bodyReply && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:course:${COURSE}:body:${LESSON}`) return bodyReply;
  return original(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle(OWNER, "quizbody", "Quiz Body Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_QuizBodyExact1", subscriptionId: "sub_QuizBodyExact1", active: true, tier: "scale", period: paidPeriod() });
  const added = await addProduct(OWNER, "Sourdough basics", "", "49", null);
  if (!added.ok) throw new Error("fixture could not add product");
  if (!(await setProductCourse(OWNER, added.product.id, { id: COURSE, lessons: 1 })).ok) throw new Error("fixture could not make a course");
  const store = (await storeForEmail(OWNER))!;
  const course: Course = { id: COURSE, modules: [{ id: "moduleqzbdy1", title: "Module 1", dripDays: 0, lessons: [{ id: LESSON, title: "Feeding", preview: false, video: null, files: [], link: null, hasBody: true, quiz: null }] }], certificate: false, startsAt: null } as unknown as Course;
  await saveCourse(course, store, true);
  await saveBody(COURSE, LESSON, "A starter is fed with flour and water every day.", store);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  const ask = async (reply: unknown[] | null): Promise<{ status: number; calls: number }> => {
    bodyReply = reply;
    const before = modelCalls;
    const response = await aiRoute(new NextRequest("https://marktmorgen.com/api/store/ai", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      // With the creator's own words the writer is asked even without the lesson's text, so an unknown text would spend a job.
      body: JSON.stringify({ kind: "quiz", id: added.product.id, lessonId: LESSON, count: 3, notes: "Keep the questions short." }),
    }));
    bodyReply = null;
    return { status: response.status, calls: modelCalls - before };
  };

  part("Control: the lesson's text is read and the quiz is drafted");
  const healthy = await ask(null);
  is("answered and the model asked once", [healthy.status, healthy.calls], [200, 1]);

  for (const [label, reply] of [
    ["a number", [42]],
    ["an object", [{ text: "x" }]],
    ["no reply", []],
    ["two replies", ["text", "text"]],
  ] as const) {
    part(`The lesson's text answers ${label}`);
    const out = await ask([...reply]);
    is("refused, and no AI job is spent", [out.status >= 400, out.calls], [true, 0]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
