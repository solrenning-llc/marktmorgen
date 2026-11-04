/**
 * 273 [BK1]: where a sealed backup is kept (lib/backup-store.ts): a bucket of
 * its own at Cloudflare R2, written create-only and read back under a byte
 * cap, against a stand-in R2 (fetch replaced; nothing real is reached). Off
 * until the owner's own BACKUP_R2_* settings exist (docs/backup.md).
 *
 * What fails here:
 *   - a backup written over another (each write is create-only: If-None-Match: *,
 *     signed, and a 412 is a failure, never a success);
 *   - the sold files' bucket or keys used for backups;
 *   - a read past its cap held whole, or an unreadable answer taken as a backup;
 *   - any request not signed, or any delete at all.
 */
import { backupStoreConfig, r2BackupStore } from "@/lib/backup-store";
import { verifyBackupRoundtrip } from "@/lib/backup-roundtrip";
import type { BackupSnapshot } from "@/lib/backup-codec";
import { createHash } from "node:crypto";
import { done, is, part } from "./check";

const objects = new Map<string, Uint8Array>();
const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
let down = false;
/** When set, every answer is this status (a redirect, a busy store). */
let answer: number | null = null;
/** When set, reads stream their bytes with no content-length, in chunks. */
let unstated = false;
/** Every PUT whose x-amz-content-sha256 is not the SHA-256 of its body. */
const badHashes: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ method, url, headers });
  if (down) throw new TypeError("fetch failed");
  if (init?.redirect !== "error") return new Response("redirects must be refused", { status: 599 });
  if (answer) return new Response("", { status: answer, headers: answer >= 300 && answer < 400 ? { location: "https://elsewhere.example/" } : {} });
  const path = new URL(url).pathname;
  if (method === "PUT") {
    const body = new Uint8Array(init?.body as Uint8Array);
    if (headers["x-amz-content-sha256"] !== createHash("sha256").update(body).digest("hex")) badHashes.push(url);
    if (headers["if-none-match"] === "*" && objects.has(path)) return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
    objects.set(path, new Uint8Array(init?.body as Uint8Array));
    return new Response("", { status: 200 });
  }
  if (method === "GET") {
    const held = objects.get(path);
    if (!held) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    if (unstated) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < held.byteLength; at += 8) controller.enqueue(held.slice(at, at + 8));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return new Response(held as BodyInit, { status: 200, headers: { "content-length": String(held.byteLength) } });
  }
  return new Response("", { status: 405 });
}) as typeof fetch;

const ACCOUNT = "a".repeat(32);
function settings(over: Record<string, string> = {}) {
  for (const name of ["BACKUP_R2_ACCOUNT_ID", "BACKUP_R2_BUCKET", "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ACCESS_KEY_ID"]) delete process.env[name];
  Object.assign(process.env, {
    BACKUP_R2_ACCOUNT_ID: ACCOUNT,
    BACKUP_R2_BUCKET: "marktmorgen-backups",
    BACKUP_R2_ACCESS_KEY_ID: "BACKUPKEYID00000001",
    BACKUP_R2_SECRET_ACCESS_KEY: "s".repeat(40),
    R2_BUCKET: "marktmorgen-files",
    R2_ACCESS_KEY_ID: "SOLDFILESKEY0000001",
    ...over,
  });
}
const refuses = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
};

async function main(): Promise<void> {
  part("Off until the owner's own settings exist, and never on the sold files' bucket or keys");
  for (const name of ["BACKUP_R2_ACCOUNT_ID", "BACKUP_R2_BUCKET", "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY"]) delete process.env[name];
  is("no settings: off", backupStoreConfig(), null);
  settings({ BACKUP_R2_BUCKET: "marktmorgen-files" });
  is("the sold files' bucket: off", backupStoreConfig(), null);
  settings({ BACKUP_R2_ACCESS_KEY_ID: "SOLDFILESKEY0000001" });
  is("the sold files' key: off", backupStoreConfig(), null);
  settings({ BACKUP_R2_ACCOUNT_ID: "not-an-account" });
  is("a malformed account: off", backupStoreConfig(), null);
  settings();
  const config = backupStoreConfig();
  is("its own bucket and key: on", [config?.bucket, config?.endpoint], ["marktmorgen-backups", `https://${ACCOUNT}.r2.cloudflarestorage.com`]);
  settings({ BACKUP_R2_JURISDICTION: "eu" });
  is("a bucket in the EU jurisdiction: its own address", backupStoreConfig()?.endpoint, `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
  settings({ BACKUP_R2_JURISDICTION: "mars" });
  is("an unknown jurisdiction: off", backupStoreConfig(), null);
  delete process.env.BACKUP_R2_JURISDICTION;
  settings();

  part("Written once, read back whole, through the read-back the backup needs");
  const store = r2BackupStore(config!);
  const snapshot: BackupSnapshot = { version: 1, capturedAt: 1_792_640_000_000, rows: [{ key: "nl:synthetic:one", dump: Buffer.from("synthetic").toString("base64"), expiresAt: null }] };
  const proof = await verifyBackupRoundtrip(snapshot, Buffer.alloc(32, 3), store, 65_536);
  const put = calls.find((c) => c.method === "PUT")!;
  is("one object, under backups/, named by its id", [objects.size, put.url.endsWith(`/marktmorgen-backups/backups/${proof.id}.mmbk`)], [1, true]);
  is("create-only, and signed with it", [put.headers["if-none-match"], put.headers.authorization?.startsWith("AWS4-HMAC-SHA256 "), /SignedHeaders=[^,]*if-none-match/.test(put.headers.authorization ?? "")], ["*", true, true]);
  is("every request signed, the body's hash the body's", [calls.every((c) => c.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")), badHashes], [true, []]);
  is("never a delete, and no way to ask for one", [calls.some((c) => c.method === "DELETE"), Object.hasOwn(store, "delete")], [false, false]);

  part("What is never taken as a backup");
  is("an id that is not one: refused before any request", await refuses(() => store.putNew("../other", new Uint8Array([1]))), true);
  const id = proof.id;
  is("a second write under the same id: refused (412), the first kept", [await refuses(() => store.putNew(id, new Uint8Array([9]))), objects.get(`/marktmorgen-backups/backups/${id}.mmbk`)!.byteLength > 1], [true, true]);
  is("a read past its cap: refused", await refuses(() => store.read(id, 10)), true);
  unstated = true;
  is("and so when the store states no length, counted as it streams", [await refuses(() => store.read(id, 10)), (await store.read(id, 65_536)).byteLength > 10], [true, true]);
  unstated = false;
  is("a cap that is not a count of bytes: refused", [await refuses(() => store.read(id, Number.NaN)), await refuses(() => store.read(id, 0))], [true, true]);
  for (const status of [303, 409, 503]) {
    answer = status;
    is(`an answer of ${status}: refused, never taken as written or read`, [await refuses(() => store.putNew("22222222-2222-4222-8222-222222222222", new Uint8Array([1]))), await refuses(() => store.read(id, 65_536))], [true, true]);
    answer = null;
  }
  is("a missing object: refused", await refuses(() => store.read("00000000-0000-4000-8000-000000000000", 65_536)), true);
  down = true;
  is("an unreachable store: refused", [await refuses(() => store.putNew("11111111-1111-4111-8111-111111111111", new Uint8Array([1]))), await refuses(() => store.read(id, 65_536))], [true, true]);
  down = false;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
