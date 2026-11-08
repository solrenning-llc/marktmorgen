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
import { doneLessons, markLesson, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
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
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60);
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
  assert.equal(await response.text(), COURSES_WORDS.en.progressUnknown);
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
  }
  assert.equal(COURSES_WORDS.en.progressUnknown, "We could not check your progress just now. Your lessons are all here. Reload the page to try again.");
});

test("the course's front door says the progress is unknown, never 0 of N done", () => {
  const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
  assert.match(page, /catch \(error\) \{\s*if \(error instanceof UnknownReplyError\) return null;/);
  assert.match(page, /done === null \? \(\s*<p className="st-note[^"]*" role="status">\{w\.progressUnknown\}<\/p>/);
  assert.match(page, /\{w\.certProgressUnknown\}/);
});

test("a lesson page says the progress is unknown and offers no done/not-done toggle on a guess", () => {
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  assert.match(page, /catch \(error\) \{\s*if \(error instanceof UnknownReplyError\) return null;/);
  assert.match(page, /done === null \? \(\s*<p className="st-note[^"]*" role="status">\{w\.progressUnknown\}<\/p>/);
});

test("the data copy reads the lessons done with no fallback, so an unknown read fails the copy", () => {
  const copy = readFileSync("lib/person-copy.ts", "utf8");
  assert.match(copy, /doneLessons\(c\.courseId, s\.email\)\]\);/);
  assert.doesNotMatch(copy, /doneLessons\([^)]*\)\.catch/);
});
