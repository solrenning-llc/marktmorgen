import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { store } from "./redis-stub";
import { openReservedVault } from "@/lib/vault-storage";

// The same atomic-script stand-in tests/storage-reservations.test.ts uses.
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

test("an abandoned upload the provider already removed gives its reserved bytes back", async () => {
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "1234567890123456";
  process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
  process.env.R2_BUCKET = "test-files";
  const folder = "cd".repeat(16);
  const saved = globalThis.fetch;
  let sessionsGone = false;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("r2.cloudflarestorage.com")) throw new Error("Unexpected provider request");
    if (init?.method === "POST") return new Response("<UploadId>session-1</UploadId>");
    // R2's lifecycle rule aborted the incomplete upload: the session is gone, and no object was ever completed.
    if (init?.method === "DELETE") return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: sessionsGone ? 404 : 204 });
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
  }) as typeof fetch;
  const empty = async () => ({ bytes: 0, brake: 100, left: 100, full: false, available: true });
  const input = { folder, ownerId: "product", name: "file.pdf", bytes: 100, type: "application/pdf" };
  try {
    const opened = await openReservedVault(input, 100, empty);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("open failed");
    // The creator closed the tab. Eight days later the upload's own record has expired (UPLOAD_SECONDS),
    // and R2's default rule has aborted the incomplete multipart upload (7 days).
    original(["DEL", `nl:vault:up:${createHash("sha256").update(opened.upload.pathname).digest("hex").slice(0, 40)}`]);
    const ledger = "nl:storage:pending:" + folder;
    const rows = JSON.parse(String(original(["GET", ledger]))) as { at: number }[];
    for (const row of rows) row.at -= 8 * 24 * 60 * 60 * 1000;
    original(["SET", ledger, JSON.stringify(rows)]);
    sessionsGone = true;
    // Nothing is stored and nothing can be: the store's whole room must be usable again.
    const again = await openReservedVault(input, 100, empty);
    assert.equal(again.ok, true);
  } finally { globalThis.fetch = saved; }
});
