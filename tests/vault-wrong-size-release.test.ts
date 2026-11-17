/**
 * A vault file joined at the wrong size is deleted, and the storage it held is
 * given back (#4283; found by Claude 1 cloud from #4082's re-verification).
 *
 * closeVaultUpload (lib/vault.ts) deletes the object and the upload record when
 * the joined file is not the size the upload was opened for, and answers
 * "invalid". closeReservedVault (lib/vault-storage.ts) released the
 * reservation only when the close succeeded, and after that nothing could:
 * abortReservedVault finds no record, and retiring the expired row asks a
 * session that is gone. The store's storage stayed short by that size for
 * good (storage_pending, then storage_limit), and the row kept its place in
 * the reservation list.
 *
 * Now a failed close gives its reservation back only when the upload record
 * is confirmed gone and the object confirmed absent. A close that fails with
 * the record still there (wrong part count, a provider refusal) keeps the
 * reservation, as before, and so does one whose object cannot be confirmed
 * absent.
 *
 * Synthetic store, synthetic R2 stand-in, no real request. The harness is the
 * one of tests/vault-upload-record-unknown.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { signPieces, vaultReservationId } from "@/lib/vault";
import { closeReservedVault, openReservedVault } from "@/lib/vault-storage";
import { UPLOAD_SECONDS } from "@/lib/vault-rules";
import type { StorageUse } from "@/lib/storage-quota";

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

// --- Redis answers in an unknown shape, on demand --------------------------------------------
const pipeline = store.pipeline.bind(store);
/** For the next GETs of an upload record: undefined answers healthily. */
const recordReads: (((real: unknown[]) => unknown) | undefined)[] = [];
/** For the next SET of an upload record: the reply given in place of Redis's, nothing written. */
let recordWrite: (() => unknown) | null = null;
const isRecord = (commands: (string | number)[][]) => commands.length === 1 && String(commands[0][1] ?? "").startsWith("nl:vault:up:");
store.pipeline = (async (commands: (string | number)[][]) => {
  if (isRecord(commands) && String(commands[0][0]).toUpperCase() === "GET" && recordReads.length) {
    const shape = recordReads.shift();
    const real = await pipeline(commands);
    return shape ? shape(real) : real;
  }
  if (isRecord(commands) && String(commands[0][0]).toUpperCase() === "SET" && recordWrite) {
    const reply = recordWrite();
    recordWrite = null;
    return reply;
  }
  return pipeline(commands);
}) as typeof store.pipeline;

// --- R2, stood in for -------------------------------------------------------------------------
process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.R2_ACCESS_KEY_ID = "1234567890123456";
process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
process.env.R2_BUCKET = "test-files";
const objects = new Map<string, number>();
const sessions = new Map<string, { key: string; parts: Map<number, number> }>();
const asked: string[] = [];
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error("unexpected request " + url.href);
  const method = init?.method ?? "GET";
  const key = url.pathname.replace(/^\/test-files\/?/, "");
  const uploadId = url.searchParams.get("uploadId");
  asked.push(`${method}${uploadId ? " session" : ""}`);
  if (method === "POST" && url.searchParams.has("uploads")) {
    const id = `session-${++made}`;
    sessions.set(id, { key, parts: new Map() });
    return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (uploadId) {
    const session = sessions.get(uploadId);
    if (!session || session.key !== key) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
    if (method === "PUT") {
      const size = init?.body instanceof Uint8Array ? init.body.byteLength : 0;
      session.parts.set(Number(url.searchParams.get("partNumber")), size);
      return new Response(null, { status: 200, headers: { ETag: `"${"a".repeat(32)}"` } });
    }
    if (method === "DELETE") { sessions.delete(uploadId); return new Response(null, { status: 204 }); }
    if (method === "POST") {
      objects.set(key, [...session.parts.values()].reduce((a, b) => a + b, 0));
      sessions.delete(uploadId);
      return new Response(`<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`);
    }
  }
  if (method === "HEAD") {
    const size = objects.get(key);
    return size === undefined ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { "content-length": String(size), "content-type": "application/pdf" } });
  }
  if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
  throw new Error("unexpected request " + method + " " + url.href);
}) as typeof fetch;

