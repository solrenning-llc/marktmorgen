/**
 * Handing in an assignment file (app/api/store/course/task/route.ts) when the
 * file store cannot be asked about the file.
 *
 * The upload's door (lib/assignment.ts, takeTaskUpload) lets one uploaded
 * file be handed in once. A HEAD that could not be answered says nothing
 * about the file, so it must not spend that door, must not tell the student
 * the file is missing, and must leave the same file to hand in once the store
 * answers again. A HEAD that answered "not found" is still "missing". The
 * door still lets one path in once, however many requests race for it.
 *
 * Everything here is real: the route, its session cookie read through Next's
 * own cookies(), the Vercel Blob SDK through lib/blob.ts and lib/file-store.ts,
 * and the store's data on MemoryRedis. Only the far side of the wire is a
 * synthetic Blob API on 127.0.0.1, which answers, says "not found", or drops
 * the connection without answering.
 */
// What Next itself loads first in a server, so its request scope (AsyncLocalStorage) is the real one.
import "next/dist/server/node-environment-baseline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage, type WorkUnitStore } from "next/dist/server/app-render/work-unit-async-storage.external";
import { RequestCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { RequestCookiesAdapter } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { POST as handInRoute } from "@/app/api/store/course/task/route";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment, storeKey } from "@/lib/learn";
import { DOOR_SECONDS, noteTaskUpload, saveTask, submissionOf, sweepTaskUploads } from "@/lib/assignment";
import { taskFolder } from "@/lib/assignment-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// ------------------------------------------------------------ the far side

/** How the synthetic Blob API answers a HEAD (the SDK asks with a GET) for a path. */
type Mode = "answer" | "drop" | "missing";
const blobs = new Map<string, Mode>();
const heads: string[] = [];
const removed: string[] = [];

function blobApi(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  request.on("end", () => {
    if (request.method === "POST" && url.pathname.endsWith("/delete")) {
      const asked = (JSON.parse(body || "{}") as { urls?: string[] }).urls ?? [];
      for (const path of asked) {
        removed.push(path);
        blobs.delete(path);
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const path = url.searchParams.get("url") ?? "";
    heads.push(path);
    const mode = blobs.get(path) ?? "missing";
    // A connection dropped before any answer: the store could not be asked.
    if (mode === "drop") return void request.socket.destroy();
    if (mode === "missing") {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "The requested blob does not exist" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        url: `https://teststore0001.private.blob.vercel-storage.com/${path}`,
        downloadUrl: `https://teststore0001.private.blob.vercel-storage.com/${path}?download=1`,
        pathname: path,
        size: 1000,
        contentType: "image/jpeg",
        contentDisposition: 'attachment; filename="work.jpg"',
        cacheControl: "public, max-age=0",
        uploadedAt: new Date().toISOString(),
        etag: '"synthetic"',
      }),
    );
  });
}

// Stripe has nothing on record for this student (the pass is what lets them in), and mail is refused.
process.env.STRIPE_SECRET_KEY = "sk_test_task_head_first_only";
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (new URL(String(input instanceof Request ? input.url : input)).hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

// ------------------------------------------------------------ the near side

type Work = { store: Store; product: string; course: string; lesson: string; cookie: string; path: string };
const student = "student@example.test";

async function work(handle: string, letter: string): Promise<Work> {
  const owner = `${handle}@example.test`;
  const claimed = await claimHandle(owner, handle, "Hand-in shop", "");
  if (!claimed.ok) throw new Error("fixture could not claim store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TaskHeadFirst01", true);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Course", "A synthetic course", "19", null);
  if (!made.ok) throw new Error("fixture could not add product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "Opening" });
  if (!added.ok) throw new Error("fixture lesson");
  course = added.course;
  const lesson = course.modules[0].lessons[0].id;
  const tasked = editCourse(course, { op: "task", lessonId: lesson, task: { review: true, gate: false, file: true } });
  if (!tasked.ok) throw new Error("fixture task");
  course = tasked.course;
  const attached = await setProductCourse(owner, made.product.id, { id: course.id, lessons: 1 });
  if (!attached.ok) throw new Error(`fixture attach course: ${JSON.stringify(attached)}`);
  const store = (await storeForEmail(owner))!;
  await saveCourse(course, store);
  await saveTask(course.id, lesson, { prompt: "Write one paragraph", review: true, gate: false, file: true }, store);
  await recordEnrollment(store, student, made.product.id, Math.floor(Date.now() / 1000) - 60);
  const pass = await mintPass(store, student, "all");
  // The upload route's own steps for a file it let in: a fresh name in this student's folder, noted at the door.
  const path = `${taskFolder(await storeFolder(storeRef(store)), course.id, lesson, emailKey(student))}${letter.repeat(32)}.jpg`;
  await noteTaskUpload(path);
  return { store, product: made.product.id, course: course.id, lesson, cookie: `${passCookieName(store)}=${pass}`, path };
}

/** POSTs a hand-in to the real route, inside a request scope as Next gives a route handler one. */
async function handIn(w: Work): Promise<{ status: number; error?: string; ok: boolean }> {
  const request = new NextRequest("https://marktmorgen.test/api/store/course/task", {
    method: "POST",
    headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/json", cookie: w.cookie },
    body: JSON.stringify({ handle: w.store.handle, product: w.product, lesson: w.lesson, text: "My work", file: { path: w.path, name: "work.jpg" } }),
  });
  const workStore = { route: "/api/store/course/task", forceStatic: false, dynamicShouldError: false } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "render", cookies: RequestCookiesAdapter.seal(new RequestCookies(request.headers)) } as unknown as WorkUnitStore;
  const response = await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () => handInRoute(request)));
  const body = (await response.json()) as { ok: boolean; error?: string };
  return { status: response.status, error: body.error, ok: body.ok };
}

