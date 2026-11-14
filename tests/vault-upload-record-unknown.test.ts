/**
 * The record of an open vault upload (nl:vault:up:<hash>, lib/vault.ts) read
 * in its exact shape (CX-123 rule 24).
 *
 * Only a confirmed absent key (`null`) means "no upload". Any other answer,
 * a pipeline with no reply for the GET, a number, a list, an object, or a
 * string that is not the record written for that path, leaves the upload
 * unknown: signing, closing, cancelling and reading its reservation must
 * refuse, and a cancellation must never be reported done, nor its reserved
 * bytes given back, without the provider having been asked. Writing the
 * record must be acknowledged before the opened upload is handed out.
 *
 * Synthetic store, synthetic R2 stand-in, no real request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { abortVaultUpload, closeVaultUpload, signPieces, vaultReservationId } from "@/lib/vault";
import { abortReservedVault, closeReservedVault, openReservedVault } from "@/lib/vault-storage";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { StorageUse } from "@/lib/storage-quota";

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

// --- Redis answers in an unknown shape, on demand --------------------------------------------
const pipeline = store.pipeline.bind(store);
/** For the next GETs of an upload record: undefined answers healthily. */
let recordReads: (((real: unknown[]) => unknown) | undefined)[] = [];
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

/** The studio's browser: one piece to its signed address, then the join. */
async function finish(pathname: string): Promise<boolean> {
  const pieces = await signPieces(pathname, [1]);
  if (!pieces) return false;
  await fetch(pieces[0].url, { method: "PUT", body: new Uint8Array(10) });
  return (await closeReservedVault(pathname, ["a".repeat(32)])).ok;
}

const UNKNOWN: [string, (real: unknown[]) => unknown][] = [
  ["no reply for the GET", () => []],
  ["two replies for one GET", real => [real[0], real[0]]],
  ["a number", () => [7]],
  ["a list", () => [["x"]]],
  ["an object", () => [{}]],
  ["true", () => [true]],
  ["a string that is not a record", () => ["not-json"]],
  ["a record of another path", real => [typeof real[0] === "string" ? real[0].replace("file.pdf", "other.pdf") : real[0]]],
  ["a record with no size", real => [typeof real[0] === "string" ? JSON.stringify({ ...JSON.parse(real[0]), bytes: 0 }) : real[0]]],
  // Every other field, in a shape the writer (openVaultUpload) never stores.
  ...([
    ["a session id that is a number", { uploadId: 42 }],
    ["a session id that is null", { uploadId: null }],
    ["no session id", { uploadId: undefined }],
    ["a session id the provider could not have given", { uploadId: "bad id" }],
    ["a reservation that is a number", { reservation: 7 }],
    ["a reservation that is null", { reservation: null }],
    ["a reservation of another shape", { reservation: "not-a-reservation" }],
    ["a fractional size", { bytes: 9.5 }],
    ["a size beyond a safe integer", { bytes: 2 ** 53 }],
    ["a negative size", { bytes: -10 }],
    ["a size that is a string", { bytes: "10" }],
    ["a type that is a number", { type: 1 }],
    ["no type", { type: undefined }],
    ["a time that is a string", { at: "now" }],
    ["no time", { at: undefined }],
    ["a fractional time", { at: 1.5 }],
  ] as [string, Record<string, unknown>][]).map(([name, change]): [string, (real: unknown[]) => unknown] => [
    `a record with ${name}`,
    real => [typeof real[0] === "string" ? JSON.stringify({ ...JSON.parse(real[0]), ...change }) : real[0]],
  ]),
];

test("a cancellation never reports done, nor frees reserved bytes, on an upload record it could not read", async () => {
  const opened = await openReservedVault(input(1), 10, measure(1));
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("open failed");
  const pathname = opened.upload.pathname;
  asked.length = 0;
  // vaultReservationId reads the record healthily; abortVaultUpload's own read is unknown.
  recordReads = [undefined, () => []];
  const outcome = await abortReservedVault(pathname).then(r => r, e => e);
  recordReads = [];
  const askedOnAbort = [...asked];
  // A second upload of the same size, then both finished, as the studio's browsers would.
  const second = await openReservedVault(input(1), 10, measure(1)).then(r => r, e => e);
  assert.equal(await finish(pathname), true);
  if (second && second.ok) await finish(second.upload.pathname);
  assert.ok(kept(1) <= 10, `the folder keeps ${kept(1)} bytes against a limit of 10`);
  assert.match(String(second), /storage_(limit|pending)/, "the bytes stay reserved while the first upload is unknown");
  assert.notEqual(outcome, true, "an unread record is never a cancelled upload");
  assert.ok(outcome instanceof UnknownReplyError, "the unknown reply is said as unknown");
  assert.deepEqual(askedOnAbort, [], "nothing was asked of the provider on the unknown record");
});

