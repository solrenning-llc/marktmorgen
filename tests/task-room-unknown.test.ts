/**
 * A student's hand-in (app/api/store/course/task/route.ts, POST) when the
 * room counter for students' files answers in a shape nobody knows (audit
 * SG2, CX-123 rule 24). takeRoom (lib/assignment.ts) throws UnknownReplyError
 * then, and the file the student uploaded must be deleted before the error
 * goes on: otherwise it stays in the file store, counted nowhere.
 *
 * The real route is called as an enrolled buyer calls it: a paying store, a
 * course product with a lesson that takes a file, a buyer let in by a learner
 * pass, the door noted as the upload route notes it (noteTaskUpload) and the
 * file put in the stand-in file store (tests/buyer-actions-blob.ts). Redis is
 * tests/redis-stub.ts; only the one pipeline that adds to the store's room
 * (INCRBY on its bytes counter, with the file's mark) is answered in an
 * unknown shape or fails. Where it really ran and only its answer was lost,
 * the bytes come back through the file's mark (undoTakeRoom); where it never
 * ran, nothing is given back.
 * next/headers is tests/security/next-headers.ts, wired for this file alone
 * in tests/test-config.mjs. Nothing real is reached.
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
import { readProduct } from "@/lib/catalog";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment, storeKey } from "@/lib/learn";
import { noteTaskUpload, saveTask, submissionOf, undoTakeRoom } from "@/lib/assignment";
import { taskFolder } from "@/lib/assignment-rules";
import { UnknownReplyError } from "@/lib/redis-reply";

const HOST = "marktmorgen.test";
const BUYER = "student@example.com";
const realPipeline = redis.pipeline.bind(redis);
const realFetch = globalThis.fetch;

type World = { store: Store; productId: string; courseId: string; lessonId: string; cookie: string; path: string; room: string };

beforeEach(() => {
  redis.clear();
  redis.pipeline = realPipeline;
  files.clear();
  deleted.length = 0;
  setFailDeletes(false);
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

/** Only the pipeline that adds to this store's room is answered otherwise; every other command reaches the stand-in Redis. */
function roomCounterAnswers(room: string, answer: () => Promise<unknown[]>): { calls: number } {
  const seen = { calls: 0 };
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "INCRBY" && commands[0][1] === `nl:tasks:bytes:${room}`) {
      seen.calls += 1;
      return answer();
    }
    return realPipeline(commands);
  };
  return seen;
}

test("control: with the room counter answering as Redis does, the file is handed in and kept", async () => {
  const w = await world("taskroomok");
  const result = await handIn(w);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.ok(files.has(w.path), "the file stays in the store");
  assert.ok(!deleted.includes(w.path), "and is not deleted");
  assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, w.path, "the work is handed in with its file");
  const [used] = await realPipeline([["GET", `nl:tasks:bytes:${w.room}`]]);
  assert.equal(Number(used), 1000, "the file's bytes are counted in the store's room");
  const marks = redis.keys().filter((key) => key.startsWith("nl:tasks:taken:"));
  assert.equal(marks.length, 1, "the file's room is marked as taken");
  const [mark, ttl] = await realPipeline([["GET", marks[0]], ["TTL", marks[0]]]);
  assert.equal(mark, "1000", "with the bytes it took");
  assert.ok(typeof ttl === "number" && ttl > 0 && ttl <= 3_600, "for an hour at most");
});

/** Each answer, and whether takeRoom itself names it unknown (a failed call is passed on as it came). */
const UNKNOWN: [string, () => Promise<unknown[]>, boolean][] = [
  ["a null reply", async () => [null], true],
  ["a word for a count", async () => ["x"], true],
  ["no reply at all", async () => [], true],
  ["a count smaller than what was added", async () => [1], true],
  ["a failed call", async () => Promise.reject(new Error("the counter could not be reached")), false],
];

for (const [what, answer, named] of UNKNOWN) {
  test(`an unknown room reply (${what}) deletes the uploaded file and hands nothing in`, async () => {
    const w = await world(`taskroom${UNKNOWN.findIndex(([name]) => name === what)}`);
    const seen = roomCounterAnswers(w.room, answer);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    let result: Awaited<ReturnType<typeof handIn>>;
    try {
      result = await handIn(w);
    } finally {
      console.error = originalError;
    }
    assert.equal(seen.calls, 1, "the room counter was asked once");
    assert.notEqual(result.status, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, "server_error");
    assert.ok(deleted.includes(w.path), "the uploaded file is deleted");
    assert.ok(!files.has(w.path), "and is not left in the store");
    assert.equal(await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)), null, "nothing was handed in");
    const logged = errors.flat();
    assert.ok(logged.includes("handing in an assignment failed"), "the failure is logged by the route");
    if (named) assert.ok(logged.some((item) => item instanceof UnknownReplyError), "as the room counter's unknown reply");
  });
}