const door = async (path: string) => (await redis.pipeline([["ZSCORE", "nl:tasks:doors", path]]))[0] !== null;
const roomUsed = async (w: Work) => Number((await redis.pipeline([["GET", `nl:tasks:bytes:${storeKey(w.store)}`]]))[0] ?? 0);
const handedFile = async (w: Work) => (await submissionOf(w.course, w.lesson, emailKey(student)))?.file?.path ?? null;

async function main(): Promise<void> {
  const server = createServer(blobApi);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${port}/api/blob`;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore0001_syntheticSecretForTestsOnly";
  // A dropped connection is given up at once instead of tried ten times.
  process.env.VERCEL_BLOB_RETRIES = "0";

  try {
    part("Control: the store answers, the file is handed in");
    redis.clear();
    const healthy = await work("headfirstok", "a");
    blobs.set(healthy.path, "answer");
    const accepted = await handIn(healthy);
    is("a file the store measured is handed in", [accepted.status, accepted.ok], [200, true]);
    is("the submission keeps that file", await handedFile(healthy), healthy.path);
    is("its door is spent by the hand-in", await door(healthy.path), false);
    is("its bytes are counted once in what the store's students keep", await roomUsed(healthy), 1000);

    part("The store could not be asked: the door is kept and the answer is temporary");
    redis.clear();
    heads.length = 0;
    const outage = await work("headfirstdrop", "b");
    is("control: the upload's door is there before the hand-in", await door(outage.path), true);
    blobs.set(outage.path, "drop");
    const failed = await handIn(outage);
    is("the store was asked once", heads.filter((path) => path === outage.path).length, 1);
    is("an unanswered HEAD is a temporary error, not a confirmed missing file", [failed.status, failed.error], [503, "unavailable"]);
    is("an unanswered HEAD does not spend the upload's door", await door(outage.path), true);
    is("nothing was handed in and no room was taken", [await handedFile(outage), await roomUsed(outage)], [null, 0]);
    is("control: the stored file was neither deleted nor lost", [removed.includes(outage.path), blobs.has(outage.path)], [false, true]);
    blobs.set(outage.path, "answer");
    const retried = await handIn(outage);
    is("once the store answers, the same file is handed in", [retried.status, retried.ok, retried.error ?? null], [200, true, null]);
    is("the recovered hand-in keeps its file", await handedFile(outage), outage.path);
    is("the recovered hand-in spends the door", await door(outage.path), false);

    part("A file nobody handed in after an outage is still found by the cleanup sweep");
    redis.clear();
    const orphan = await work("headfirstsweep", "c");
    blobs.set(orphan.path, "drop");
    await handIn(orphan);
    // main replaced staleTaskUploads with sweepTaskUploads (b2d12e3a2): it answers the paths it won and deleted.
    const swept = await sweepTaskUploads(async () => {}, Date.now() + (DOOR_SECONDS + 60) * 1000);
    is("the sweep still finds the unused upload", swept.includes(orphan.path), true);

    part("The store answered that the file is not there: still missing");
    redis.clear();
    const gone = await work("headfirstgone", "d");
    blobs.set(gone.path, "missing");
    const missing = await handIn(gone);
    is("a HEAD that answered not found says missing", [missing.status, missing.error], [400, "missing"]);
    is("nothing was handed in for a missing file", await handedFile(gone), null);

    part("One path is let in once, however many requests race for it");
    redis.clear();
    const raced = await work("headfirstrace", "e");
    blobs.set(raced.path, "answer");
    const both = await Promise.all([handIn(raced), handIn(raced)]);
    const statuses = both.map((one) => one.status).sort();
    // Since main's oneHandInAtATime (lib/assignment.ts), two hand-ins of the same work run one after the other: the
    // second finds the file the first kept (before.file) and reuses it, never passing the door or counting it again.
    is("two racing hand-ins of the same work run one after the other", statuses, [200, 200]);
    is("the upload's door was spent once", await door(raced.path), false);
    is("the file's bytes are counted once", await roomUsed(raced), 1000);
    is("the submission keeps the file once", await handedFile(raced), raced.path);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main()
  .then(() => {
    globalThis.fetch = originalFetch;
    done();
  })
  .catch((error: unknown) => {
    globalThis.fetch = originalFetch;
    console.error(error);
    process.exitCode = 2;
  });
