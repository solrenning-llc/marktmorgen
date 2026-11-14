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
 *
 * The pre-review of the fix (9 November 2026) added: a hand-in that takes the name off the list and then lets the file
 * go (none there yet, the wrong kind, too big, no room, work not kept, or a function cut off by its time limit) leaves
 * the name held for the sweep, since the browser's PUT may still land within the door's five minutes and would
 * otherwise be kept for ever, outside the sweep and the room (the second pre-review: the hold is written when the name
 * is taken, so no exit, written or not, can miss it, and the sweep deletes a held file only when no work keeps it); the sweep keeps a file that is a student's handed-in work whatever the list says; the door lists its
 * name again after asking the file store, in case the sweep took an old listing of it meanwhile; the door's whole cost
 * is priced and held inside a buyer action; and a file the door refuses is said honestly, since the SDK's error says
 * nothing of why.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { uploadPresigned } from "@vercel/blob/client";
import { POST } from "@/app/api/store/course/task/upload/route";
import { POST as HAND_IN } from "@/app/api/store/course/task/route";
import * as rules from "@/lib/assignment-rules";
import { ownsTaskPath, taskFolder } from "@/lib/assignment-rules";
import { storeFolder, storeRef } from "@/lib/store";
import { noteTaskUpload, releaseTaskHold, submissionOf, sweepTaskUploads, takeTaskUpload } from "@/lib/assignment";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import * as registry from "./plan-cost-registry";
import { deleteFile } from "@/lib/file-store";
import { files } from "./failure-cleanup-world";
import { COURSE, LESSON, SIGNING_KEY, STORE, STUDENT_A, STUDENT_B, asStudent, issued, setFailDeletes } from "./task-upload-path-world";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.BLOB_WEBHOOK_PUBLIC_KEY = "webhook-public-key-for-tests";
const SITE = "https://marktmorgen.com";
(globalThis as unknown as { location: { href: string } }).location = { href: `${SITE}/@shop/course/product-1/lesson-1` };
const where = { handle: "shop", product: "product-1", lesson: LESSON };
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
  return taskFolder(await storeFolder(storeRef(STORE as never)), COURSE, LESSON, who);
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
/** Whether a name a hand-in took is held for the sweep (lib/assignment.ts, takeTaskUpload). */
const held = async (path: string) => (await redis.pipeline([["ZSCORE", "nl:tasks:held", path]]))[0] !== null;
const store = (path: string, contentType = PDF, size = 4) => files.set(path, { bytes: new Uint8Array(size).fill(0x25), contentType, at: Date.now() });

/** The hand-in, as the lesson's form sends it. */
async function handIn(path: string): Promise<string> {
  const request = new Request(`${SITE}/api/store/course/task`, {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: SITE, "content-type": "application/json" },
    body: JSON.stringify({ ...where, text: "", file: { path, name: "plan.pdf" } }),
  });
  answering(request);
  const answer = await HAND_IN(request as never);
  const json = (await answer.json()) as { ok?: boolean; error?: string };
  return json.ok ? "ok" : (json.error ?? `status ${answer.status}`);
}

