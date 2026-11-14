/**
 * Finishing ("done") and cancelling ("abort") one vault upload, asked for
 * again and again, against what the cost table prices for one upload start
 * (lib/spend-cost-table.ts: one completion and one cancellation, each with
 * one file measurement, and UPLOAD_REQUESTS_PER_OPEN requests in all).
 *
 * The first finish and the first confirmed cancel of an upload are written
 * down with their answer; every later one gets that same answer back without
 * asking R2 again. A cancel R2 did not confirm is not written down, so a
 * retry inside the priced requests asks R2 again and can free the bytes. And no upload takes more finish-or-cancel requests than are priced
 * for it: past that, a plain refusal, with no request to R2 at all.
 *
 * R2 bills by operation class (https://developers.cloudflare.com/r2/pricing/):
 * CompleteMultipartUpload is Class A, billed even when it answers an error;
 * HeadObject and GetObject are Class B; AbortMultipartUpload and DeleteObject
 * are free.
 *
 * Synthetic Redis and a synthetic R2 stand-in; no real request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { openVaultUpload } from "@/lib/vault";
import { abortReservedVault, closeReservedVault } from "@/lib/vault-storage";
import { UPLOAD_REQUESTS_PER_OPEN } from "@/lib/spend-cost-table";
import { VAULT_MEASURE_REQUESTS } from "@/lib/vault-rules";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "sold-files";
const ORIGIN = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const FOLDER = "fedcba9876543210fedcba9876543210";
/** The finish-and-cancel requests one start is priced for: every priced request but the start itself. */
const CONTROL_REQUESTS = UPLOAD_REQUESTS_PER_OPEN - 1;
const REPEATS = 6;

process.env.R2_ACCOUNT_ID = ACCOUNT;
process.env.R2_ACCESS_KEY_ID = "a-stand-in-access-key-id";
process.env.R2_SECRET_ACCESS_KEY = "a-stand-in-secret-access-key-for-tests-only";
process.env.R2_BUCKET = BUCKET;

type Op = "A" | "B" | "free";
let billed: { op: Op; what: string }[] = [];
const count = (what: string) => billed.filter(row => row.what === what).length;
const classB = () => billed.filter(row => row.op === "B").length;
let made = 0;
/** How the next answers go wrong: a measurement that cannot be read, a cancellation R2 does not confirm. */
let measureFails = 0;
let deleteFails = false;
const sessions = new Map<string, string>();
const completed = new Set<string>();

const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  assert.equal(url.origin, ORIGIN, "only the R2 stand-in is asked");
  const key = url.pathname.slice(`/${BUCKET}/`.length);
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
    if (deleteFails) return new Response(null, { status: 503 });
    if (uploadId && !sessions.delete(uploadId)) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
    return new Response(null, { status: 204 });
  }
  if (method === "HEAD" || method === "GET") {
    billed.push({ op: "B", what: method === "HEAD" ? "HeadObject" : "GetObject" });
    if (!completed.has(key)) return new Response(null, { status: 404 });
    // No plain length: the measurement goes on to one ranged byte.
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "application/zip", "content-encoding": "gzip" } });
    if (measureFails > 0) { measureFails -= 1; return new Response(null, { status: 503 }); }
    return new Response(new Uint8Array(1), { status: 206, headers: { "content-range": "bytes 0-0/1", "content-type": "application/zip" } });
  }
  throw new Error(`unexpected request ${method} ${url}`);
}) as typeof fetch;

async function opened(): Promise<string> {
  const upload = await openVaultUpload({ folder: FOLDER, ownerId: "product01", name: "a.zip", bytes: 1, type: "application/zip", multipart: true });
  assert.equal(upload.ok, true);
  if (!upload.ok) throw new Error("open failed");
  billed = [];
  return upload.upload.pathname;
}