test("a session id in a shape never written is not taken for a file sent whole: nothing is deleted and the bytes stay reserved", async () => {
  const opened = await openReservedVault(input(2), 10, measure(2));
  if (!opened.ok) throw new Error("open failed");
  const pathname = opened.upload.pathname;
  const signed = await signPieces(pathname, [1]);
  assert.equal(signed?.length, 1);
  asked.length = 0;
  const withNumber = (real: unknown[]) => [typeof real[0] === "string" ? JSON.stringify({ ...JSON.parse(real[0]), uploadId: 42 }) : real[0]];
  recordReads = [withNumber, withNumber];
  const outcome = await abortReservedVault(pathname).then(r => r, e => e);
  recordReads = [];
  assert.ok(outcome instanceof UnknownReplyError, `the cancellation said ${String(outcome)}`);
  assert.deepEqual(asked, [], "the object address was not sent a DELETE in place of the session's");
  assert.ok([...sessions.values()].some(s => s.key === pathname), "the multipart session is still the one the ledger tracks");
  await assert.rejects(openReservedVault(input(2), 10, measure(2)), /storage_(limit|pending)/, "the bytes stay reserved");
  // Read healthily again, the upload is cancelled at the provider and only then given back.
  assert.equal(await abortReservedVault(pathname), true);
  assert.equal([...sessions.values()].some(s => s.key === pathname), false);
  assert.equal((await openReservedVault(input(2), 10, measure(2))).ok, true);
});

test("every reader of the upload record refuses each unknown shape and does nothing", async () => {
  for (const [name, shape] of UNKNOWN) {
    const n = 100 + UNKNOWN.findIndex(([m]) => m === name);
    const opened = await openReservedVault(input(n), 10, measure(n));
    if (!opened.ok) throw new Error("open failed");
    const pathname = opened.upload.pathname;
    for (const [reader, run] of [
      ["signPieces", () => signPieces(pathname, [1])],
      ["closeVaultUpload", () => closeVaultUpload(pathname, ["a".repeat(32)])],
      ["abortVaultUpload", () => abortVaultUpload(pathname)],
      ["vaultReservationId", () => vaultReservationId(pathname)],
      ["closeReservedVault", () => closeReservedVault(pathname, ["a".repeat(32)])],
      ["abortReservedVault", () => abortReservedVault(pathname)],
    ] as [string, () => Promise<unknown>][]) {
      asked.length = 0;
      recordReads = [shape, shape];
      const outcome = await run().then(r => ({ ok: r }), e => ({ thrown: e }));
      recordReads = [];
      assert.ok("thrown" in outcome && outcome.thrown instanceof UnknownReplyError, `${reader} on ${name}: ${JSON.stringify(outcome)}`);
      assert.deepEqual(asked, [], `${reader} on ${name} asked the provider ${asked.join(", ")}`);
    }
    // The bytes are still held, and the upload is still whole.
    await assert.rejects(openReservedVault(input(n), 10, measure(n)), /storage_(limit|pending)/);
    assert.equal(await finish(pathname), true, `the upload survives ${name}`);
    assert.equal(kept(n), 10);
  }
});

test("an unacknowledged record write hands out no upload and gives its bytes back", async () => {
  for (const [name, reply] of [["no reply", () => []], ["null", () => [null]], ["a number", () => [0]], ["QUEUED", () => ["QUEUED"]], ["two replies", () => ["OK", "OK"]]] as [string, () => unknown][]) {
    const n = 200 + made;
    recordWrite = reply;
    asked.length = 0;
    const outcome = await openReservedVault(input(n), 10, measure(n)).then(r => r, e => e);
    recordWrite = null;
    assert.ok(outcome instanceof UnknownReplyError, `open on ${name}: ${JSON.stringify(outcome)}`);
    assert.deepEqual(asked, ["POST", "DELETE session"], `the session opened for ${name} is cancelled at the provider`);
    // Nothing was handed out, so the reservation is given back.
    const again = await openReservedVault(input(n), 10, measure(n));
    assert.equal(again.ok, true);
  }
});

test("confirmed absence and healthy records are read as before", async () => {
  const opened = await openReservedVault(input(300), 10, measure(300));
  if (!opened.ok) throw new Error("open failed");
  const pathname = opened.upload.pathname;
  const id = await vaultReservationId(pathname);
  assert.match(String(id), /^[a-f0-9]{32}$/);
  assert.equal((await signPieces(pathname, [1]))?.length, 1);
  assert.equal(await finish(pathname), true);
  assert.equal(kept(300), 10);
  // The record is gone after the join: a confirmed absence.
  assert.equal(await vaultReservationId(pathname), undefined);
  assert.equal(await signPieces(pathname, [1]), null);
  // A repeat of the finish is given the first one's answer (lib/vault.ts), the provider not asked.
  asked.length = 0;
  assert.deepEqual(await closeVaultUpload(pathname, ["a".repeat(32)]), { ok: true, file: { pathname, bytes: 10, contentType: "application/pdf" } });
  assert.equal(await abortVaultUpload(pathname), true);
  assert.deepEqual(asked, []);
  // A healthy cancellation asks the provider and gives the bytes back.
  const second = await openReservedVault(input(301), 10, measure(301));
  if (!second.ok) throw new Error("open failed");
  asked.length = 0;
  assert.equal(await abortReservedVault(second.upload.pathname), true);
  assert.deepEqual(asked, ["DELETE session"]);
  assert.equal((await openReservedVault(input(301), 10, measure(301))).ok, true);
});
