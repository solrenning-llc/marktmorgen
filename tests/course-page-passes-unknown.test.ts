/**
 * The student's course page when their quiz passes do not read (app/[handle]/course/[product]/page.tsx; Claude 1 cloud R's
 * MEDIUM on #4558): it says the progress could not be checked, never "Finish every lesson and pass the quiz" to a student
 * who finished and passed. Synthetic store and course, the in-memory database.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderToReadableStream } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import CoursePage from "@/app/[handle]/course/[product]/page";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";

const HOST = "marktmorgen.test";
const BUYER = "student@example.com";
const realPipeline = redis.pipeline.bind(redis);
const realFetch = globalThis.fetch;

beforeEach(() => {
  redis.clear();
  redis.pipeline = realPipeline;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
});
afterEach(() => {
  redis.pipeline = realPipeline;
  globalThis.fetch = realFetch;
  answering(null);
});

async function finishedStudent(handle: string) {
  const owner = `${handle}@example.com`;
  assert.ok((await claimHandle(owner, handle, "School", "")).ok);
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Writing course", "Learn to write", "49", null);
  assert.ok(made.ok);
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "Opening" });
  assert.ok(added.ok);
  course = added.course;
  const lessonId = course.modules[0].lessons[0].id;
  const quizzed = editCourse(course, { op: "quiz", lessonId, quiz: { questions: 1, passPercent: 70, attempts: 3, required: true } });
  assert.ok(quizzed.ok);
  const certified = editCourse(quizzed.course, { op: "certificate", on: true });
  assert.ok(certified.ok);
  course = certified.course;
  assert.ok((await setProductCourse(owner, made.product.id, { id: course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await recordEnrollment(store, BUYER, made.product.id, Math.floor(Date.now() / 1000) - 60);
  const token = await mintPass(store, BUYER, "all");
  await markLesson(course.id, BUYER, lessonId, true, store);
  await realPipeline([["SADD", `nl:course:${course.id}:passed:${emailKey(BUYER)}`, lessonId]]);
  return { store, productId: made.product.id, courseId: course.id, cookie: `${passCookieName(store)}=${token}` };
}

async function draw(w: Awaited<ReturnType<typeof finishedStudent>>): Promise<string> {
  answering(new Request(`https://${HOST}/@${w.store.handle}/course/${w.productId}`, { headers: { host: HOST, cookie: w.cookie } }));
  const node = await CoursePage({ params: Promise.resolve({ handle: `@${w.store.handle}`, product: w.productId }), searchParams: Promise.resolve({}) });
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return (await new Response(stream).text()).replace(/&#x27;|&#39;/g, "'");
}

test("control: a finished student whose passes read is offered the certificate", async () => {
  const w = await finishedStudent("rcpok");
  const html = await draw(w);
  assert.ok(html.includes(COURSES_WORDS.en.getCertificate));
});

test("a finished student whose passes do not read is told it could not be checked, never how to finish", async () => {
  const w = await finishedStudent("rcpbad");
  redis.pipeline = async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "SMEMBERS" && String(commands[0][1]).startsWith(`nl:course:${w.courseId}:passed:`) ? [null] : realPipeline(commands);
  const html = await draw(w);
  assert.ok(!html.includes(COURSES_WORDS.en.certHow(1)), "the page says 'Finish every lesson and pass the quiz...' on an unreadable reply");
  assert.ok(html.includes(COURSES_WORDS.en.certProgressUnknown));
});
