/**
 * A student's hand-in (app/api/store/course/task/route.ts, POST) when handIn
 * (lib/assignment.ts) fails after the file took its room (CX-123 rule 24,
 * money audit rule 24 of Claude 6). The route used to give the file's bytes
 * back on ANY failure of handIn and delete the file only on DataRoomError.
 * Two ways that leaves a file in the store counted nowhere:
 *
 * - handIn failed AFTER its write (the write's answer lost, or a step after
 *   it, like marking the lesson passed, failing): the work and the files' hash
 *   keep the file, but its bytes were given back. The room says less than the
 *   store keeps, and when the file is later replaced or its assignment
 *   dropped, its bytes are given back a second time.
 * - handIn failed BEFORE its write with an ordinary error (the data room could
 *   not be counted): the bytes were given back but the file stayed in the
 *   file store, its door already taken, so no sweep ever finds it.
 *
 * The invariant held here: every file of this student still in the file store
 * is counted in the store's task room (the bytes counter is at least their
 * size). A failure before the write deletes the file and gives its bytes back;
 * a failure once the write was sent keeps both, which only refuses sooner.
 *
 * Real route, Redis on tests/redis-stub.ts, files in tests/buyer-actions-blob.ts,
 * next/headers from tests/security/next-headers.ts (tests/test-config.mjs).
 * Nothing real is reached.
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
  await recordEnrollment(store, BUYER, productId, Math.floor(Date.now() / 1000) - 60, "stripe");
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

async function counted(w: World): Promise<number> {
  const [used] = await realPipeline([["GET", `nl:tasks:bytes:${w.room}`]]);
  return Number(used ?? 0);
}

/** Every file of this student still in the file store is counted in the store's room (each stand-in file weighs 1,000 bytes). */
async function everyKeptFileCounted(w: World, label: string): Promise<void> {
  const kept = [...files].filter((p) => p.startsWith(w.folder) && !deleted.includes(p));
  assert.ok((await counted(w)) >= kept.length * 1000, `${label}: ${kept.length} file(s) kept in the file store, ${await counted(w)} bytes counted`);
}

/** The pipeline whose first command matches is answered by `answer`; every other one reaches the stand-in Redis. */
function failing(match: (command: (string | number)[]) => boolean, answer: (commands: (string | number)[][]) => Promise<unknown[]>): { calls: number } {
  const seen = { calls: 0 };
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0] && match(commands[0])) {
      seen.calls += 1;
      return answer(commands);
    }
    return realPipeline(commands);
  };
  return seen;
}

/** The data-room script (lib/store-data.ts, TAKE_DATA) taking room for this course's assignment records, as handIn does before its write. */
const takesWorkRoom = (w: World) => (command: (string | number)[]) =>
  command[0] === "EVAL" && String(command[3]).startsWith("nl:data:") && command.includes(`ca:${w.courseId}`);

const isWrite = (w: World) => (command: (string | number)[]) => command[0] === "SET" && command[1] === `nl:course:${w.courseId}:task:${w.lessonId}:sub:${emailKey(BUYER)}`;

test("control: a hand-in that goes through keeps its file and counts its bytes", async () => {
  const w = await world("handinkeptok", true);
  const path = await uploaded(w);
  const result = await handIn(w, path);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, path);
  assert.equal(await counted(w), 1000);
  await everyKeptFileCounted(w, "control");
});

test("the work's write reached Redis but its answer was lost: the kept file stays counted", async () => {
  const w = await world("handinlostans", true);
  const path = await uploaded(w);
  const seen = failing(isWrite(w), async (commands) => {
    await realPipeline(commands);
    throw new Error("Redis request failed with status 502");
  });
  const result = await handIn(w, path);
  redis.pipeline = realPipeline;
  assert.equal(seen.calls, 1, "the write was sent once");
  assert.equal(result.status, 500);
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, path, "the work was kept with its file");
  assert.equal(await counted(w), 1000, "so its bytes stay in the store's room, never given back while the work keeps it");
  await everyKeptFileCounted(w, "answer lost");
});

