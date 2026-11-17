/**
 * Outage drill (Claude 7, 14 November 2026; synthetic only): a student's hand-in takes its upload off the daily
 * sweep list (takeTaskUpload) before it is checked. When the hand-in is then refused (wrong type, room full) and the
 * file store's delete fails, or the file store does not answer the check at all, the student's file must go back on
 * the sweep list: never left in the store with nothing pointing at it, uncounted and never erased.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { blobState, files } from "./task-upload-orphan-blob";
import { POST } from "@/app/api/store/course/task/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment, storeKey } from "@/lib/learn";
import { noteTaskUpload, saveTask, sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { taskFolder } from "@/lib/assignment-rules";

const HOST = "marktmorgen.test";
const BUYER = "student@example.com";
const realPipeline = redis.pipeline.bind(redis);
const realFetch = globalThis.fetch;

type World = { store: Store; productId: string; courseId: string; lessonId: string; cookie: string; path: string; room: string };

beforeEach(() => {
  redis.clear();
  redis.pipeline = realPipeline;
  files.clear();
  Object.assign(blobState, { failDeletes: false, failHeads: false, contentType: "image/jpeg" });
  // Nothing outside is reached: the creator's "work to read" email and any Stripe read fail here, and are caught by the code.
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
});

afterEach(() => {
  redis.pipeline = realPipeline;
  globalThis.fetch = realFetch;
  answering(null);
});

/** A paying store selling one course whose first lesson takes a file, a buyer enrolled in it, and a file uploaded through the door. */
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
  const withTask = editCourse(course, { op: "task", lessonId, task: { review: true, gate: false, file: true } });
  assert.ok(withTask.ok);
  course = withTask.course;
  assert.ok((await setProductCourse(owner, productId, { id: course.id, lessons: 1 })).ok);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await saveTask(course.id, lessonId, { prompt: "Write your opening paragraph.", review: true, gate: false, file: true }, store);
  assert.ok((await readProduct(store, productId))?.course, "the product carries the course");

  // The buyer bought it, and this browser holds the buyer's pass.
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60);
  const token = await mintPass(store, BUYER, "all");
  const cookie = `${passCookieName(store)}=${token}`;

  // What the upload route leaves behind: a fresh name in the student's own folder, its door noted, the file stored.
  const folder = taskFolder(await storeFolder(storeRef(store)), course.id, lessonId, emailKey(BUYER));
  const path = `${folder}${randomBytes(16).toString("hex")}.jpg`;
  await noteTaskUpload(path);
  files.add(path);
  return { store, productId, courseId: course.id, lessonId, cookie, path, room: storeKey(store) };
}

/** The hand-in, as the lesson page sends it. */
async function handIn(w: World): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  const request = new Request(`https://${HOST}/api/store/course/task`, {
    method: "POST",
    headers: { "content-type": "application/json", host: HOST, origin: `https://${HOST}`, cookie: w.cookie },
    body: JSON.stringify({ handle: w.store.handle, product: w.productId, lesson: w.lessonId, text: "My first go.", file: { path: w.path, name: "work.jpg" } }),
  });
  answering(request);
  const response = await POST(request as unknown as NextRequest);
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string } };
}


/** Whether the daily sweep, run two days on, deletes the file. */
async function sweptLater(path: string): Promise<boolean> {
  const swept = await sweepTaskUploads(deleteFile, Date.now() + 3 * 86_400_000);
  return swept.includes(path) && !files.has(path);
}

test("a hand-in refused as the room is full, whose delete fails, leaves the file to the daily sweep", async () => {
  const w = await world("orphanfull");
  const { taskRoomFor } = await import("@/lib/assignment-rules");
  await realPipeline([["SET", `nl:tasks:bytes:${w.room}`, taskRoomFor(w.store) - 500]]);
  blobState.failDeletes = true;
  const result = await handIn(w);
  blobState.failDeletes = false;
  assert.equal(result.body.error, "full");
  assert.ok(files.has(w.path), "the delete failed: the file is still there");
  assert.ok(await sweptLater(w.path), "the daily sweep deletes it");
});

test("a hand-in refused for its type, whose delete fails, leaves the file to the daily sweep", async () => {
  const w = await world("orphantype");
  blobState.contentType = "text/html";
  blobState.failDeletes = true;
  const result = await handIn(w);
  blobState.failDeletes = false;
  assert.equal(result.body.error, "type");
  assert.ok(await sweptLater(w.path), "the daily sweep deletes it");
});

test("a hand-in whose file the store does not answer for leaves it to the daily sweep", async () => {
  const w = await world("orphanhead");
  blobState.failHeads = true;
  const result = await handIn(w);
  blobState.failHeads = false;
  assert.equal(result.body.ok, false);
  assert.ok(files.has(w.path), "nothing was deleted");
  assert.ok(await sweptLater(w.path), "the daily sweep deletes it");
});

test("a hand-in that goes through keeps its file off the sweep", async () => {
  const w = await world("orphanok");
  const result = await handIn(w);
  assert.equal(result.body.ok, true);
  assert.equal(await sweptLater(w.path), false);
  assert.ok(files.has(w.path), "the handed-in file is kept");
});
