/**
 * Codex V's MEDIUM on #4022 (security, TOCTOU): the "open" check stops a session let in without its second step
 * (lib/two-step.ts) from uploading over a file already delivered, but not a race. A locked session A opens an upload
 * on a product with no file and passes; before A attaches, a full session B attaches its own file; A finishes, and
 * its attach is refused as locked. A's file was left in the store with nothing pointing at it, held against the
 * store's storage and billed.
 *
 * Now a finished upload is noted, under its own random path, until it is attached (lib/vault-storage.ts). The attach
 * that refuses a locked session deletes that path only while the note is there: a path that was never a finished
 * upload of this store's, or one already attached, is never deleted on a client's word. Synthetic store, the file
 * store played by a stand-in that speaks its dialect; nothing real is stored.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeFolder, storeForEmail } from "@/lib/store";
import { readDelivery } from "@/lib/catalog";
import { openLockedSession } from "@/lib/two-step";
import { closeVaultUpload, openVaultUpload, signPieces } from "@/lib/vault";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST as attach } from "@/app/api/store/file/attach/route";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "test-files";
process.env.R2_ACCOUNT_ID = ACCOUNT;
process.env.R2_ACCESS_KEY_ID = "1234567890123456";
process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
process.env.R2_BUCKET = BUCKET;
const R2 = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

const objects = new Map<string, Uint8Array>();
const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
const deleted: string[] = [];
let made = 0;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  if (url.origin !== R2) return new Response(null, { status: 404 });
  const key = url.pathname.slice(`/${BUCKET}/`.length);
  const body = init?.body == null ? new Uint8Array() : typeof init.body === "string" ? new TextEncoder().encode(init.body) : new Uint8Array(init.body as ArrayBuffer);
  if (!key) {
    const all = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
    return xml(`<ListBucketResult><IsTruncated>false</IsTruncated>${all.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.byteLength}</Size></Contents>`).join("")}</ListBucketResult>`);
  }
  if (method === "POST" && url.searchParams.has("uploads")) {
    made += 1;
    uploads.set(`upload-${made}`, { key, parts: new Map() });
    return xml(`<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><UploadId>upload-${made}</UploadId></InitiateMultipartUploadResult>`);
  }
  const uploadId = url.searchParams.get("uploadId");
  if (uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload || upload.key !== key) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
    if (method === "PUT") {
      upload.parts.set(Number(url.searchParams.get("partNumber")), body);
      return new Response(null, { status: 200, headers: { ETag: `"${md5(body)}"` } });
    }
    if (method === "DELETE") {
      uploads.delete(uploadId);
      return new Response(null, { status: 204 });
    }
    if (method === "POST") {
      objects.set(key, upload.parts.get(1) ?? new Uint8Array());
      uploads.delete(uploadId);
      return xml(`<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`);
    }
  }
  if (method === "DELETE") {
    deleted.push(key);
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  const found = objects.get(key);
  if (!found) return method === "HEAD" ? new Response(null, { status: 404 }) : xml("<Error><Code>NoSuchKey</Code></Error>", 404);
  const about = { "content-length": String(found.byteLength), "content-type": "application/pdf" };
  if (method === "HEAD") return new Response(null, { status: 200, headers: about });
  return new Response(found as BodyInit, { status: 200, headers: about });
}) as typeof fetch;

const OWNER = "vault.race@example.com";
const ORIGIN = "https://marktmorgen.com";
const post = (session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}/api/store/file/attach`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""];

/** One file sent up to the store as the studio would, through the upload's own pieces; its path when finished. */
async function upload(folder: string, ownerId: string, name: string): Promise<string> {
  const bytes = new TextEncoder().encode(`%PDF ${name}`);
  // The upload door (app/api/store/vault) reserves storage around these two; the finish the door makes is closeVaultUpload.
  const opened = await openVaultUpload({ folder, ownerId, name, bytes: bytes.byteLength, type: "application/pdf", multipart: true });
  if (!opened.ok) throw new Error(`not opened: ${opened.reason}`);
  const [piece] = (await signPieces(opened.upload.pathname, [1])) ?? [];
  if (!piece) throw new Error("not signed");
  const sent = await fetch(piece.url, { method: "PUT", body: bytes as BodyInit });
  const closed = await closeVaultUpload(opened.upload.pathname, [sent.headers.get("ETag") ?? ""]);
  if (!closed.ok) throw new Error(`not closed: ${closed.reason}`);
  return opened.upload.pathname;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "vaultrace", "Vault Race", "");
  await ensureStatsId(OWNER);
  const product = await addProduct(OWNER, "Guide", "", "20", null);
  if (!product.ok) throw new Error("no product");
  const id = product.product.id;
  const folder = await storeFolder(OWNER);
  const locked = await openLockedSession(OWNER, Date.now() + 7 * 86_400_000);
  const full = await openSession(OWNER);

  part("A locked session's upload, beaten to the attach by a full session, is not left behind");
  // A (locked) opened on a product with no file, so "open" let it through; it finishes after B attached.
  const mine = await upload(folder, id, "mine.pdf");
  const winner = await upload(folder, id, "winner.pdf");
  is("B, with its second step, attaches its file", await answer(await attach(post(full, { id, pathname: winner, name: "winner.pdf" }))), [200, ""]);
  deleted.length = 0;
  is("A's attach is refused as locked", await answer(await attach(post(locked, { id, pathname: mine, name: "mine.pdf" }))), [403, "locked"]);
  is("A's file, and only that, is deleted from the store", deleted, [mine]);
  is("and is gone from what the store holds", [objects.has(mine), objects.has(winner)], [false, true]);
  is("B's file is still the product's", (await readDelivery((await storeForEmail(OWNER))!, id))?.product.file?.pathname, winner);

  part("A path the client names is never deleted on its word");
  deleted.length = 0;
  is("the attached file, named by a locked session, is refused", await answer(await attach(post(locked, { id, pathname: winner, name: "winner.pdf" }))), [403, "locked"]);
  is("and not deleted: it was attached, so it is no longer a finished upload waiting", [deleted, objects.has(winner)], [[], true]);
  is("A's path again: already deleted, nothing more is asked", (await attach(post(locked, { id, pathname: mine, name: "mine.pdf" }))).status, 403);
  is("no second delete", deleted, []);

  done();
}

void main();
