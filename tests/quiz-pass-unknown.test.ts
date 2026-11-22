/**
 * A student's quiz passes that Redis answered in an unknown shape are unknown,
 * never "nothing passed" (CX-123 rule 24):
 *
 * - "Get my certificate" (app/api/store/course/certificate/route.ts) read the
 *   passes with passedForGate, which turns an unreadable reply into an empty
 *   set, so a student who had passed every required quiz was sent back as
 *   "unfinished". It now answers the same honest 503 as unreadable progress.
 * - The studio's student list (passedFor) showed such a student as "0 of N"
 *   quizzes passed and offered to give their tries back. It now reads null
 *   for that student, and the page says the passes could not be read.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { POST } from "@/app/api/store/course/certificate/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import { passedFor } from "@/lib/quiz";
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

/** A paying store selling a one-lesson course whose lesson has a required quiz, with a certificate; a buyer enrolled. */
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
  const quizzed = editCourse(course, { op: "quiz", lessonId, quiz: { questions: 1, passPercent: 70, attempts: 3, required: true } });
  assert.ok(quizzed.ok);
  course = quizzed.course;
  const certified = editCourse(course, { op: "certificate", on: true });
  assert.ok(certified.ok);
  course = certified.course;
  assert.ok((await setProductCourse(owner, productId, { id: course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60);
  const token = await mintPass(store, BUYER, "all");
  return { store, productId, courseId: course.id, lessonId, cookie: `${passCookieName(store)}=${token}` };
}

/** The student finished the lesson and passed its required quiz. */
async function finished(w: World): Promise<void> {
  await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
  await realPipeline([["SADD", `nl:course:${w.courseId}:passed:${emailKey(BUYER)}`, w.lessonId]]);
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

/** Every SMEMBERS of a student's passes in this course is answered by `reply`; the rest reaches the stand-in Redis. */
function passedReadAnswers(w: World, reply: (commands: (string | number)[][]) => unknown[]): void {
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.length && commands.every((c) => c[0] === "SMEMBERS" && String(c[1]).startsWith(`nl:course:${w.courseId}:passed:`))) return reply(commands);
    return realPipeline(commands);
  };
}

const MALFORMED: [string, () => unknown][] = [
  ["a null in place of the list", () => null],
  ["a text in place of the list", () => "lesson"],
  ["a list holding a number", () => [7]],
];

for (const [label, reply] of MALFORMED) {
  test(`certificate: passes answered as ${label} are unknown, an honest 503, never 'unfinished'`, async () => {
    const w = await world(`qpc${MALFORMED.findIndex(([l]) => l === label)}cert`);
    await finished(w);
    passedReadAnswers(w, () => [reply()]);
    const response = await askCertificate(w);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), COURSES_WORDS.en.certProgressUnknown);
  });
}

test("certificate control: the passes read, a student who finished and passed gets the certificate", async () => {
  const w = await world("qpccertdone");
  await finished(w);
  const response = await askCertificate(w);
  assert.equal(response.status, 303);
  assert.match(String(response.headers.get("location")), /\/certificate\/[^?]+(\?issued=1)?$/);
});

test("certificate control: a student who finished the lesson but has not passed the required quiz is unfinished", async () => {
  const w = await world("qpccertnopass");
  await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
  const response = await askCertificate(w);
  assert.equal(response.status, 303);
  assert.match(String(response.headers.get("location")), /\?cert=unfinished#certificate$/);
});

test("passedFor: a student whose passes read in an unknown shape is null, never 'nothing passed'; the others read as they are", async () => {
  const w = await world("qpcstudio");
  await finished(w);
  const other = "other@example.com";
  passedReadAnswers(w, (commands) => commands.map((c) => (String(c[1]).endsWith(emailKey(BUYER)) ? null : realPipelineSync(c))));
  const rows = await passedFor(w.courseId, [emailKey(BUYER), emailKey(other)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], null);
  assert.deepEqual([...(rows[1] ?? ["null"])], []);
});

test("passedFor control: a whole reply of another length reads every student as unknown", async () => {
  const w = await world("qpcstudiolen");
  passedReadAnswers(w, () => [[]]);
  const rows = await passedFor(w.courseId, [emailKey(BUYER), emailKey("other@example.com")]);
  assert.deepEqual(rows, [null, null]);
});

test("passedFor control: passes that read are kept per student", async () => {
  const w = await world("qpcstudiook");
  await finished(w);
  const rows = await passedFor(w.courseId, [emailKey(BUYER), emailKey("other@example.com")]);
  assert.deepEqual(rows.map((r) => (r ? [...r] : null)), [[w.lessonId], []]);
});

test("the studio's student list says when a student's passes could not be read, and offers no tries back on a guess", () => {
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  assert.match(page, /passed\[i\] === null/);
  assert.match(page, /Could not be read/);
});

/** An empty set for a student with no passes, as the stand-in Redis answers. */
function realPipelineSync(command: (string | number)[]): unknown {
  return command[0] === "SMEMBERS" ? [] : null;
}
