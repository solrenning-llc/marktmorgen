/**
 * A student's file for an assignment reaches the file store: the name the browser sends it under is the very name
 * the door signed (app/api/store/course/task/upload, components/lesson-task.tsx).
 *
 * The audit of 9 November 2026 (Claude 5, proved with the real @vercel/blob 2.8.0, no network): the door replaced the
 * name the browser asked for ("task.pdf") with one it made, and the SDK signs the name the door hands it (the
 * delegation's scope and the request's HMAC), while the browser's uploadPresigned sends its PUT under the name it
 * asked for. The two never matched, so no student's file could ever be stored, and the route's comment that "the
 * browser is told it by the upload's answer" was not true: the answer carries no name.
 *
 * Now the browser names the file, fresh, inside the folder the lesson page gives it, and the door checks that name
 * against this student's own folder, the kind of file and the file store (a name that is already a file, a handed-in
 * one, is refused, so the daily sweep can never be pointed at it). Synthetic only: the real door, the real SDK on
 * both sides with a token made in Vercel's shape, the real lib/assignment.ts, an in-memory file store
 * (tests/failure-cleanup-world.ts) and the in-memory Redis (tests/redis-stub.ts).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { uploadPresigned } from "@vercel/blob/client";
import { POST } from "@/app/api/store/course/task/upload/route";
import * as rules from "@/lib/assignment-rules";
import { ownsTaskPath, taskFolder } from "@/lib/assignment-rules";
import { storeFolder, storeRef } from "@/lib/store";
import { sweepTaskUploads, takeTaskUpload } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { files } from "./failure-cleanup-world";
import { SIGNING_KEY, STORE, asStudent, issued } from "./task-upload-path-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.BLOB_WEBHOOK_PUBLIC_KEY = "webhook-public-key-for-tests";
const SITE = "https://marktmorgen.com";
(globalThis as unknown as { location: { href: string } }).location = { href: `${SITE}/@shop/course/product-1/lesson-1` };
const where = { handle: "shop", product: "product-1", lesson: "lesson-1" };
const PDF = "application/pdf";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The name the student's browser sends a file under (components/lesson-task.tsx), read by name so the test also runs,
 * and fails, where it is missing: on main the component sent every file as `task.<extension>`.
 */
let n = 0;
function browserName(folder: string, extension: string): string {
  const make = (rules as Record<string, unknown>).taskUploadPath;
  const id = (++n).toString(16).padStart(32, "0");
  return typeof make === "function" ? (make as (f: string, e: string, i: string) => string)(folder, extension, id) : `task.${extension}`;
}

async function folderOf(who: string): Promise<string> {
  return taskFolder(await storeFolder(storeRef(STORE as never)), "course-1", "lesson-1", who);
}

/** Every PUT the SDK sent the file store, as the browser would. */
const puts: URL[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin === SITE) {
    // The door, asked from the lesson page: same site, as a browser sends it.
    const request = new Request(url, { method: "POST", headers: { host: "marktmorgen.com", origin: SITE, "content-type": "application/json" }, body: init?.body as string });
    (request as unknown as { cookies: unknown }).cookies = { get: () => undefined };
    return POST(request as never);
  }
  puts.push(url);
  const pathname = url.searchParams.get("pathname") ?? "";
  return new Response(JSON.stringify({ url: `https://store_test.private.blob.vercel-storage.com/${pathname}`, downloadUrl: "", pathname, contentType: PDF, contentDisposition: "", etag: "e" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof globalThis.fetch;

/**
 * What the file store checks before it writes (the delegation's scope, then the request's HMAC over the operation,
 * the pathname and the signed options, as @vercel/blob's presign builds it): whether this PUT is one the token signs.
 */
function signedFor(put: URL): { scope: string | null; put: string | null; signed: boolean } {
  const delegation = put.searchParams.get("vercel-blob-delegation") ?? "";
  const scope = JSON.parse(Buffer.from(delegation.split(".")[0] ?? "", "base64url").toString() || "{}") as { pathname?: string };
  const pathname = put.searchParams.get("pathname");
  const lines = [`operation=put`, `pathname=${pathname}`];
  for (const [key, value] of put.searchParams) if (key.startsWith("vercel-blob-") && !["vercel-blob-delegation", "vercel-blob-signature"].includes(key) && value) lines.push(`${key}=${value}`);
  const expected = createHmac("sha256", SIGNING_KEY).update(lines.sort().join("\n")).digest("base64url");
  return { scope: scope.pathname ?? null, put: pathname, signed: expected === put.searchParams.get("vercel-blob-signature") };
}

/** What the component does when a file is chosen: the real uploadPresigned, to the real door. */
async function send(name: string): Promise<{ pathname?: string; error?: string }> {
  try {
    const answer = await uploadPresigned(name, new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: PDF }), {
      access: "private",
      handleUploadUrl: "/api/store/course/task/upload",
      clientPayload: JSON.stringify({ ...where, type: PDF }),
      contentType: PDF,
    });
    return { pathname: answer.pathname };
  } catch (thrown) {
    return { error: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

/** The door alone, asked for a name. */
async function ask(name: string, type = PDF): Promise<{ status: number; error?: string }> {
  const body = JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname: name, clientPayload: JSON.stringify({ ...where, type }), multipart: false } });
  const request = new Request(`${SITE}/api/store/course/task/upload`, { method: "POST", headers: { host: "marktmorgen.com", origin: SITE, "content-type": "application/json" }, body });
  (request as unknown as { cookies: unknown }).cookies = { get: () => undefined };
  const answer = await POST(request as never);
  const json = (await answer.json()) as { error?: string };
  return { status: answer.status, error: json.error };
}

const listed = async (path: string) => (await redis.pipeline([["ZSCORE", "nl:tasks:doors", path]]))[0] !== null;
const store = (path: string) => files.set(path, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: PDF, at: Date.now() });

