import { openReservedVault, abortReservedVault } from "@/lib/vault-storage";
import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { reserveStorage, bindStorage, releaseStorage, retireStorage } from "@/lib/storage-reservations";

const original = store.run.bind(store);
let unavailable = false;
let unknownAcknowledgement = false;
store.run = ((command: (string | number)[]) => {
  if (String(command[0]).toUpperCase() !== "EVAL") return original(command);
  if (unavailable) throw new Error("EVAL unavailable");
  const source = String(command[1]);
  const count = Number(command[2]);
  const keys = command.slice(3, 3 + count);
  const args = command.slice(3 + count);
  if (original(["GET", keys[0]]) !== args[0]) return 0;
  if (source.includes('redis.call("SET", KEYS[2]')) { original(["SET", keys[1], args[1]]); return unknownAcknowledgement ? true : 1; }
  if (source.includes('redis.call("DEL", KEYS[1])')) return original(["DEL", keys[0]]);
  throw new Error("unexpected script");
}) as typeof store.run;
const folder = (n: number) => n.toString(16).padStart(32, "0");

test("concurrent admissions include pending bytes and allow exact fits", async () => {
  const outcomes = await Promise.allSettled(Array.from({length: 3}, () => reserveStorage(folder(1), 7, 10, async () => 0)));
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const exact = await Promise.all([reserveStorage(folder(2), 5, 10, async () => 0), reserveStorage(folder(2), 5, 10, async () => 0)]);
  assert.equal(exact.length, 2);
  await assert.rejects(reserveStorage(folder(2), 1, 10, async () => 0), /storage_(limit|pending)/);
});
test("complete objects, unknown measurements and corrupt ledgers deny admission", async () => {
  await assert.rejects(reserveStorage(folder(3), 3, 10, async () => 8), /storage_limit/);
  await assert.rejects(reserveStorage(folder(3), 1, 10, async () => NaN), /storage_unknown/);
  original(["SET", "nl:storage:pending:" + folder(3), "{}"]);
  await assert.rejects(reserveStorage(folder(3), 1, 10, async () => 0), /storage_unknown/);
});
test("provider refusal retains capacity beyond expiration; confirmed retirement releases it", async () => {
  const entry = await reserveStorage(folder(4), 10, 10, async () => 0);
  await bindStorage(folder(4), entry.id, "vault/" + folder(4) + "/product/0123456789abcdef-file", "provider-session");
  assert.equal(await retireStorage(folder(4), Date.now() + 1000, async row => { assert.equal(row.uploadId, "provider-session"); return false; }), false);
  await assert.rejects(reserveStorage(folder(4), 1, 10, async () => 0), /storage_(limit|pending)/);
  assert.equal(await retireStorage(folder(4), Date.now() + 1000, async () => true), true);
  await reserveStorage(folder(4), 10, 10, async () => 0);
});
test("lost leases cannot persist stale reservations or delete a successor lease", async () => {
  const lock = "nl:storage:pending:" + folder(5) + ":lock";
  await assert.rejects(reserveStorage(folder(5), 1, 10, async () => { original(["SET", lock, "successor"]); return 0; }), /storage_lease_lost/);
  assert.equal(original(["GET", lock]), "successor");
  assert.equal(original(["GET", "nl:storage:pending:" + folder(5)]), null);
});
test("missing atomic scripting fails closed without fallback", async () => {
  unavailable = true;
  try { await assert.rejects(reserveStorage(folder(6), 1, 10, async () => 0), /EVAL unavailable/); }
  finally { unavailable = false; }
  assert.equal(original(["GET", "nl:storage:pending:" + folder(6)]), null);
});
test("an uncertain write acknowledgement cannot authorize space or forget a committed reservation", async () => {
  unknownAcknowledgement = true;
  try { await assert.rejects(reserveStorage(folder(10), 10, 10, async () => 0), /storage_lease_lost/); }
  finally { unknownAcknowledgement = false; }
  await assert.rejects(reserveStorage(folder(10), 1, 10, async () => 0), /storage_(limit|pending)/);
});
test("malformed JSON is unknown capacity rather than an empty ledger", async () => {
  for (const raw of ["", "null", "not-json", "[null]"]) {
    original(["SET", "nl:storage:pending:" + folder(11), raw]);
    await assert.rejects(reserveStorage(folder(11), 1, 10, async () => 0), /storage_unknown/);
  }
});
test("release is idempotent and unpublished sessions can be retired", async () => {
  const entry = await reserveStorage(folder(7), 10, 10, async () => 0);
  await releaseStorage(folder(7), entry.id);
  await releaseStorage(folder(7), entry.id);
  await reserveStorage(folder(7), 10, 10, async () => 0);
  assert.equal(await retireStorage(folder(7), Date.now() + 1000, async () => { throw new Error("unbound session must not call provider"); }), true);
});

test("R2 opens reserve capacity and failed provider cancellation cannot free it", async () => {
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "1234567890123456";
  process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
  process.env.R2_BUCKET = "test-files";
  delete process.env.BUNNY_STREAM_API_KEY;
  const saved = globalThis.fetch;
  let cancel = false;
  let missingSession = false;
  let completedObject = false;
  let openedSessions = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (!String(_url).includes("r2.cloudflarestorage.com")) throw new Error("Unexpected provider request");
    if (init?.method === "POST") { openedSessions++; return new Response("<UploadId>test-session</UploadId>"); }
    if (init?.method === "DELETE") return new Response(null, {status: missingSession ? 404 : cancel ? 204 : 503});
    if (init?.method === "HEAD") return completedObject ? new Response(null, { headers: { "content-length": "10", "content-type": "application/pdf" } }) : new Response(null, { status: 404 });
    return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
  }) as typeof fetch;
  const input = {folder: folder(8), ownerId: "product", name: "file.pdf", bytes: 10, type: "application/pdf"};
  try {
    const opened = await openReservedVault(input, 10, async () => ({ bytes: 0, brake: 10, left: 10, full: false, available: true }));
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("open failed");
    assert.equal(opened.upload.multipart, true);
    await assert.rejects(openReservedVault(input, 10, async () => ({ bytes: 0, brake: 10, left: 10, full: false, available: true })), /storage_(limit|pending)/);
    assert.equal(await abortReservedVault(opened.upload.pathname), false);
    await assert.rejects(openReservedVault(input, 10, async () => ({ bytes: 0, brake: 10, left: 10, full: false, available: true })), /storage_(limit|pending)/);
    // An unconfirmed cancel is not written down (lib/vault.ts): a retry,
    // inside the requests one upload is priced for, asks the provider again,
    // and once it confirms, the bytes come back at once.
    cancel = true;
    assert.equal(await abortReservedVault(opened.upload.pathname), true);
    const reopened = await openReservedVault(input, 10, async () => ({ bytes: 0, brake: 10, left: 10, full: false, available: true }));
    assert.equal(reopened.ok, true);
    if (!reopened.ok) throw new Error("reopen failed");
    missingSession = true;
    completedObject = true;
    assert.equal(await abortReservedVault(reopened.upload.pathname), true);
    await assert.rejects(reserveStorage(input.folder, 1, 10, async () => 10), /storage_limit/);
    const openedBefore = openedSessions;
    await assert.rejects(openReservedVault({ ...input, folder: folder(9) }, 10, async () => ({ bytes: 0, brake: 10, left: 0, full: false, available: false })), /storage_unknown/);
    assert.equal(openedSessions, openedBefore);
  } finally { globalThis.fetch = saved; }
});
