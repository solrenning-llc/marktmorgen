/**
 * A student's lessons marked done (lib/learn.ts, doneLessons) read exactly
 * (CX-123 rule 24, R24 privacy inventory item 4). SMEMBERS answers a list of
 * names, empty for a student who marked none; any other answer is unknown,
 * never "no lesson done". It used to read as an empty set, so:
 *
 * - "Get my certificate" (app/api/store/course/certificate/route.ts) sent a
 *   student who had finished back to "?cert=unfinished";
 * - the course's front door and its lessons showed 0 of N done;
 * - the person's data copy (lib/person-copy.ts) held `lessonsDone: []`, a gap
 *   handed over as the whole record.
 *
 * Now the reader throws UnknownReplyError, the route answers an honest 503 in
 * the store's language, the pages say the progress could not be checked
 * (role="status"), and the data copy fails rather than leave the lessons out.
 *
 * Real route and readers, Redis on tests/redis-stub.ts, next/headers from
 * tests/security/next-headers.ts (tests/aliases/lessons-done-exact.test.ts.json).
 * Synthetic data only; nothing real is reached.
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
import { courseProgress, doneLessons, doneLessonsOrUnknown, markLesson, mintPass, passCookieName, recordEnrollment, touchStudent } from "@/lib/learn";
import { UnknownReplyError } from "@/lib/redis-reply";
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

/** A paying store selling one course of one lesson with a certificate, a buyer enrolled in it. */
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
  const certified = editCourse(course, { op: "certificate", on: true });
  assert.ok(certified.ok);
  course = certified.course;
  const lessonId = course.modules[0].lessons[0].id;
  assert.ok((await setProductCourse(owner, productId, { id: course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60, "stripe");
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

/** Every SMEMBERS of this student's done lessons is answered by `reply`; everything else reaches the stand-in Redis. */
function doneReadAnswers(w: World, reply: () => unknown[]): void {
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SMEMBERS" && String(commands[0][1]).startsWith(`nl:course:${w.courseId}:done:`)) return reply();
    return realPipeline(commands);
  };
}

const MALFORMED: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["a null in place of the list", () => [null]],
  ["a text in place of the list", () => ["lesson"]],
  ["a list holding a number", () => [[7]]],
  ["a list holding an object", () => [[{ id: "x" }]]],
];

for (const [label, reply] of MALFORMED) {
  test(`doneLessons: ${label} is unknown, never "no lesson done"`, async () => {
    const w = await world(`ld${MALFORMED.findIndex(([l]) => l === label)}reader`);
    await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
    doneReadAnswers(w, reply);
    await assert.rejects(() => doneLessons(w.courseId, BUYER), UnknownReplyError);
  });
}

test("doneLessonsOrUnknown: unknown reads as null for a page to say so; a real list and a confirmed empty one read as they are", async () => {
  const w = await world("ldorunknown");
  assert.deepEqual([...((await doneLessonsOrUnknown(w.courseId, BUYER)) ?? ["null"])], []);
  await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
  assert.deepEqual([...((await doneLessonsOrUnknown(w.courseId, BUYER)) ?? ["null"])], [w.lessonId]);
  doneReadAnswers(w, () => [null]);
  assert.equal(await doneLessonsOrUnknown(w.courseId, BUYER), null);
});

test("doneLessons control: lessons marked done read back; a student who marked none reads an empty set", async () => {
  const w = await world("ldcontrolreader");
  assert.deepEqual([...(await doneLessons(w.courseId, BUYER))], []);
  await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
  assert.deepEqual([...(await doneLessons(w.courseId, BUYER))], [w.lessonId]);
});

test("certificate: an unreadable progress answers an honest 503 in the store's language, never 'unfinished'", async () => {
  const w = await world("ldcertunknown");
  await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
  doneReadAnswers(w, () => [null]);
  const response = await askCertificate(w);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), COURSES_WORDS.en.certProgressUnknown);
  assert.ok(!String(response.headers.get("location") ?? "").includes("cert=unfinished"));
});

