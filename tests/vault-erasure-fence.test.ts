/**
 * Codex L on main (L-20261120-0141, MEDIUM, privacy): a vault upload's provider reply after the store's erasure. The
 * open reserved storage, then waited on the provider's POST that makes the multipart session; an erasure that ran in
 * that wait deleted the store's live key, its pending storage and its upload records. When the provider answered,
 * openVaultUpload wrote the upload record back with a plain SET (its pathname, its size, its session id), and the
 * reservation's own writes (the bind, then the release in its catch) wrote the storage row back too, a day of data of
 * an erased store, and a session with nothing left to retire it if its DELETE was refused.
 *
 * Every write of the open now goes through the store's fence (its live key there and its erasing mark absent): a reply
 * that comes after the erasure writes nothing, retires the session it opened, and forgets nothing it did not write.
 * Synthetic store, the repository's in-memory Redis, a stand-in for R2, no real request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { openReservedVault } from "@/lib/vault-storage";
import { ERASING_KEY, erasingField } from "@/lib/store";
import type { StorageUse } from "@/lib/storage-quota";

process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.R2_ACCESS_KEY_ID = "1234567890123456";
process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
process.env.R2_BUCKET = "test-files";

const sessions = new Set<string>();
const asked: string[] = [];
let made = 0;
/** While set, the provider's POST that makes a session waits for it. */
let hold: Promise<void> | null = null;
let started: () => void = () => undefined;
let refuseDelete = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error("unexpected request " + url.href);
  const method = init?.method ?? "GET";
  const uploadId = url.searchParams.get("uploadId");
  asked.push(`${method}${uploadId ? " session" : ""}`);
  if (method === "POST" && url.searchParams.has("uploads")) {
    started();
    if (hold) await hold;
    const id = `session-${++made}`;
    sessions.add(id);
    return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (method === "DELETE" && uploadId) {
    if (refuseDelete) return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
    sessions.delete(uploadId);
    return new Response(null, { status: 204 });
  }
  // The listing the storage measure would read: an empty folder.
  if (method === "GET") return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
  throw new Error("unexpected request " + method + " " + url.href);
}) as typeof fetch;

const SID = "a".repeat(32);
const REF = "owner-vault@example.com";
const LIVE = `nl:store:id:${SID}`;
const folder = (n: number) => n.toString(16).padStart(32, "0");
const measure = async (): Promise<StorageUse> => ({ bytes: 0, brake: 10, left: 10, full: false, available: true });
const keys = async (pattern: string) => ((await redis.pipeline([["SCAN", "0", "MATCH", pattern, "COUNT", 1000]]))[0] as [string, string[]])[1];

async function openDuringErasure(n: number) {
  const field = await erasingField(REF);
  const fence = { live: LIVE, field };
  await redis.pipeline([["SET", LIVE, REF]]);
  let release: () => void = () => undefined;
  hold = new Promise<void>((done) => { release = done; });
  const asking = new Promise<void>((done) => { started = done; });
  const opening = openReservedVault({ folder: folder(n), ownerId: "product", name: "file.pdf", bytes: 10, type: "application/pdf", multipart: true, fence } as never, 10, measure)
    .then((r) => r, (e: unknown) => e);
  await asking;
  // The store's erasure runs while the provider has not answered: its mark, its live key, and the families walked.
  await redis.pipeline([["HSET", ERASING_KEY, field, String(Date.now())], ["DEL", LIVE]]);
  for (const key of [...(await keys("nl:storage:pending:*")), ...(await keys("nl:vault:up:*"))]) await redis.pipeline([["DEL", key]]);
  hold = null;
  release();
  return opening;
}

test("a provider reply after the store's erasure writes back no upload record and no storage row", async () => {
  redis.clear();
  asked.length = 0;
  const outcome = await openDuringErasure(1);
  assert.equal((outcome as { ok?: boolean }).ok === true, false, `the erased store is handed out no upload: ${JSON.stringify(outcome)}`);
  assert.deepEqual(await keys("nl:vault:up:*"), [], "no upload record of the erased store is written back");
  assert.deepEqual(await keys("nl:storage:pending:*"), [], "no storage row of the erased store is written back");
  assert.equal(sessions.size, 0, "the session made for it is retired at the provider");
  assert.ok(asked.includes("DELETE session"), `the provider was asked to retire it: ${asked.join(", ")}`);
});

test("when the provider refuses that retirement, still nothing of the erased store is written", async () => {
  redis.clear();
  sessions.clear();
  refuseDelete = true;
  const outcome = await openDuringErasure(2).finally(() => { refuseDelete = false; });
  assert.equal((outcome as { ok?: boolean }).ok === true, false);
  assert.deepEqual([await keys("nl:vault:up:*"), await keys("nl:storage:pending:*")], [[], []]);
});

test("control: a live store's upload opens, with its record and its storage row", async () => {
  redis.clear();
  sessions.clear();
  await redis.pipeline([["SET", LIVE, REF]]);
  const fence = { live: LIVE, field: await erasingField(REF) };
  const opened = await openReservedVault({ folder: folder(3), ownerId: "product", name: "file.pdf", bytes: 10, type: "application/pdf", multipart: true, fence } as never, 10, measure);
  assert.equal(opened.ok, true);
  assert.equal((await keys("nl:vault:up:*")).length, 1);
  assert.equal((await keys("nl:storage:pending:*")).length, 1);
  assert.equal(sessions.size, 1);
});