test("a finish asked for again and again joins the upload once and measures it once", async () => {
  const pathname = await opened();
  measureFails = 1;
  const first = await closeReservedVault(pathname, ["0".repeat(32)]);
  assert.deepEqual(first, { ok: false, reason: "unavailable" }, "the completion's measurement could not be read");
  const again = await closeReservedVault(pathname, ["0".repeat(32)]);
  assert.deepEqual(again, first, "the second finish is told what the first one was");
  assert.deepEqual({ complete: count("CompleteMultipartUpload"), classB: classB() }, { complete: 1, classB: VAULT_MEASURE_REQUESTS },
    `R2 asked: ${billed.map(row => row.what).join(", ")}`);
});

test("a finish that worked, asked for again, is answered the same with no request to R2", async () => {
  const pathname = await opened();
  const first = await closeReservedVault(pathname, ["0".repeat(32)]);
  assert.equal(first.ok, true);
  const asked = billed.length;
  assert.deepEqual(await closeReservedVault(pathname, ["0".repeat(32)]), first);
  assert.equal(billed.length, asked, "no request to R2 for the repeat");
});

test("a cancellation R2 did not confirm is asked again inside the priced requests, and a confirmed one is not", async () => {
  const pathname = await opened();
  deleteFails = true;
  try {
    assert.equal(await abortReservedVault(pathname), false);
  } finally { deleteFails = false; }
  assert.equal(await abortReservedVault(pathname), true, "the retry asks R2 again, which confirms it");
  assert.equal(count("AbortMultipartUpload"), 2, `R2 asked: ${billed.map(row => row.what).join(", ")}`);
  const asked = billed.length;
  assert.equal(await abortReservedVault(pathname), "tries", "past the priced requests, a plain refusal");
  assert.equal(billed.length, asked, "and R2 is not asked");
});

test("a confirmed cancellation, asked for again inside the priced requests, is answered the same with no request to R2", async () => {
  const pathname = await opened();
  assert.equal(await abortReservedVault(pathname), true);
  const asked = billed.length;
  assert.equal(await abortReservedVault(pathname), true);
  assert.equal(billed.length, asked, "no request to R2 for the repeat");
});

test("a finish refused for its piece list asks R2 nothing and does not use up a priced request", async () => {
  const pathname = await opened();
  assert.deepEqual(await closeReservedVault(pathname, []), { ok: false, reason: "invalid" }, "a one-piece upload needs one piece tag");
  assert.equal(billed.length, 0, "R2 is not asked for a refused finish");
  measureFails = 1;
  assert.deepEqual(await closeReservedVault(pathname, ["0".repeat(32)]), { ok: false, reason: "unavailable" }, "the corrected finish joins it, and its measurement could not be read");
  assert.equal(await abortReservedVault(pathname), true, "the cancel is still inside the priced requests, finds the file completed and measures it");
});

test("no upload takes more finish-or-cancel requests than are priced for it, and past them R2 is not asked", async () => {
  const pathname = await opened();
  measureFails = 1;
  const answers: unknown[] = [];
  for (let i = 0; i < REPEATS; i += 1) answers.push(i % 2 ? await abortReservedVault(pathname) : await closeReservedVault(pathname, ["0".repeat(32)]));
  // The priced worst start: one completion whose measurement fails, one
  // cancellation that finds the file completed and measures it again.
  assert.deepEqual({ A: count("CompleteMultipartUpload"), B: classB() }, { A: 1, B: 2 * VAULT_MEASURE_REQUESTS },
    `R2 asked: ${billed.map(row => row.what).join(", ")}`);
  const past = answers.slice(CONTROL_REQUESTS);
  assert.ok(past.length > 0);
  for (const answer of past) assert.ok(answer === "tries" || (typeof answer === "object" && answer !== null && (answer as { reason?: string }).reason === "tries"),
    `a request past the ${CONTROL_REQUESTS} priced is refused plainly, not answered ${JSON.stringify(answer)}`);
  const asked = billed.length;
  await closeReservedVault(pathname, ["0".repeat(32)]);
  await abortReservedVault(pathname);
  assert.equal(billed.length, asked, "a refused request asks R2 nothing");
  void store;
});
