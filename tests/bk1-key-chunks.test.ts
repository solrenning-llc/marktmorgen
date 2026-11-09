/**
 * 273 [BK1]: one key larger than a part (the inventory of 9 November 2026: the affiliate book's snapshot under
 * nl:aff: may take 8,000,000 bytes, lib/affiliate-book-snapshot.ts BOOK_SNAPSHOT_MAX_BYTES; a part holds 4 MiB less
 * 1 KiB) never stops the whole daily copy. Such a key is copied in chunks over consecutive parts, each chunk carrying
 * the key's whole length and SHA-256, checked when the set is read and when it is restored; a key over the code's own
 * ceiling (BACKUP_KEY_MAX_BYTES) is left out under its own alarm state, the rest is still written as a verifiable set,
 * that set is never marked as the last good copy, and the previous good set is kept. Synthetic data only; the backup
 * stays off (BACKUP_COST_REVIEW is null).
 *
 * What fails here:
 *   - a key with an 8 MB DUMP that refuses the run ("too_big"), or that comes back other than byte for byte, in the
 *     repository's reader, after a restore, or in the offline tool;
 *   - a key cut short, a chunk missing, out of order or with another sum read back as whole;
 *   - a part holding a chunk that an older reader (openBackup, restoreRows) takes as a whole row;
 *   - a key over the ceiling that stops the copy of the others, is cut short, is silently skipped (the set read as
 *     whole), moves the last good copy's mark, or deletes the previous good set;
 *   - no ceiling, or one below the largest proven writer.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as parts from "@/lib/backup-parts";
import * as codec from "@/lib/backup-codec";
import { backupPeakSets, runBackup, type BackupCostReview } from "@/lib/backup-run";
import { backupAlarmSignal } from "@/lib/backup-alarm";
import type { BackupBucket, BackupObjectStore } from "@/lib/backup-roundtrip";
import { BACKUP_MONTH_MARK } from "@/lib/backup-store";
import { redisPipelineBase64 } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-09T03:00:00Z");
const DAY = 86_400_000;
const key = Buffer.alloc(32, 7);
const BIG = "nl:aff:synthetic:book";
const PART_FORMAT = { magicV1: Buffer.from("MMBK1"), aadV1: Buffer.from("marktmorgen/backup/v1"), magic: Buffer.from("MMBK2"), aad: Buffer.from("marktmorgen/backup/v2") };
const RESTORE = join(process.cwd(), "scripts/backup-restore-offline.mjs");
const run = (args: string[], input: string) => spawnSync(process.execPath, [RESTORE, ...args], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const settles = (p: Promise<unknown>) => p.then(() => "read", () => "refused");
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
type Row = { key: string; dump: string; expiresAt: number | null };

function memoryStore(): BackupObjectStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    putNew: async (id, bytes) => {
      if (objects.has(id)) throw new Error("exists");
      objects.set(id, new Uint8Array(bytes));
    },
    read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
  };
}

/** Twenty small keys of ours and one affiliate book of 8,000,000 bytes, the largest proven writer. */
function seed(): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < 20; i += 1) values.set(`nl:bk:chunk:${String(i).padStart(2, "0")}`, `v${i}-`.padEnd(500, String.fromCharCode(97 + i)));
  // Not compressible, so the parts are as large as the key: 6,000,000 random bytes as 8,000,000 base64 characters.
  let text = "";
  let state = 12345;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: string[] = [];
  for (let i = 0; i < 8_000_000; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out.push(chars[state & 63]);
    if (out.length === 65_536) {
      text += out.join("");
      out.length = 0;
    }
  }
  text += out.join("");
  values.set(BIG, text);
  for (const [name, value] of values) redis.run(["SET", name, value]);
  return values;
}

const allRows = async (id: string, store: BackupObjectStore, options?: unknown): Promise<Row[]> => {
  const rows: Row[] = [];
  const read = parts.readBackupSet as unknown as (...args: unknown[]) => Promise<unknown>;
  await read(id, key, store, 1_000_000_000, async (snapshot: { rows: Row[] }) => void rows.push(...snapshot.rows), ...(options ? [options] : []));
  return rows;
};

