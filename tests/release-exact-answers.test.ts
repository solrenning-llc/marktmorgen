/**
 * Rule 24 (inventory of tolerant reads, 9 November 2026): letting go of a lock
 * or a storage reservation, and deleting an affiliate book's draft thrown away,
 * are read in their exact answer. A failure, or an answer in another shape, goes
 * to the server's log and is never taken for done: what was held runs out at its
 * own expiry, as before, but nobody is told it was let go of.
 *
 *   - releaseLock (lib/redis-lock.ts) says "released", "not-held" or "unknown",
 *     and logs "unknown" (the script could not run, or answered something else);
 *   - storage-reservations' lease is let go of by releaseLock, so a failure there
 *     is logged too, and the reservation already written stays;
 *   - openReservedVault's cleanup logs a reservation it could not let go of
 *     (it was dropped in silence), and still throws the first error;
 *   - an affiliate book's draft or book that could not be deleted is logged.
 *
 * Synthetic data only: the in-memory Redis stand-in and a stubbed R2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { releaseLock, takeLock } from "@/lib/redis-lock";
import { reserveStorage } from "@/lib/storage-reservations";
import { openReservedVault } from "@/lib/vault-storage";
import { forgetBookSnapshot, writeSnapshot } from "@/lib/affiliate-book-snapshot";
import type { Book } from "@/lib/affiliates";
import type { Store } from "@/lib/store";

const run = store.run.bind(store);
const PASS = Symbol("pass");
let hook: ((command: (string | number)[]) => unknown) | null = null;
let failStorageWrites = false;
const isRelease = (command: (string | number)[]) =>
  String(command[0]).toUpperCase() === "EVAL" && String(command[1]).startsWith("-- marktmorgen:release:v1\n");
store.run = ((command: (string | number)[]) => {
  if (hook) {
    const answer = hook(command);
    if (answer !== PASS) return answer;
  }
  // lib/storage-reservations.ts WRITE (not named for the stand-in): sets KEYS[2] only while KEYS[1] holds ARGV[1].
  if (String(command[0]).toUpperCase() === "EVAL" && String(command[1]).includes('redis.call("SET", KEYS[2], ARGV[2])') && !String(command[1]).startsWith("--")) {
    if (failStorageWrites) return 0;
    const [lock, record, token, value] = [command[3], command[4], command[5], command[6]];
    if (run(["GET", lock]) !== token) return 0;
    run(["SET", record, value]);
    return 1;
  }
  return run(command);
}) as typeof store.run;

async function logged<T>(work: () => Promise<T>): Promise<{ lines: string[]; value?: T; error?: unknown }> {
  const lines: string[] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  try {
    return { lines, value: await work() };
  } catch (error) {
    return { lines, error };
  } finally {
    console.error = saved;
  }
}
const folder = (n: number) => n.toString(16).padStart(32, "0");

test("releaseLock says released only when the script answered exactly 1, and logs nothing then", async () => {
  const held = await takeLock("nl:test:release:1", 60, 0);
  const out = await logged(() => releaseLock(held));
  assert.equal(out.value, "released");
  assert.deepEqual(out.lines, []);
  assert.equal(run(["GET", held.key]), null);
});

test("releaseLock on a lock that ran out and is somebody else's: not-held, theirs kept, nothing logged", async () => {
  const held = await takeLock("nl:test:release:2", 60, 0);
  run(["SET", held.key, "successor"]);
  const out = await logged(() => releaseLock(held));
  assert.equal(out.value, "not-held");
  assert.deepEqual(out.lines, []);
  assert.equal(run(["GET", held.key]), "successor");
});

test("releaseLock whose script cannot run, or answers in another shape, is unknown and logged; the lock is left to run out", async () => {
  for (const answer of [() => { throw new Error("EVAL down"); }, () => "1", () => true, () => 2]) {
    const held = await takeLock("nl:test:release:3", 60, 0);
    hook = (command) => (isRelease(command) ? answer() : PASS);
    let out;
    try {
      out = await logged(() => releaseLock(held));
    } finally {
      hook = null;
    }
    assert.equal(out.error, undefined, "releaseLock never throws");
    assert.equal(out.value, "unknown");
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /letting go of a lock/);
    assert.doesNotMatch(out.lines[0], /nl:test/, "the lock's key (it can name an address) is not logged");
    assert.equal(run(["GET", held.key]), held.token, "never deleted as a second step");
    run(["DEL", held.key]);
  }
});

test("a storage reservation whose lease cannot be let go of is kept and the failure is logged", async () => {
  for (const [n, answer] of [() => { throw new Error("EVAL down"); }, () => "OK"].entries()) {
    const f = folder(0x51 + n);
    hook = (command) => (isRelease(command) ? answer() : PASS);
    let out;
    try {
      out = await logged(() => reserveStorage(f, 3, 10, async () => 0));
    } finally {
      hook = null;
    }
    assert.equal(out.error, undefined);
    assert.equal(out.value?.bytes, 3, "the reservation written under the lease stays");
    assert.ok(out.lines.some((line) => /letting go of a lock/.test(line)), `logged: ${JSON.stringify(out.lines)}`);
    assert.notEqual(run(["GET", "nl:storage:pending:" + f + ":lock"]), null, "the lease runs out at its own expiry");
  }
});

test("openReservedVault's cleanup logs a reservation it could not let go of, and still throws the first error", async () => {
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "1234567890123456";
  process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
  process.env.R2_BUCKET = "test-files";
  delete process.env.BUNNY_STREAM_API_KEY;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("r2.cloudflarestorage.com")) throw new Error("Unexpected provider request");
    if (init?.method === "POST") {
      // The session is open: from here every write of the ledger is lost, so binding fails, and so does letting go.
      failStorageWrites = true;
      return new Response("<UploadId>test-session</UploadId>");
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
  }) as typeof fetch;
  const input = { folder: folder(0x60), ownerId: "product", name: "file.pdf", bytes: 10, type: "application/pdf" };
  let out;
  try {
    out = await logged(() => openReservedVault(input, 10, async () => ({ bytes: 0, brake: 10, left: 10, full: false, available: true })));
  } finally {
    globalThis.fetch = saved;
    failStorageWrites = false;
  }
  assert.match(String((out.error as Error | undefined)?.message), /storage_lease_lost/, "the bind's own error is what is thrown");
  assert.ok(out.lines.some((line) => /storage reservation retained/.test(line)), `logged: ${JSON.stringify(out.lines)}`);
  const ledger = JSON.parse(String(run(["GET", "nl:storage:pending:" + input.folder])));
  assert.equal(ledger.length, 1, "the reservation is still counted, never freed in silence");
});

const emptyBook: Book = { rows: [], lines: [], payouts: [], currency: "usd", elsewhere: 0, refundsChecked: true, invoicesChecked: true };

test("an affiliate book erasure whose DEL fails, or answers in another shape, logs it and still throws the script's error", async () => {
  for (const answer of [() => { throw new Error("DEL down"); }, () => "1"]) {
    run(["HSET", "nl:aff:S1:book", "_at", "1"]);
    hook = (command) => {
      const name = String(command[0]).toUpperCase();
      if (name === "EVAL") throw new Error("script down");
      if (name === "DEL") return answer();
      return PASS;
    };
    let out;
    try {
      out = await logged(() => forgetBookSnapshot("S1"));
    } finally {
      hook = null;
    }
    assert.match(String((out.error as Error | undefined)?.message), /script down/);
    assert.ok(out.lines.some((line) => /affiliate book/.test(line) && /delet/.test(line)), `logged: ${JSON.stringify(out.lines)}`);
    run(["DEL", "nl:aff:S1:book"]);
  }
});

test("an affiliate book draft thrown away whose DEL fails, or answers in another shape, is logged; the write still keeps nothing", async () => {
  for (const answer of [() => { throw new Error("DEL down"); }, () => "OK"]) {
    let evals = 0;
    hook = (command) => {
      const name = String(command[0]).toUpperCase();
      // BOOK_BEGIN answers 1; BOOK_COMMIT answers 0 (the lock was lost), so the draft is thrown away.
      if (name === "EVAL") return evals++ === 0 ? 1 : 0;
      if (name === "DEL") return answer();
      return PASS;
    };
    let out;
    try {
      out = await logged(() =>
        writeSnapshot({ statsId: "S2" } as unknown as Store, emptyBook, Date.now(), { key: "nl:aff:S2:book:lock", token: "t", ttlSeconds: 60 }, "1", 1),
      );
    } finally {
      hook = null;
    }
    assert.equal(out.error, undefined);
    assert.equal(out.value, null);
    assert.ok(out.lines.some((line) => /affiliate book/.test(line) && /delet/.test(line)), `logged: ${JSON.stringify(out.lines)}`);
  }
});