async function main(): Promise<void> {
  part("The browser's PUT is the request the door signed");
  asStudent("student-a");
  const folder = await folderOf("student-a");
  const name = browserName(folder, "pdf");
  puts.length = 0;
  const sent = await send(name);
  is("the upload goes through the door to the file store", sent.error ?? "sent", "sent");
  is("one PUT is sent", puts.length, 1);
  const check = puts[0] ? signedFor(puts[0]) : { scope: null, put: null, signed: false };
  is("the PUT's name is the delegation's scope", check.put !== null && check.put === check.scope, true);
  is("the PUT's signature is the HMAC over the PUT's own name", check.signed, true);
  is("the name stored is a fresh one in this student's own folder", ownsTaskPath(check.put, folder), true);
  is("the name the component keeps is one the hand-in takes (ownsTaskPath)", ownsTaskPath(sent.pathname, folder), true);
  is("the door listed that very name for the hand-in and the sweep", check.put ? await listed(check.put) : false, true);
  is("the door signed one name and never an overwrite", issued.at(-1)?.operations, ["put"]);

  part("The door checks the name, never trusts it");
  const other = await folderOf("student-b");
  is("a name in another student's folder is refused", await ask(browserName(other, "pdf")), { status: 400, error: "invalid" });
  is("a name outside the store's tasks is refused", await ask("stores/elsewhere/0123456789abcdef0123456789abcdef.pdf"), { status: 400, error: "invalid" });
  is("a name that is not a fresh one is refused", await ask(`${folder}task.pdf`), { status: 400, error: "invalid" });
  is("a name whose kind is not the file's is refused", await ask(browserName(folder, "png")), { status: 400, error: "invalid" });
  is("a name that climbs out of the folder is refused", await ask(`${folder}../student-b/${"0".repeat(32)}.pdf`), { status: 400, error: "invalid" });

  part("A handed-in file's name is never opened again, so the sweep can never delete it");
  const handed = browserName(folder, "pdf");
  is("its door opens", (await ask(handed)).status, 200);
  store(handed);
  is("it is handed in (taken off the list)", await takeTaskUpload(handed), true);
  is("a door for the handed-in file's name is refused", await ask(handed), { status: 400, error: "invalid" });
  is("and it is not put back on the sweep's list", await listed(handed), false);
  const swept = await sweepTaskUploads(deleteFile, Date.now() + DAY_MS + 3_600_000);
  is("the next day's sweep leaves the handed-in file alone", [files.has(handed), swept.includes(handed)], [true, false]);

  part("A second door for a file sent and not yet handed in keeps the first one's listing");
  const pending = browserName(folder, "pdf");
  is("the first door opens", (await ask(pending)).status, 200);
  store(pending);
  is("a second door for the same name is refused", await ask(pending), { status: 400, error: "invalid" });
  is("the file can still be handed in", await takeTaskUpload(pending), true);

  part("A file store that cannot answer opens no door and lists nothing");
  const unknown = browserName(folder, "pdf");
  const original = files.get.bind(files);
  files.get = ((key: string) => {
    if (key === unknown) throw new Error("the file store could not be reached");
    return original(key);
  }) as typeof files.get;
  is("the door says it cannot be opened now", await ask(unknown), { status: 503, error: "unavailable" });
  files.get = original;
  is("and the name is not left on the sweep's list", await listed(unknown), false);

  part("The component and the lesson page send the name the door checks");
  const component = readFileSync("components/lesson-task.tsx", "utf8");
  is("the component names the file with taskUploadPath, in the folder it is given", /uploadPresigned\(taskUploadPath\(folder, /.test(component), true);
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  is("the lesson page gives the student's folder (taskFolder)", /folder=\{taskFolderFor\}/.test(page) && /taskFolder\(await storeFolder\(storeRef\(store\)\), course\.id, lesson\.id, who\)/.test(page), true);
  const route = readFileSync("app/api/store/course/task/upload/route.ts", "utf8");
  is("the door no longer replaces the browser's name", /body\.payload\.pathname = /.test(route), false);
  done();
}

void main();
