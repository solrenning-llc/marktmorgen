/**
 * A student's hand-in on a course kept for a child-safety report
 * (app/api/store/course/task/route.ts, lib/child-safety.ts,
 * C1-20261109-1546-TODOS-70): a new hand-in replaces, and deletes, the one
 * before, so a held course takes none (404, as a lesson that takes no work),
 * and a hold that cannot be read refuses it (503), never reads "not held".
 * Regression test asked by Claude 6's focal review of #3471 (review
 * 5831883701). A course not held still takes it.
 *
 * Nobody opens, downloads or describes reported content: the course and the
 * work are placeholders, the "files" names in a stand-in file store that are
 * never read. Real route, Redis on tests/redis-stub.ts, files in
 * tests/buyer-actions-blob.ts, next/headers from tests/security/next-headers.ts
 * (tests/test-config.mjs). Nothing real is reached.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { deleted, files, setFailDeletes } from "./buyer-actions-blob";
import { POST } from "@/app/api/store/course/task/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment, storeKey } from "@/lib/learn";
import { noteTaskUpload, saveTask, submissionOf } from "@/lib/assignment";
import { taskFolder } from "@/lib/assignment-rules";
import { holdReported } from "@/lib/child-safety";
import { keepKey } from "@/lib/child-safety-holds";

const HOST = "marktmorgen.test";
const BUYER = "student@example.com";
const realPipeline = redis.pipeline.bind(redis);
const realFetch = globalThis.fetch;

type World = { store: Store; productId: string; courseId: string; lessonId: string; cookie: string; folder: string; room: string };

beforeEach(() => {
  redis.clear();
  redis.pipeline = realPipeline;
  files.clear();
  deleted.length = 0;
  setFailDeletes(false);
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
});

afterEach(() => {
  redis.pipeline = realPipeline;
  globalThis.fetch = realFetch;
  answering(null);
});

/** A paying store selling one course whose lesson takes a file (read by the creator or not), a buyer enrolled in it. */
async function world(handle: string, review: boolean): Promise<World> {
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
  const withTask = editCourse(course, { op: "task", lessonId, task: { review, gate: false, file: true } });
  assert.ok(withTask.ok);
  course = withTask.course;
  assert.ok((await setProductCourse(owner, productId, { id: course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await saveTask(course.id, lessonId, { prompt: "Write your opening paragraph.", review, gate: false, file: true }, store);
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60);
  const token = await mintPass(store, BUYER, "all");
  const folder = taskFolder(await storeFolder(storeRef(store)), course.id, lessonId, emailKey(BUYER));
  return { store, productId, courseId: course.id, lessonId, cookie: `${passCookieName(store)}=${token}`, folder, room: storeKey(store) };
}

/** What the upload route leaves behind: a fresh name in the student's folder, its door noted, the file stored. */
async function uploaded(w: World): Promise<string> {
  const path = `${w.folder}${randomBytes(16).toString("hex")}.jpg`;
  await noteTaskUpload(path);
  files.add(path);
  return path;
}

async function handIn(w: World, path: string): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  const request = new Request(`https://${HOST}/api/store/course/task`, {
    method: "POST",
    headers: { "content-type": "application/json", host: HOST, origin: `https://${HOST}`, cookie: w.cookie },
    body: JSON.stringify({ handle: w.store.handle, product: w.productId, lesson: w.lessonId, text: "My go.", file: { path, name: "work.jpg" } }),
  });
  answering(request);
  const response = await POST(request as unknown as NextRequest);
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string } };
}

test("a course not held takes the hand-in", async () => {
  const w = await world("csahandinok", true);
  const path = await uploaded(w);
  const result = await handIn(w, path);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, path);
});

test("a course held for a report takes no new hand-in, and the one before stays as it was", async () => {
  const w = await world("csahandinheld", true);
  const first = await uploaded(w);
  assert.equal((await handIn(w, first)).status, 200);
  const outcome = await holdReported({ kind: "child_safety", url: `https://marktmorgen.com/@${w.store.handle}/p/${w.productId}` }, (await storeForEmail(`${w.store.handle}@example.com`))!);
  assert.equal(outcome, "held");
  const second = await uploaded(w);
  const result = await handIn(w, second);
  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.equal(result.body.error, "unknown");
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, first, "the hand-in before is kept");
  assert.ok(!deleted.includes(first), "its file was not deleted");
});

test("a hold that cannot be read refuses the hand-in (rule 24)", async () => {
  const w = await world("csahandinunread", true);
  await redis.pipeline([["SET", keepKey(w.store, w.productId), "garbled"]]);
  const result = await handIn(w, await uploaded(w));
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)), null);
});