const folder = (n: number) => n.toString(16).padStart(32, "0");
/** What the folder keeps, complete objects only, as a listing measures it. */
const kept = (n: number) => [...objects.entries()].filter(([k]) => k.startsWith(`vault/${folder(n)}/`)).reduce((a, [, b]) => a + b, 0);
const measure = (n: number) => async (): Promise<StorageUse> => ({ bytes: kept(n), brake: 10, left: 10 - kept(n), full: false, available: true });
const input = (n: number) => ({ folder: folder(n), ownerId: "product", name: "file.pdf", bytes: 10, type: "application/pdf" });

/** Opens an upload of 10 bytes for folder `n` and sends `size` bytes to it as its one piece. */
async function sent(n: number, size: number): Promise<string> {
  const opened = await openReservedVault(input(n), 10, measure(n));
  if (!opened.ok) throw new Error("open failed");
  const pieces = await signPieces(opened.upload.pathname, [1]);
  if (!pieces) throw new Error("sign failed");
  await fetch(pieces[0].url, { method: "PUT", body: new Uint8Array(size) });
  return opened.upload.pathname;
}

/** Opens another 10-byte upload for folder `n` (storage of 10 bytes), now or `later` seconds on. */
async function openAgain(n: number, later = 0): Promise<string> {
  const realNow = Date.now;
  Date.now = () => realNow() + later * 1000;
  try {
    const again = await openReservedVault(input(n), 10, measure(n)).then((r) => r, (e: unknown) => e);
    return again && typeof again === "object" && "ok" in again && again.ok === true ? "opened" : String(again);
  } finally {
    Date.now = realNow;
  }
}

test("a file joined at the wrong size is deleted and refused, and its reserved bytes are given back", async () => {
  const pathname = await sent(900, 7);
  const closed = await closeReservedVault(pathname, ["a".repeat(32)]);
  assert.deepEqual(closed, { ok: false, reason: "invalid" });
  assert.equal(kept(900), 0, "the wrong-size file was deleted");
  assert.equal(await vaultReservationId(pathname), undefined, "the upload record is gone, so nothing can close it again");
  assert.equal(await openAgain(900), "opened", "nothing is stored or open, so a new upload of the same size fits at once");
});

test("control: a close refused with the record still there keeps its reservation", async () => {
  const pathname = await sent(901, 10);
  // Two parts named for a one-piece upload: refused before anything is joined, and the upload stays open.
  const closed = await closeReservedVault(pathname, ["a".repeat(32), "b".repeat(32)]);
  assert.deepEqual(closed, { ok: false, reason: "invalid" });
  assert.notEqual(await vaultReservationId(pathname), undefined, "the upload is still open");
  assert.notEqual(await openAgain(901), "opened", "its bytes are still held while it is open");
});

test("control: a wrong-size file that could not be confirmed deleted keeps its reservation", async () => {
  const pathname = await sent(902, 7);
  const realFetch = globalThis.fetch;
  // The store does not answer the check that the deleted object is gone.
  let heads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "HEAD" && (heads += 1) > 1) return new Response(null, { status: 503 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const closed = await closeReservedVault(pathname, ["a".repeat(32)]);
    assert.deepEqual(closed, { ok: false, reason: "invalid" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.notEqual(await openAgain(902), "opened", "not confirmed absent: its bytes are kept, never given back on a guess");
});

test("control: a file joined at its size is kept and its reservation settled once", async () => {
  const pathname = await sent(903, 10);
  const closed = await closeReservedVault(pathname, ["a".repeat(32)]);
  assert.equal(closed.ok, true);
  assert.equal(kept(903), 10);
  assert.notEqual(await openAgain(903), "opened", "the kept file fills the storage");
});

test("a wrong-size file's bytes stay free long after (the issue's own scenario)", async () => {
  const pathname = await sent(904, 7);
  await closeReservedVault(pathname, ["a".repeat(32)]);
  assert.equal(await openAgain(904, UPLOAD_SECONDS + 3600), "opened");
});