test("certificate control: a student who marked no lesson is sent back as unfinished", async () => {
  const w = await world("ldcertempty");
  const response = await askCertificate(w);
  assert.equal(response.status, 303);
  assert.match(String(response.headers.get("location")), /\?cert=unfinished#certificate$/);
});

test("certificate control: a student who finished gets the certificate", async () => {
  const w = await world("ldcertdone");
  await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
  const response = await askCertificate(w);
  assert.equal(response.status, 303);
  assert.match(String(response.headers.get("location")), /\/certificate\/[^?]+(\?issued=1)?$/);
});

test("every buyer language says the progress could not be checked, in plain words", () => {
  for (const [code, words] of Object.entries(COURSES_WORDS)) {
    assert.equal(typeof words.progressUnknown, "string", code);
    assert.ok(words.progressUnknown.length > 20, code);
    assert.equal(typeof words.certProgressUnknown, "string", code);
    assert.ok(words.certProgressUnknown.length > 20, code);
    assert.notEqual(words.progressUnknown, words.certProgressUnknown, code);
    assert.equal(typeof words.openFirst, "string", code);
    assert.notEqual(words.openFirst, words.startFirst, code);
  }
  assert.equal(COURSES_WORDS.en.progressUnknown, "We could not check your progress just now. Your lessons are all here. Reload the page to try again.");
});

test("the course's front door says the progress is unknown, never 0 of N done", () => {
  const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
  assert.match(page, /doneLessonsOrUnknown\(course\.id, access\.learner\.email\)/);
  assert.doesNotMatch(page, /\bdoneLessons\(/);
  assert.match(page, /done === null \? \(\s*<p className="st-note[^"]*" role="status">\{w\.progressUnknown\}<\/p>/);
  assert.match(page, /const finished = studying && done !== null && hasFinished\(/);
  assert.match(page, /done === null \? w\.openFirst :/);
  assert.match(page, /\{w\.certProgressUnknown\}/);
});

test("a lesson page says the progress is unknown and offers no done/not-done toggle on a guess", () => {
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  assert.match(page, /doneLessonsOrUnknown\(course\.id, student\.email\)/);
  assert.doesNotMatch(page, /\bdoneLessons\(/);
  assert.match(page, /student && open && done === null \? \(\s*<p className="st-note[^"]*" role="status">\{w\.progressUnknown\}<\/p>/);
});

test("the data copy reads the lessons done with no fallback, so an unknown read fails the copy", () => {
  const copy = readFileSync("lib/person-copy.ts", "utf8");
  assert.match(copy, /doneLessons\(c\.courseId, s\.email\)\]\);/);
  assert.doesNotMatch(copy, /doneLessons\([^)]*\)\.catch/);
});

// courseProgress (a workflow's condition on a course, lib/flows.ts; the sample in app/api/store/mail/route.ts) reads the
// students' rows and their lessons done in one round trip. An unknown answer used to read as "not started" or "not
// finished", so a student who finished could be sent the "hasn't finished" email on a guess (Claude 2 on #3202). Now
// it throws UnknownReplyError: the workflow step is put back for a later run (lib/flows.ts), nothing is sent.
const OTHER = "other@example.com";

/** The one course-progress pipeline (HMGET then SMEMBERS) answers `reply(real)`; everything else reaches the stand-in Redis. */
function progressReadAnswers(reply: (real: unknown[]) => unknown): void {
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "HMGET" && commands[1]?.[0] === "SMEMBERS") return reply(await realPipeline(commands)) as unknown[];
    return realPipeline(commands);
  };
}

const PROGRESS_MALFORMED: [string, (real: unknown[]) => unknown][] = [
  ["a missing envelope", () => []],
  ["one reply short", (real) => real.slice(0, -1)],
  ["one reply too many", (real) => [...real, []]],
  ["a null in place of the students' rows", (real) => [null, ...real.slice(1)]],
  ["students' rows one short", (real) => [(real[0] as unknown[]).slice(0, -1), ...real.slice(1)]],
  ["a number in a student's row", (real) => [[7, null], ...real.slice(1)]],
  ["a null in place of the lessons done", (real) => [real[0], null, real[2]]],
  ["a text in place of the lessons done", (real) => [real[0], "lesson", real[2]]],
  ["a list of lessons holding a number", (real) => [real[0], [7], real[2]]],
];

for (const [label, reply] of PROGRESS_MALFORMED) {
  test(`courseProgress: ${label} is unknown, never "not started" or "not finished"`, async () => {
    const w = await world(`cp${PROGRESS_MALFORMED.findIndex(([l]) => l === label)}reader`);
    await touchStudent(w.courseId, BUYER, Math.floor(Date.now() / 1000) - 60, w.store);
    await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
    progressReadAnswers(reply);
    await assert.rejects(() => courseProgress(w.store, w.productId, [BUYER, OTHER]), UnknownReplyError);
  });
}

test("courseProgress control: a finished student reads finished, one never seen reads not started and not finished", async () => {
  const w = await world("cpcontrol");
  const before = await courseProgress(w.store, w.productId, [BUYER, OTHER]);
  assert.deepEqual(before.get(BUYER), { started: false, finished: false });
  await touchStudent(w.courseId, BUYER, Math.floor(Date.now() / 1000) - 60, w.store);
  await markLesson(w.courseId, BUYER, w.lessonId, true, w.store);
  const after = await courseProgress(w.store, w.productId, [BUYER, OTHER]);
  assert.deepEqual(after.get(BUYER), { started: true, finished: true });
  assert.deepEqual(after.get(OTHER), { started: false, finished: false });
});
