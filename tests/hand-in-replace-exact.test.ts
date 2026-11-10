/**
 * A student's hand-in that replaces an earlier file (app/api/store/course/task/route.ts, POST; handIn in
 * lib/assignment.ts) gives that file's room back exactly once, and only once the file is gone from storage
 * (CX-123 rule 24, money audit rule 24 of Claude 6, follow-up to #3088). Two ways it did not:
 *
 * - The replaced file's delete failed: the error was only logged and its bytes were given back anyway, so a file
 *   the store still keeps was counted nowhere (storage nobody pays for).
 * - Two hand-ins of the same student on the same lesson at once each read the same earlier work, so each answered
 *   that earlier file as the one it replaced: its bytes were given back twice, and the file one of them handed in
 *   stayed in storage and in the lesson's files with no work keeping it.
 *
 * The invariant held here: the bytes counted for the store's task room are exactly the bytes of this student's files
 * still in the file store (each stand-in file weighs 1,000 bytes), and the work keeps one current file.
 *
 * Real route, Redis on tests/redis-stub.ts, files in tests/buyer-actions-blob.ts, next/headers from
 * tests/security/next-headers.ts (tests/test-config.mjs). Nothing real is reached.
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
  setFailDeletes(false);
  globalThis.fetch = realFetch;
  answering(null);
});

/** A paying store selling one course whose lesson takes a file, a buyer enrolled in it. */
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

/** This student's files still in the file store. */
const keptFiles = (w: World) => [...files].filter((p) => p.startsWith(w.folder));

async function lessonFiles(w: World): Promise<string[]> {
  const [keys] = await realPipeline([["HKEYS", `nl:course:${w.courseId}:task:${w.lessonId}:files`]]);
  return (Array.isArray(keys) ? keys.map(String) : []).sort();
}

for (const review of [true, false]) {
  const how = review ? "read by the creator" : "done at once";

  test(`the replaced file's delete failed (${how}): its room stays counted, never given back while it is kept`, async () => {
    const w = await world(review ? "replfailrev" : "replfailnow", review);
    const first = await uploaded(w);
    assert.equal((await handIn(w, first)).status, 200);
    assert.equal(await counted(w), 1000);

    const second = await uploaded(w);
    setFailDeletes(true);
    const result = await handIn(w, second);
    setFailDeletes(false);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path, second, "the new work keeps the new file");
    assert.ok(files.has(first), "the earlier file is still in the file store (its delete failed)");
    assert.ok(!deleted.includes(first), "the earlier file is not reported deleted");
    assert.equal(await counted(w), keptFiles(w).length * 1000, `both files kept in storage stay counted: ${keptFiles(w).length} kept, ${await counted(w)} bytes counted`);
  });

  test(`two hand-ins at once over an earlier file (${how}): its room is given back once, and one current file is kept`, async () => {
    const w = await world(review ? "replracerev" : "replracenow", review);
    const earlier = await uploaded(w);
    assert.equal((await handIn(w, earlier)).status, 200);
    assert.equal(await counted(w), 1000);

    const a = await uploaded(w);
    const b = await uploaded(w);
    // The first write of the work waits until the other hand-in has read the work twice (in the route and in handIn),
    // or half a second: without one hand-in at a time, both read the earlier work before either writes.
    const sub = `nl:course:${w.courseId}:task:${w.lessonId}:sub:${emailKey(BUYER)}`;
    let reads = 0;
    let gated = false;
    redis.pipeline = async (commands: (string | number)[][]) => {
      const first = commands[0];
      if (first?.[0] === "GET" && first[1] === sub) reads += 1;
      if (first?.[0] === "SET" && first[1] === sub && !gated) {
        gated = true;
        const from = reads;
        for (const until = Date.now() + 500; reads < from + 2 && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return realPipeline(commands);
    };
    const results = await Promise.all([handIn(w, a), handIn(w, b)]);
    redis.pipeline = realPipeline;
    for (const r of results) assert.ok(r.status === 200 || r.body.ok === false, `each hand-in is kept or refused: ${JSON.stringify(r)}`);
    assert.ok(results.some((r) => r.status === 200), `at least one hand-in went through: ${JSON.stringify(results)}`);

    const current = (await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)))?.file?.path;
    assert.ok(current === a || current === b, "the work keeps one of the two new files");
    assert.equal(deleted.filter((p) => p === earlier).length, 1, "the earlier file is deleted exactly once");
    assert.deepEqual(keptFiles(w), [current], `only the current file stays in the file store: ${keptFiles(w).length} kept`);
    assert.equal(await counted(w), 1000, `exactly the current file's bytes are counted (${await counted(w)})`);
    assert.deepEqual(await lessonFiles(w), [current], "the lesson's files list only the current file");
  });
}