/** The room's total, as Redis holds it. */
async function roomTotal(room: string): Promise<number> {
  const [used] = await realPipeline([["GET", `nl:tasks:bytes:${room}`]]);
  return Number(used);
}

/** Runs the hand-in with console.error caught, and returns what was logged. */
async function quietly(w: World): Promise<{ result: Awaited<ReturnType<typeof handIn>>; logged: unknown[] }> {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    return { result: await handIn(w), logged: errors.flat() };
  } finally {
    console.error = originalError;
  }
}

test("a reply lost after the room was really taken: the file is deleted, and the bytes it took come back", async () => {
  const w = await world("taskroomlost");
  await realPipeline([["SET", `nl:tasks:bytes:${w.room}`, 5_000]]);
  // The pipeline runs in Redis for real; only its answer never comes back.
  const seen = { calls: 0 };
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "INCRBY" && commands[0][1] === `nl:tasks:bytes:${w.room}`) {
      seen.calls += 1;
      await realPipeline(commands);
      throw new Error("the answer was lost");
    }
    return realPipeline(commands);
  };
  const { result } = await quietly(w);
  assert.equal(seen.calls, 1);
  assert.equal(result.body.error, "server_error");
  assert.ok(deleted.includes(w.path) && !files.has(w.path), "the uploaded file is deleted");
  assert.equal(await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)), null, "nothing was handed in");
  assert.equal(await roomTotal(w.room), 5_000, "the room is what it was before");
  assert.deepEqual(redis.keys().filter((key) => key.startsWith("nl:tasks:taken:")), [], "and the file's mark is gone");
  redis.pipeline = realPipeline;
  assert.equal(await undoTakeRoom(w.room, 1_000, w.path), false, "a second giving back finds no mark");
  assert.equal(await roomTotal(w.room), 5_000, "and gives nothing back twice");
});

test("a reply lost before the room was taken: nothing is given back that never entered", async () => {
  const w = await world("taskroomnotrun");
  await realPipeline([["SET", `nl:tasks:bytes:${w.room}`, 5_000]]);
  const seen = roomCounterAnswers(w.room, async () => Promise.reject(new Error("never reached Redis")));
  const { result } = await quietly(w);
  assert.equal(seen.calls, 1);
  assert.equal(result.body.error, "server_error");
  assert.ok(deleted.includes(w.path), "the uploaded file is deleted");
  assert.equal(await roomTotal(w.room), 5_000, "the room is not given bytes it never took");
});

test("a lost reply whose giving back also fails: the route still answers, the file is deleted, the room only refuses sooner", async () => {
  const w = await world("taskroomundo");
  await realPipeline([["SET", `nl:tasks:bytes:${w.room}`, 5_000]]);
  let dels = 0;
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "INCRBY" && commands[0][1] === `nl:tasks:bytes:${w.room}`) {
      await realPipeline(commands);
      throw new Error("the answer was lost");
    }
    if (commands[0]?.[0] === "DEL" && String(commands[0][1]).startsWith("nl:tasks:taken:")) {
      dels += 1;
      throw new Error("the giving back was lost too");
    }
    return realPipeline(commands);
  };
  const { result, logged } = await quietly(w);
  assert.equal(dels, 1, "the room was asked to give the bytes back once");
  assert.equal(result.body.error, "server_error");
  assert.ok(deleted.includes(w.path) && !files.has(w.path), "the uploaded file is deleted");
  assert.equal(await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)), null, "nothing was handed in");
  assert.equal(await roomTotal(w.room), 6_000, "the bytes stay counted: the room refuses sooner, never later");
  assert.ok(logged.includes("giving back a task file's room failed"), "the failed giving back is logged");
});

test("a full room: refused as before, nothing kept, no mark left", async () => {
  const w = await world("taskroomfull");
  const { taskRoomFor } = await import("@/lib/assignment-rules");
  const limit = taskRoomFor(w.store);
  await realPipeline([["SET", `nl:tasks:bytes:${w.room}`, limit - 500]]);
  const result = await handIn(w);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "full");
  assert.ok(deleted.includes(w.path), "the uploaded file is deleted");
  assert.equal(await roomTotal(w.room), limit - 500, "the room is what it was");
  assert.deepEqual(redis.keys().filter((key) => key.startsWith("nl:tasks:taken:")), [], "and no mark is left");
});
