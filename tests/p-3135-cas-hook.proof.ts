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

test("expired holder alone: files that remain stored remain counted", async () => {
 const w=await world("leasealone",true), first=await uploaded(w);
 assert.equal((await handIn(w,first)).status,200);
 const next=await uploaded(w);let advanced=false;
 redis.pipeline=async commands=>{if(((commands[0]?.[0]==="SET"&&String(commands[0][1]).includes(":sub:"))||(commands[0]?.[0]==="EVAL"&&String(commands[0][3]).includes(":sub:")))&&!advanced){advanced=true;redis.advance(61_000)}return realPipeline(commands)};
 const result=await handIn(w,next);redis.pipeline=realPipeline;
 assert.ok(result.status===200||result.body.ok===false);
 assert.ok((await counted(w))>=keptFiles(w).length*1000);
});

test("a holder paused beyond its lease must not overwrite its successor and credit the earlier file twice",async()=>{
 const w=await world("leasesuccessor",true), earlier=await uploaded(w);
 assert.equal((await handIn(w,earlier)).status,200);
 const a=await uploaded(w),b=await uploaded(w);
 const sub=`nl:course:${w.courseId}:task:${w.lessonId}:sub:${emailKey(BUYER)}`;
 let signal!:()=>void, resume!:()=>void;
 const paused=new Promise<void>(r=>{signal=r}), gate=new Promise<void>(r=>{resume=r});let first=true;
 redis.pipeline=async commands=>{
  if(((commands[0]?.[0]==="SET"&&commands[0][1]===sub)||(commands[0]?.[0]==="EVAL"&&commands[0][3]===sub))&&first){first=false;signal();await gate}
  return realPipeline(commands);
 };
 const pending=handIn(w,a);await paused;
 // Simulate an overdue function/transport without spending 61 seconds of wall time.
 // MemoryRedis really expires its lease; no lock GET/SET answer is forged.
 redis.advance(61_000);
 const successor=await handIn(w,b);resume();const overdue=await pending;
 redis.pipeline=realPipeline;
 const current=(await submissionOf(w.courseId,w.lessonId,emailKey(BUYER)))?.file?.path;
 const kept=keptFiles(w), used=await counted(w), deletions=deleted.filter(p=>p===earlier).length;
 console.log("expired lease observation",JSON.stringify({overdue:overdue.status,successor:successor.status,kept:kept.length,used,deletions,currentIsOverdue:current===a,currentIsSuccessor:current===b}));
 assert.ok(used>=kept.length*1000,`${kept.length} files still stored but only ${used} bytes counted`);
});
