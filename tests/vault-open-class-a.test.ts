/**
 * What one vault upload start can cost on R2, counted on the real path
 * (app/api/store/vault: open, done, abort; lib/vault-storage.ts,
 * lib/storage-reservations.ts, lib/storage-quota.ts, lib/file-store.ts,
 * lib/vault.ts), against what the cost table prices per start
 * (UPLOAD_OPEN_CLASS_A_OPS and UPLOAD_OPEN_CLASS_B_OPS, lib/spend-cost-table.ts).
 *
 * R2 bills by operation class (https://developers.cloudflare.com/r2/pricing/,
 * read by Claude 1 on 4 November 2026, docs/backup-cost-2026-11-04.md):
 * ListObjects, CreateMultipartUpload, CompleteMultipartUpload and UploadPart
 * are Class A; HeadObject and GetObject are Class B; DeleteObject and
 * AbortMultipartUpload are free. An error answer is billed too. The pieces
 * themselves (UploadPart) are priced per signing request, not per start.
 *
 * The worst start: admission retires one expired session whose
 * cancellation finds it already completed (a measurement), reads the
 * store's vault listing to its last allowed page, and creates the multipart
 * session; completion joins it and its measurement cannot be read; the
 * cancellation that follows finds the session completed and measures again.
 * Every measurement is a HEAD whose answer states no plain length, so the
 * one-byte ranged GET follows it.
 *
 * Synthetic Redis, synthetic R2 stand-in, a stub for the host's file
 * listing; no real request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { abortReservedVault, closeReservedVault, openReservedVault } from "@/lib/vault-storage";
import { storageBrakeFor } from "@/lib/storage-quota";
import { UPLOAD_OPEN_CLASS_A_OPS, UPLOAD_OPEN_CLASS_B_OPS } from "@/lib/spend-cost-table";
import { UPLOAD_SECONDS, VAULT_LIST_PAGES } from "@/lib/vault-rules";

// The atomic scripts of lib/storage-reservations.ts, as tests/storage-reservations.test.ts stands them in.
const original = store.run.bind(store);
store.run = ((command: (string | number)[]) => {
  if (String(command[0]).toUpperCase() !== "EVAL") return original(command);
  const source = String(command[1]);
  const count = Number(command[2]);
  const keys = command.slice(3, 3 + count);
  const args = command.slice(3 + count);
  if (original(["GET", keys[0]]) !== args[0]) return 0;
  if (source.includes('redis.call("SET", KEYS[2]')) { original(["SET", keys[1], args[1]]); return 1; }
  if (source.includes('redis.call("DEL", KEYS[1])')) return original(["DEL", keys[0]]);
  throw new Error("unexpected script");
}) as typeof store.run;

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "sold-files";
const ORIGIN = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const FOLDER = "abcdef0123456789abcdef0123456789";
const OLD_PATH = `vault/${FOLDER}/oldproduct/0011223344556677-old.zip`;
const LIST_PAGES = VAULT_LIST_PAGES;

process.env.R2_ACCOUNT_ID = ACCOUNT;
process.env.R2_ACCESS_KEY_ID = "a-stand-in-access-key-id";
process.env.R2_SECRET_ACCESS_KEY = "a-stand-in-secret-access-key-for-tests-only";
process.env.R2_BUCKET = BUCKET;

type Op = "A" | "B" | "free";
const billed: { op: Op; what: string }[] = [];
const count = (op: Op) => billed.filter(row => row.op === op).length;
let made = 0;
let measureFails = 0;
const sessions = new Map<string, string>();
const completed = new Set<string>([OLD_PATH]);

const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  assert.equal(url.origin, ORIGIN, "only the R2 stand-in is asked");
  const key = url.pathname.slice(`/${BUCKET}/`.length);
  const range = ((init?.headers ?? {}) as Record<string, string>).range;
  if (!key && method === "GET") {
    billed.push({ op: "A", what: "ListObjectsV2" });
    const page = Number(url.searchParams.get("continuation-token") ?? "0");
    const more = page + 1 < LIST_PAGES;
    return xml(`<ListBucketResult><IsTruncated>${more}</IsTruncated><Contents><Key>${url.searchParams.get("prefix")}p${page}</Key><Size>1</Size></Contents>${more ? `<NextContinuationToken>${page + 1}</NextContinuationToken>` : ""}</ListBucketResult>`);
  }
  if (method === "POST" && url.searchParams.has("uploads")) {
    billed.push({ op: "A", what: "CreateMultipartUpload" });
    made += 1;
    sessions.set(`session-${made}`, key);
    return xml(`<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>session-${made}</UploadId></InitiateMultipartUploadResult>`);
  }
  const uploadId = url.searchParams.get("uploadId");
  if (method === "POST" && uploadId) {
    billed.push({ op: "A", what: "CompleteMultipartUpload" });
    if (sessions.get(uploadId) !== key) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
    sessions.delete(uploadId);
    completed.add(key);
    return xml(`<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`);
  }
  if (method === "DELETE") {
    billed.push({ op: "free", what: uploadId ? "AbortMultipartUpload" : "DeleteObject" });
    if (uploadId && !sessions.delete(uploadId)) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
    return new Response(null, { status: 204 });
  }
  if (method === "HEAD" || method === "GET") {
    billed.push({ op: "B", what: method === "HEAD" ? "HeadObject" : "GetObject" });
    if (!completed.has(key)) return new Response(null, { status: 404 });
    // No plain length: the measurement goes on to one ranged byte.
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "application/zip", "content-encoding": "gzip" } });
    assert.equal(range, "bytes=0-0");
    if (measureFails > 0) { measureFails -= 1; return new Response(null, { status: 503 }); }
    return new Response(new Uint8Array(1), { status: 206, headers: { "content-range": "bytes 0-0/1", "content-type": "application/zip" } });
  }
  throw new Error(`unexpected request ${method} ${url}`);
}) as typeof fetch;

test("one upload start never costs more R2 operations than the cost table prices for it", async () => {
  // An expired reservation of an earlier start, bound to a session the store already completed.
  original(["SET", "nl:storage:pending:" + FOLDER, JSON.stringify([{ id: "a".repeat(32), bytes: 1, at: Date.now() - UPLOAD_SECONDS * 1000 - 1, pathname: OLD_PATH, uploadId: "gone-session" }])]);

  const opened = await openReservedVault({ folder: FOLDER, ownerId: "product01", name: "a.zip", bytes: 1, type: "application/zip", multipart: true }, storageBrakeFor("paid", "scale"));
  assert.equal(opened.ok, true, "the start is admitted after the whole listing is read");
  if (!opened.ok) return;
  assert.equal(billed.filter(row => row.what === "ListObjectsV2").length, LIST_PAGES, "admission read every page of the vault listing");

  measureFails = 1;
  const closed = await closeReservedVault(opened.upload.pathname, ["0".repeat(32)]);
  assert.deepEqual(closed, { ok: false, reason: "unavailable" }, "the completion's measurement could not be read");
  assert.equal(await abortReservedVault(opened.upload.pathname), true, "the cancellation finds the completed file and lets the start go");

  const seen = (op: Op) => `${count(op)} (${billed.filter(r => r.op === op).map(r => r.what).join(", ")})`;
  assert.deepEqual({ A: count("A") <= UPLOAD_OPEN_CLASS_A_OPS, B: count("B") <= UPLOAD_OPEN_CLASS_B_OPS }, { A: true, B: true },
    `Class A on the path: ${seen("A")}; priced: ${UPLOAD_OPEN_CLASS_A_OPS}. Class B on the path: ${seen("B")}; priced: ${UPLOAD_OPEN_CLASS_B_OPS}`);
});