test("the work's write never reached Redis: no file is left in the file store uncounted", async () => {
  const w = await world("handinnowrite", true);
  const path = await uploaded(w);
  failing(isWrite(w), async () => {
    throw new Error("Redis request failed with status 502");
  });
  const result = await handIn(w, path);
  redis.pipeline = realPipeline;
  assert.equal(result.status, 500);
  await everyKeptFileCounted(w, "write failed");
});

test("the data room could not be counted before the write: the file is deleted and its bytes given back", async () => {
  const w = await world("handinroomerr", true);
  const path = await uploaded(w);
  // The store's data room (lib/store-data.ts) is read before the work is written; its read fails as an ordinary error.
  failing(takesWorkRoom(w), async () => {
    throw new Error("Redis request failed with status 502");
  });
  const result = await handIn(w, path);
  redis.pipeline = realPipeline;
  assert.equal(result.status, 500, JSON.stringify(result.body));
  assert.equal(await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)), null, "nothing was handed in");
  assert.ok(deleted.includes(path), "the file sent is deleted, never left in the file store with its door spent");
  assert.equal(await counted(w), 0, "and its bytes come back");
  await everyKeptFileCounted(w, "room unread");
});

test("a lesson nobody reads: marking it passed fails after the write, and the kept file stays counted", async () => {
  const w = await world("handinpassfail", false);
  const path = await uploaded(w);
  failing(
    (command) => command[0] === "SADD" && String(command[1]).startsWith(`nl:course:${w.courseId}:passed:`),
    async () => {
      throw new Error("Redis request failed with status 502");
    },
  );
  const result = await handIn(w, path);
  redis.pipeline = realPipeline;
  assert.equal(result.status, 500);
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, path, "the work was kept with its file");
  assert.equal(await counted(w), 1000, "its bytes stay counted");
  await everyKeptFileCounted(w, "passed mark failed");
});

test("a hand-in after a failed one that kept its file: replacing it gives its bytes back once, never below what is kept", async () => {
  const w = await world("handinreplace", true);
  const first = await uploaded(w);
  failing(isWrite(w), async (commands) => {
    await realPipeline(commands);
    throw new Error("Redis request failed with status 502");
  });
  assert.equal((await handIn(w, first)).status, 500);
  redis.pipeline = realPipeline;
  const second = await uploaded(w);
  const result = await handIn(w, second);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, second);
  assert.equal(await counted(w), 1000, "the new file is counted, the replaced one given back once");
  await everyKeptFileCounted(w, "after replacing");
});

test("handing the same file in again into a full data room: the file the earlier work keeps is never deleted", async () => {
  const w = await world("handinsamefull", true);
  const path = await uploaded(w);
  assert.equal((await handIn(w, path)).status, 200);
  // The second hand-in keeps the same file with a longer answer; the store's data room answers "full" (DataRoomError).
  failing(takesWorkRoom(w), async () => [[0, 999_999_999]]);
  const request = new Request(`https://${HOST}/api/store/course/task`, {
    method: "POST",
    headers: { "content-type": "application/json", host: HOST, origin: `https://${HOST}`, cookie: w.cookie },
    body: JSON.stringify({ handle: w.store.handle, product: w.productId, lesson: w.lessonId, text: "My second, much longer go. ".repeat(40), file: { path, name: "work.jpg" } }),
  });
  answering(request);
  const response = await POST(request as unknown as NextRequest);
  redis.pipeline = realPipeline;
  assert.equal(response.status, 409, "the store's data room is full");
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, path, "the earlier work still holds its file");
  assert.ok(!deleted.includes(path), "so that file is not deleted");
  assert.equal(await counted(w), 1000, "and its bytes stay counted");
  await everyKeptFileCounted(w, "same file, full room");
});

test("the data room could not be counted and the file cannot be deleted either: it stays counted while it is in the file store", async () => {
  const w = await world("handindelfail", true);
  const path = await uploaded(w);
  failing(takesWorkRoom(w), async () => {
    throw new Error("Redis request failed with status 502");
  });
  setFailDeletes(true);
  const result = await handIn(w, path);
  redis.pipeline = realPipeline;
  assert.equal(result.status, 500, JSON.stringify(result.body));
  assert.equal(await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)), null, "nothing was handed in");
  assert.ok(files.has(path), "the file is still in the file store");
  assert.equal(await counted(w), 1000, "so its bytes are not given back");
  await everyKeptFileCounted(w, "delete failed");
});
