/**
 * "Get my certificate" on a course with a required quiz
 * (app/api/store/course/certificate/route.ts): the student's passes read in a
 * shape that cannot be read are unknown (CX-123 rule 24), and the route says
 * so with an honest 503 in the store's language, as it does for the lessons
 * done. It used to read them through passedForGate, the door's reader, which
 * takes an unknown reply as "nothing passed", so a student who had finished
 * and passed was sent back to "?cert=unfinished".
 *
 * Real route and readers, Redis on tests/redis-stub.ts, next/headers from
 * tests/security/next-headers.ts (tests/aliases/cert-passes-unknown.test.ts.json).
 * Synthetic data only; nothing real is reached.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { POST } from "@/app/api/store/course/certificate/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import { markPassed } from "@/lib/quiz";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";

const HOST = "marktmorgen.test";
const BUYER = "student@example.com";
const realPipeline = redis.pipeline.bind(redis);
const realFetch = globalThis.fetch;

type World = { store: Store; productId: string; courseId: string; lessonId: string; cookie: string };

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

/** A paying store selling one course of one lesson with a required quiz and a certificate; the buyer did the lesson and passed. */
async function world(handle: string): Promise<World> {
  const owner = `${handle}@example.com`;
  assert.ok((await claimHandle(owner, handle, "School", "")).ok);
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Writing course", "Learn to write", "49", null);
  assert.ok(made.ok);
  const productId = made.product.id;
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "Opening" });
  assert.ok(added.ok);
  course = added.course;
  const lessonId = course.modules[0].lessons[0].id;
  const quizzed = editCourse(course, { op: "quiz", lessonId, quiz: { questions: 1, passPercent: 100, attempts: 3, required: true } });
  assert.ok(quizzed.ok);
  course = quizzed.course;
  const certified = editCourse(course, { op: "certificate", on: true });
  assert.ok(certified.ok);
  course = certified.course;
  assert.equal(course.modules[0].lessons[0].quiz?.required, true);
  assert.ok((await setProductCourse(owner, productId, { id: course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60);
  await markLesson(course.id, BUYER, lessonId, true, store);
  await markPassed(course.id, emailKey(BUYER), lessonId, store);
  const token = await mintPass(store, BUYER, "all");
  return { store, productId, courseId: course.id, lessonId, cookie: `${passCookieName(store)}=${token}` };
}

async function askCertificate(w: World): Promise<Response> {
  const form = new URLSearchParams({ handle: w.store.handle, product: w.productId, name: "Ada Fictional" });
  const request = new Request(`https://${HOST}/api/store/course/certificate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: HOST, origin: `https://${HOST}`, cookie: w.cookie },
    body: form.toString(),
  });
  answering(request);
  return POST(request as unknown as NextRequest);
}

test("certificate: passes that cannot be read answer an honest 503, never 'unfinished'", async () => {
  const w = await world("cpunknown");
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SMEMBERS" && String(commands[0][1]).startsWith(`nl:course:${w.courseId}:passed:`)) return [null];
    return realPipeline(commands);
  };
  const response = await askCertificate(w);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), COURSES_WORDS.en.certProgressUnknown);
  assert.ok(!String(response.headers.get("location") ?? "").includes("cert=unfinished"));
});

test("certificate control: a student who finished and passed is not sent to 'unfinished'", async () => {
  const w = await world("cpcontrol");
  const response = await askCertificate(w);
  assert.equal(response.status, 303);
  assert.ok(!String(response.headers.get("location") ?? "").includes("cert=unfinished"));
});
