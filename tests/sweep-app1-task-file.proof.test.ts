/**
 * Sweep app1 proof (CX-123 rule 24), synthetic only. A student's hand-in, app/api/store/course/task/route.ts:80-83:
 *   if (!ownsTaskPath(asked.path, folder) || !(await takeTaskUpload(asked.path))) return no("invalid");
 *   const found = await headFile(path).catch(() => null);
 *   if (!found) return no("missing");
 * takeTaskUpload (lib/assignment.ts:397-399) has already taken the upload's door off the list (ZREM) when the file
 * store is asked what was uploaded. A file-store call that fails for any reason (a timeout, a 5xx) is read as "the
 * file is not there": the student is told "missing", the file is not deleted, its bytes are not counted in the
 * store's room, and because its door is gone the daily cleanup (staleTaskUploads, lib/assignment.ts:407-414) never
 * lists it. The file stays in the paid file store for good, counted nowhere. The route's own comment a few lines
 * below says a file sent is "never left in the store unaccounted for".
 * The real route is called as tests/task-room-unknown.test.ts calls it (the same world); the file store is
 * tests/buyer-actions-blob.ts and next/headers is tests/security/next-headers.ts (tests/test-config.mjs).
 */
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { deleted, files } from "./buyer-actions-blob";
import { done, is, part } from "./check";
import { POST } from "@/app/api/store/course/task/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment, storeKey } from "@/lib/learn";
import { DOOR_SECONDS, noteTaskUpload, saveTask, staleTaskUploads, submissionOf } from "@/lib/assignment";
import { taskFolder } from "@/lib/assignment-rules";

const HOST = "marktmorgen.test";
const BUYER = "student@example.com";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

type World = { store: Store; productId: string; courseId: string; lessonId: string; cookie: string; folder: string };

async function world(handle: string): Promise<World> {
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, "School", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Writing course", "Learn to write", "49", null);
  if (!made.ok) throw new Error("no product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "Opening" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  const lessonId = course.modules[0].lessons[0].id;
  const withTask = editCourse(course, { op: "task", lessonId, task: { review: true, gate: false, file: true } });
  if (!withTask.ok) throw new Error("no task");
  course = withTask.course;
  await setProductCourse(owner, made.product.id, { id: course.id, lessons: 1 });
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await saveTask(course.id, lessonId, { prompt: "Write your opening paragraph.", review: true, gate: false, file: true }, store);
  await recordEnrollment(store, BUYER, made.product.id, Math.floor(Date.now() / 1000) - 60);
  const cookie = `${passCookieName(store)}=${await mintPass(store, BUYER, "all")}`;
  const folder = taskFolder(await storeFolder(storeRef(store)), course.id, lessonId, emailKey(BUYER));
  return { store, productId: made.product.id, courseId: course.id, lessonId, cookie, folder };
}

/** What the upload route leaves behind: a fresh name in the student's folder, its door noted, the file stored. */
async function uploaded(w: World): Promise<string> {
  const path = `${w.folder}${randomBytes(16).toString("hex")}.jpg`;
  await noteTaskUpload(path);
  files.add(path);
  return path;
}

async function handIn(w: World, path: string): Promise<{ status: number; error?: string }> {
  const request = new Request(`https://${HOST}/api/store/course/task`, {
    method: "POST",
    headers: { "content-type": "application/json", host: HOST, origin: `https://${HOST}`, cookie: w.cookie },
    body: JSON.stringify({ handle: w.store.handle, product: w.productId, lesson: w.lessonId, text: "My first go.", file: { path, name: "work.jpg" } }),
  });
  answering(request);
  const response = await POST(request as unknown as NextRequest);
  answering(null);
  const body = (await response.json()) as { error?: string };
  return { status: response.status, error: body.error };
}

const roomUsed = async (w: World) => Number((await redis.pipeline([["GET", `nl:tasks:bytes:${storeKey(w.store)}`]]))[0] ?? 0);
const later = Date.now() + (DOOR_SECONDS + 3_600) * 1000;

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  deleted.length = 0;

  part("Healthy control: the file store answers, the work is handed in and counted");
  const ok = await world("taskfileok");
  const kept = await uploaded(ok);
  is("200", (await handIn(ok, kept)).status, 200);
  is("handed in with its file", (await submissionOf(ok.courseId, ok.lessonId, emailKey(BUYER)))?.file?.path, kept);
  is("its bytes counted in the store's room", await roomUsed(ok), 1000);

  part("Healthy control: a file uploaded and never handed in is collected by the daily cleanup");
  const left = await uploaded(ok);
  is("its door is listed after a day", (await staleTaskUploads(later)).includes(left), true);

  part("DEFECT: the file store's answer fails (a timeout) while the file is there");
  const w = await world("taskfilebad");
  const path = await uploaded(w);
  const realHas = files.has.bind(files);
  files.has = ((p: string) => {
    if (p === path) throw new Error("Synthetic file-store timeout");
    return realHas(p);
  }) as typeof files.has;
  const result = await handIn(w, path);
  files.has = realHas;
  is("DEFECT: the student is told the file is missing", [result.status, result.error], [400, "missing"]);
  is("DEFECT: the file is still in the paid file store", files.has(path), true);
  is("DEFECT: it was not deleted", deleted.includes(path), false);
  is("DEFECT: its bytes are counted nowhere", await roomUsed(w), 0);
  is("DEFECT: nothing was handed in", await submissionOf(w.courseId, w.lessonId, emailKey(BUYER)), null);
  is("DEFECT: its door is gone, so the daily cleanup never lists it", (await staleTaskUploads(later)).includes(path), false);
  is("DEFECT: and the student's next try with the same file is refused as not theirs", (await handIn(w, path)).error, "invalid");
  done();
}
main();