async function main(): Promise<void> {
  const CEILING = (parts as { BACKUP_KEY_MAX_BYTES?: number }).BACKUP_KEY_MAX_BYTES;
  part("A ceiling on one key, above the largest proven writer");
  is("BACKUP_KEY_MAX_BYTES: at least the 8,000,000 bytes of the affiliate book and its DUMP framing, under Upstash's 100 MiB record", typeof CEILING === "number" && CEILING >= 8_000_000 + 64 && CEILING < 100 * 1024 * 1024, true);
  const ceiling = CEILING ?? 12 * 1024 * 1024;

  part("One key with an 8 MB DUMP does not stop the run, and comes back byte for byte");
  redis.clear();
  redis.now = () => T0;
  const values = seed();
  const [bigDump] = (await redisPipelineBase64([["DUMP", BIG]])) as string[];
  is(`the book's DUMP is larger than a part holds (${Buffer.from(bigDump, "base64").length} bytes)`, Buffer.from(bigDump, "base64").length > parts.PART_MAX_BYTES, true);
  const store = memoryStore();
  const limits = { maxRows: 100, maxCommands: 1_000, maxParts: 20, maxRunBytes: 64 * 1024 * 1024, batch: 7, now: T0 };
  const made = await parts.copyInParts(limits, key, store);
  is("copied: every key, the book in chunks over several parts", [made.ok, made.ok && made.keys, made.ok && made.parts >= 3, made.ok ? "" : made.reason], [true, 21, true, ""]);
  is("no stored object over a part's bound", [...store.objects.values()].every((bytes) => bytes.byteLength <= parts.PART_MAX_BYTES + parts.PART_SEAL_ROOM), true);
  const rows = made.ok ? await allRows(made.id, store).catch(() => [] as Row[]) : [];
  const big = rows.find((row) => row.key === BIG);
  is("read back: every key once, the book whole and byte for byte as its DUMP", [rows.length, new Set(rows.map((r) => r.key)).size, big?.dump === bigDump, big?.expiresAt], [21, 21, true, null]);
  {
    // Restored into an empty database: every value as it was.
    redis.clear();
    for (const row of rows) redis.run(["RESTORE", row.key, 0, Buffer.from(row.dump, "base64").toString("utf8")]);
    is("restored: every value as it was, the book's 8,000,000 bytes included", [...values].every(([name, value]) => redis.run(["GET", name]) === value), true);
    redis.clear();
    redis.now = () => T0;
    seed();
  }

  part("A chunk is checked: an older reader refuses it, and a chunk missing, moved or changed is never read as whole");
  if (made.ok) {
    const manifest = parts.openManifest(store.objects.get(made.id)!, key);
    const refusedByOld = manifest.parts.filter((p) => throws(() => codec.openBackup(store.objects.get(p.id)!, key)));
    is("a part holding a chunk is refused by openBackup (no older reader takes a piece for a key)", refusedByOld.length >= 2, true);
    const reseal = (list: typeof manifest.parts) => {
      const id = `${"a".repeat(8)}-aaaa-4aaa-8aaa-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
      store.objects.set(id, parts.sealManifest({ ...manifest, parts: list, rows: list.reduce((n, p) => n + p.rows, 0) }, key));
      return id;
    };
    const chunkAt = manifest.parts.findIndex((p) => refusedByOld.includes(p));
    const withoutMiddle = manifest.parts.filter((_, i) => i !== chunkAt + 1);
    is("a chunk's part left out of the manifest: refused", await settles(allRows(reseal(withoutMiddle), store)), "refused");
    const swapped = [...manifest.parts];
    [swapped[chunkAt], swapped[chunkAt + 1]] = [swapped[chunkAt + 1], swapped[chunkAt]];
    is("two chunks' parts swapped: refused", await settles(allRows(reseal(swapped), store)), "refused");
    // A chunk's part sealed again with its sum changed (as only the key's holder could): refused at the key's sum.
    const target = manifest.parts[chunkAt];
    const packed = codec.openSealed(PART_FORMAT, key, Buffer.from(store.objects.get(target.id)!));
    const snapshot = JSON.parse(gunzipSync(packed).toString("utf8")) as { rows: { chunk?: { sha256: string } }[] };
    for (const row of snapshot.rows) if (row.chunk) row.chunk.sha256 = "0".repeat(64);
    const forged = codec.sealWithKid(PART_FORMAT, key, gzipSync(JSON.stringify(snapshot)));
    const forgedId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
    store.objects.set(forgedId, forged);
    const changed = manifest.parts.map((p, i) => (i === chunkAt ? { ...p, id: forgedId, bytes: forged.length, sha256: sha(forged) } : p));
    is("a chunk whose key sum differs: refused", await settles(allRows(reseal(changed), store)), "refused");
    const chunkRows = snapshot.rows.filter((row) => row.chunk);
    is("a snapshot holding a chunk is never restored as rows (restoreRows refuses it)", throws(() => codec.restoreRows({ version: 1, capturedAt: T0, rows: chunkRows } as never, T0)), true);
  }

  part("The offline tool reads the chunked key the same, byte for byte");
  const dir = mkdtempSync(join(tmpdir(), "bk1-chunks-"));
  try {
    if (made.ok) {
      const manifest = parts.openManifest(store.objects.get(made.id)!, key);
      for (const id of [made.id, ...manifest.parts.map((p) => p.id)]) writeFileSync(join(dir, `${id}.mmbk`), store.objects.get(id)!);
    }
    const out = join(dir, "restored.json");
    const offline = run([dir, made.ok ? made.id : "x", "--out", out], `${key.toString("base64")}\n`);
    const restored = offline.status === 0 && existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { rows: Row[] }) : null;
    is("offline: done, 21 rows, the book whole as its DUMP", [offline.status, restored?.rows.length, restored?.rows.find((row) => row.key === BIG)?.dump === bigDump], [0, 21, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  part("A key over the ceiling: left out under its own state, the rest still written and verifiable, never whole");
  redis.run(["SET", "nl:synthetic:huge", "h".repeat(ceiling + 1)]);
  const over = memoryStore();
  const partial = (await parts.copyInParts(limits, key, over)) as unknown as { ok: boolean; reason?: string; id?: string; missing?: number; keys?: number };
  is("the copy says so: key_over_ceiling, one key missing, with the set it wrote", [partial.ok, partial.reason, partial.missing, typeof partial.id], [false, "key_over_ceiling", 1, "string"]);
  if (typeof partial.id === "string" && over.objects.has(partial.id)) {
    const manifest = parts.openManifest(over.objects.get(partial.id)!, key) as unknown as { missing?: number };
    is("its manifest carries the missing count", manifest.missing, 1);
    is("read as a set: refused, never taken as whole", await settles(allRows(partial.id, over)), "refused");
    const rest = await allRows(partial.id, over, { allowIncomplete: true }).catch(() => [] as Row[]);
    is("read knowingly as incomplete: every other key, the book whole, and no piece of the huge key", [rest.length, rest.find((r) => r.key === BIG)?.dump === bigDump, rest.some((r) => r.key === "nl:synthetic:huge")], [21, true, false]);
    const dir2 = mkdtempSync(join(tmpdir(), "bk1-chunks-"));
    try {
      const m = parts.openManifest(over.objects.get(partial.id)!, key);
      for (const id of [partial.id, ...m.parts.map((p) => p.id)]) writeFileSync(join(dir2, `${id}.mmbk`), over.objects.get(id)!);
      const check = run([dir2, partial.id], `${key.toString("base64")}\n`);
      is("offline check of an incomplete set: refused, saying so", [check.status !== 0, /incomplete/.test(check.stderr)], [true, true]);
      const knowingly = run([dir2, partial.id, "--incomplete"], `${key.toString("base64")}\n`);
      const summary = knowingly.status === 0 ? (JSON.parse(knowingly.stdout) as { rows: number; missing: number }) : null;
      is("offline with --incomplete: the rest counted, the missing count shown", [summary?.rows, summary?.missing], [21, 1]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } else {
    is("its manifest is there", false, true);
  }

  part("The run: its own alarm state, the last good copy's mark unmoved, the previous good set kept");
  {
    redis.clear();
    let clock = T0;
    redis.now = () => clock;
    seed();
    const runStore = memoryStore();
    const writtenAt = new Map<string, number>();
    const bucket: BackupBucket = {
      putNew: async (id, bytes) => {
        await runStore.putNew(id, bytes);
        writtenAt.set(id, clock);
      },
      read: runStore.read,
      list: async () => ({ objects: [...runStore.objects.keys()].sort().map((id) => ({ id, writtenAt: writtenAt.get(id)!, bytes: runStore.objects.get(id)!.byteLength })), next: null }),
      delete: async (id) => {
        runStore.objects.delete(id);
        writtenAt.delete(id);
      },
    };
    const maxParts = 20;
    const maxRunBytes = 64 * 1024 * 1024;
    const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxParts, maxRunBytes, maxStoredBytes: backupPeakSets(30) * parts.runStoredBound({ maxParts, maxRunBytes }), reviewedAt: "2026-11-09", source: "synthetic test review, not a real one" };
    const first = await runBackup({ now: clock, review, store: bucket, key, previousKeys: [] });
    // 23: the 21 keys and the run's own lock and day count (nl:backup:*), which are keys of ours too.
    is("day one: the 8 MB book copied, the copy verified", [first.ok, first.ok && first.keys], [true, 23]);
    const goodObjects = [...runStore.objects.keys()];
    const mark = redis.run(["GET", "nl:backup:last-ok"]);
    clock = T0 + DAY;
    redis.run(["SET", "nl:synthetic:huge", "h".repeat(ceiling + 1)]);
    const second = (await runBackup({ now: clock, review, store: bucket, key, previousKeys: [] })) as unknown as { ok: boolean; reason?: string; missing?: number };
    is("day two, a key over the ceiling: export_key_over_ceiling, one missing", [second.ok, second.reason, second.missing], [false, "export_key_over_ceiling", 1]);
    is("the last good copy's mark is unmoved", redis.run(["GET", "nl:backup:last-ok"]), mark);
    is("the previous good set is whole", goodObjects.every((id) => runStore.objects.has(id)), true);
    const fail = JSON.parse(String(redis.run(["GET", "nl:backup:last-fail"]) ?? "{}")) as { reason?: string; missing?: number };
    is("the owner's report: the state and how many keys", [fail.reason, fail.missing], ["export_key_over_ceiling", 1]);
    is("the alarm: a failure with that state, never a sign of life", backupAlarmSignal(second as never), { kind: "fail", reason: "export_key_over_ceiling" });

    // A month's copy (lib/backup-run.ts) with a key over the ceiling: its set is in the month's folder, and the month
    // is never marked verified, so the next run writes the month's copy again.
    const marks = () => [...runStore.objects.keys()].filter((id) => BACKUP_MONTH_MARK.test(id)).length;
    const before = marks();
    clock = Date.parse("2026-12-01T03:00:00Z");
    const month = (await runBackup({ now: clock, review, store: bucket, key, previousKeys: [] })) as unknown as { ok: boolean; reason?: string; id?: string };
    is("a month's copy with a key over the ceiling: the state, its set in the month's folder, no month mark", [month.reason, month.id?.startsWith("monthly/2026-12/"), marks()], ["export_key_over_ceiling", true, before]);
    is("the last good copy's mark is still unmoved", redis.run(["GET", "nl:backup:last-ok"]), mark);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