async function main(): Promise<void> {
  part("The browser's PUT is the request the door signed");
  asStudent(STUDENT_A);
  const folder = await folderOf(STUDENT_A);
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
  const other = await folderOf(STUDENT_B);
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
  // As the hand-in does once its work keeps the file (app/api/store/course/task).
  await releaseTaskHold(handed);
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

  part("A hand-in that finds no file yet puts the name back, so a PUT landing later is swept (pre-review, ALTO)");
  const early = browserName(folder, "pdf");
  is("the door opens", (await ask(early)).status, 200);
  is("handed in before the browser's PUT landed: missing", await handIn(early), "missing");
  is("the name is held for the sweep", await held(early), true);
  store(early);
  const late = await sweepTaskUploads(deleteFile, Date.now() + DAY_MS + 3_600_000);
  is("the file that landed later is swept the next day", [late.includes(early), files.has(early)], [true, false]);

  part("Every hand-in that does not keep its file puts the name back");
  const wrong = browserName(folder, "pdf");
  is("the door opens", (await ask(wrong)).status, 200);
  store(wrong, "image/png");
  setFailDeletes(true);
  is("a file of another kind is refused", await handIn(wrong), "type");
  setFailDeletes(false);
  is("and, not deleted, its name is held for the sweep", await held(wrong), true);
  const big = browserName(folder, "pdf");
  is("the door opens", (await ask(big)).status, 200);
  store(big, PDF, rules.MAX_TASK_FILE_BYTES + 1);
  setFailDeletes(true);
  is("a file over the limit is refused", await handIn(big), "too_big");
  setFailDeletes(false);
  is("and, not deleted, its name is held for the sweep", await held(big), true);

  part("The sweep never deletes a student's handed-in work, whatever the list says");
  const kept = browserName(folder, "pdf");
  is("the door opens", (await ask(kept)).status, 200);
  store(kept);
  is("the file is handed in", await handIn(kept), "ok");
  is("it is the student's work now", (await submissionOf(COURSE, LESSON, STUDENT_A))?.file?.path, kept);
  await noteTaskUpload(kept, 0);
  const stray = await sweepTaskUploads(deleteFile, Date.now() + DAY_MS + 3_600_000);
  is("a stray listing of it does not get it deleted", [stray.includes(kept), files.has(kept)], [false, true]);

  part("The door lists its name again after asking the file store");
  const raced = browserName(folder, "pdf");
  const plain = files.get.bind(files);
  files.get = ((key: string) => {
    // The sweep takes an old listing of this name off the list while the door asks the file store about it.
    if (key === raced) void redis.pipeline([["ZREM", "nl:tasks:doors", raced]]);
    return plain(key);
  }) as typeof files.get;
  is("the door opens", (await ask(raced)).status, 200);
  files.get = plain;
  is("and its name is on the list for the file it lets in", await listed(raced), true);

  part("A hand-in cut off between taking the name and writing the work leaves nothing for ever (second pre-review, MÉDIO 1)");
  const cut = browserName(folder, "pdf");
  is("the door opens", (await ask(cut)).status, 200);
  store(cut);
  is("a hand-in takes the name", await takeTaskUpload(cut), true);
  is("a second hand-in cannot take it again", await takeTaskUpload(cut), false);
  // ... and the function is stopped here (its time limit), before the room and the work.
  const afterCut = await sweepTaskUploads(deleteFile, Date.now() + 2 * DAY_MS);
  is("the sweep deletes the file no work keeps", [afterCut.includes(cut), files.has(cut)], [true, false]);
  const good = browserName(folder, "pdf");
  is("the door opens", (await ask(good)).status, 200);
  store(good);
  is("a hand-in that keeps its file", await handIn(good), "ok");
  is("lets go of its hold", await held(good), false);
  const afterGood = await sweepTaskUploads(deleteFile, Date.now() + 2 * DAY_MS);
  is("and the sweep leaves the handed-in file alone", [afterGood.includes(good), files.has(good)], [false, true]);

  part("One door's file is deleted at most as often as its price counts (second pre-review, MÉDIO 2)");
  const twice = browserName(folder, "pdf");
  is("the door opens", (await ask(twice)).status, 200);
  store(twice, "image/png");
  let deletes = 0;
  const plainDelete = files.delete.bind(files);
  files.delete = ((key: string) => {
    if (key === twice) deletes += 1;
    return plainDelete(key);
  }) as typeof files.delete;
  is("a file of another kind is refused", await handIn(twice), "type");
  files.delete = plainDelete;
  await sweepTaskUploads(async (paths) => {
    deletes += paths.filter((path) => path === twice).length;
    await deleteFile(paths);
  }, Date.now() + 3 * DAY_MS);
  const advancedPriced = (registry as Record<string, unknown>).TASK_DOOR_ADVANCED_OPERATIONS;
  // The browser's PUT, the hand-in's delete and the sweep's: each an Advanced Operation of the file store.
  is("its upload and every delete of it are priced", typeof advancedPriced === "number" && 1 + deletes <= advancedPriced, true);
  const handInLine = registry.COST_LINES.flatMap((line) => line.sources).find((source) => source.file === "app/api/store/course/task/route.ts");
  is("the hand-in's own head and deletes are named in a cost line", ["headFile(path)", "deleteFile(path)"].every((name) => handInLine?.names.includes(name)), true);
  const workBytes = (registry as Record<string, unknown>).TASK_WORK_BYTES;
  is("the sweep's read of the work is counted in bytes", typeof workBytes === "number" && workBytes >= rules.MAX_ANSWER_TEXT + rules.MAX_FEEDBACK, true);

  part("The door's whole cost is priced, inside one buyer action");
  const prices = registry as Record<string, unknown>;
  const door = prices.TASK_DOOR_COST as number | undefined;
  const simple = prices.BLOB_SIMPLE_OPERATION as number | undefined;
  const advanced = prices.BLOB_ADVANCED_OPERATION as number | undefined;
  is("the head and the two advanced operations are priced, never zero", [simple ?? 0, advanced ?? 0].every((price) => price > 0), true);
  is("the door counts them", typeof door === "number" && door > (simple ?? 0) + 2 * (advanced ?? 0), true);
  is("the door, all of it, costs no more than one buyer action", typeof door === "number" && door <= registry.UNIT_COST.buyer, true);
  const advancedCount = (prices.TASK_DOOR_ADVANCED_OPERATIONS as number | undefined) ?? 0;
  is("and counts each priced advanced operation", typeof door === "number" && door > 2 * (simple ?? 0) + advancedCount * (advanced ?? 0) && advancedCount >= 3, true);

  part("A file the door refuses is said honestly, in every language");
  is("every language has its words", LANGUAGE_CODES.every((language) => (coursesWords(language) as unknown as Record<string, unknown>).taskFileFailed), true);

  part("The sweep's notes sit where they belong");
  const lib = readFileSync("lib/assignment.ts", "utf8");
  const doc = lib.indexOf("Deletes, with `remove`, the files uploaded");
  const sweep = lib.indexOf("export async function sweepTaskUploads");
  const between = lib.slice(doc, sweep);
  is("sweepTaskUploads' own note is right above it", doc > 0 && sweep > doc && !between.includes("function ") && !between.includes("const "), true);

  part("The component and the lesson page send the name the door checks");
  const component = readFileSync("components/lesson-task.tsx", "utf8");
  is("the component names the file with taskUploadPath, in the folder it is given", /uploadPresigned\(taskUploadPath\(folder, /.test(component), true);
  is("its id comes from crypto.getRandomValues, which older phones have", /crypto\.getRandomValues\(/.test(component) && !/randomUUID/.test(component), true);
  is("a refused upload says what may have happened (taskFileFailed), never a bare try again", /setError\(w\.taskFileFailed\)/.test(component) && !/message\.includes\("full"\)/.test(component), true);
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  is("the lesson page gives the student's folder (taskFolder)", /folder=\{taskFolderFor\}/.test(page) && /taskFolder\(await storeFolder\(storeRef\(store\)\), course\.id, lesson\.id, who\)/.test(page), true);
  const route = readFileSync("app/api/store/course/task/upload/route.ts", "utf8");
  is("the door no longer replaces the browser's name", /body\.payload\.pathname = /.test(route), false);
  done();
}

void main();
