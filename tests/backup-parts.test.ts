/**
 * 273 [BK1], inbox C4-30: the backup in parts (lib/backup-parts.ts). Against
 * the in-memory database and a stand-in store; nothing real.
 *
 * What fails here:
 *   - a set read back that does not hold every key, as it was, across its parts;
 *   - a part larger than its bound, or more parts or bytes than the run's caps
 *     written as if whole;
 *   - a part changed or missing after the copy read back as good;
 *   - a manifest that opens with another key, or a part whose sum is not the
 *     one its manifest names;
 *   - a row measured short (non-ASCII or quoted keys and values) so a part
 *     passes its bound, or a key the format cannot keep found out only by a
 *     failed seal;
 *   - a set read whole into memory, or past the bytes a restore may read;
 *   - the database failing while it is read said as anything but "error"; a
 *     failed write said as anything but "verify", or an earlier part deleted;
 *   - anything thrown instead of a result.
 */
import { BACKUP_SCAN_PAGES, copyInParts, manifestBound, openManifest, readBackupSet, runStoredBound, sealManifest, MAX_PARTS, PART_MAX_BYTES, PART_SEAL_ROOM } from "@/lib/backup-parts";
import type { BackupObjectStore } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-04T03:00:00Z");
const key = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 8);
const objects = new Map<string, Uint8Array>();
let failPut = -1;
let puts = 0;
const store: BackupObjectStore = {
  putNew: async (id, bytes) => {
    puts += 1;
    if (puts === failPut) throw new Error("write refused");
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
};
const limits = { maxRows: 100, maxCommands: 1_000, maxParts: 10, maxRunBytes: 1_000_000, batch: 7, now: T0, partBytes: 4_096 };

/** Twenty keys of ours of about 600 bytes each (several parts of at most 4 KB), one that ends, one not ours. */
function seed(): void {
  for (let i = 0; i < 20; i += 1) redis.run(["SET", `nl:bk:test:${String(i).padStart(2, "0")}`, `v${i}-`.padEnd(600, String.fromCharCode(97 + (i % 26)))]);
  redis.run(["SET", "nl:bk:test:ttl", "ends"]);
  redis.run(["PEXPIRE", "nl:bk:test:ttl", 3_600_000]);
  redis.run(["SET", "other:not-ours", "x"]);
}

async function main(): Promise<void> {
  redis.clear();
  redis.now = () => T0;
  seed();

  part("A set of parts, read back whole");
  const made = await copyInParts(limits, key, store);
  is("done, in several parts, every key of ours", [made.ok, made.ok && made.keys, made.ok && made.parts > 2, made.ok && made.parts <= limits.maxParts], [true, 21, true, true]);
  if (!made.ok) throw new Error("no set");
  is("its objects: the parts and the manifest", objects.size, made.parts + 1);
  is("no part over its bound", [...objects.values()].every((bytes) => bytes.byteLength <= limits.partBytes + PART_SEAL_ROOM), true);
  const seen: number[] = [];
  const rows: { key: string; expiresAt: number | null }[] = [];
  const manifest = await readBackupSet(made.id, key, store, 10_000_000, async (snapshot, index) => {
    seen.push(index);
    rows.push(...snapshot.rows);
  });
  const back = { manifest };
  is("read one part at a time, in the manifest's order", seen, manifest.parts.map((_, i) => i));
  is("read back: every key, once, in order, with its ending", [rows.length, new Set(rows.map((r) => r.key)).size, rows.map((r) => r.key).join() === [...rows.map((r) => r.key)].sort().join(), rows.find((r) => r.key === "nl:bk:test:ttl")?.expiresAt], [21, 21, true, T0 + 3_600_000]);
  is("the manifest names every part with its sums", [back.manifest.parts.length, back.manifest.rows, back.manifest.capturedAt], [made.parts, 21, T0]);

  part("What does not match is refused");
  is("the manifest opens with its own key only", (() => { try { openManifest(objects.get(made.id)!, other); return "opened"; } catch { return "refused"; } })(), "refused");
  const firstPart = back.manifest.parts[0].id;
  const kept = objects.get(firstPart)!;
  objects.set(firstPart, new Uint8Array([...kept.slice(0, -1), kept[kept.length - 1] ^ 1]));
  const none = async () => {};
  is("a part changed after the copy: refused", await readBackupSet(made.id, key, store, 10_000_000, none).then(() => "read", () => "refused"), "refused");
  objects.delete(firstPart);
  is("a part missing: refused", await readBackupSet(made.id, key, store, 10_000_000, none).then(() => "read", () => "refused"), "refused");
  objects.set(firstPart, kept);
  const forged = sealManifest({ ...back.manifest, parts: back.manifest.parts.map((p, i) => (i === 0 ? { ...p, sha256: back.manifest.parts[1].sha256 } : p)) }, key);
  objects.set("forged", forged);
  is("a part whose sum is not the one its manifest names: refused", await readBackupSet("forged", key, store, 10_000_000, none).then(() => "read", () => "refused"), "refused");
  objects.delete("forged");
  let handed = 0;
  const small = await readBackupSet(made.id, key, store, 1_000, async () => { handed += 1; }).then(() => "read", () => "refused");
  is("a set larger than a restore may read: refused before any part is read", [small, handed], ["refused", 0]);

  part("The run's caps hold before anything is written as whole");
  const before = objects.size;
  const tooMany = await copyInParts({ ...limits, maxParts: 2 }, key, store);
  is("more parts than allowed: refused, said so", [tooMany.ok === false && tooMany.reason, tooMany.ok === false && tooMany.parts], ["too_many_parts", 2]);
  is("the parts it wrote stay, unreferenced; nothing earlier deleted", objects.size, before + 2);
  is("more bytes than the run may copy: refused before a part", (await copyInParts({ ...limits, maxRunBytes: 3_000 }, key, store)).ok === false, true);
  is("caps out of range: refused, nothing sent", [await copyInParts({ ...limits, maxParts: MAX_PARTS + 1 }, key, store), await copyInParts({ ...limits, partBytes: PART_MAX_BYTES + 1 }, key, store)], [{ ok: false, reason: "limits", commands: 0, parts: 0 }, { ok: false, reason: "limits", commands: 0, parts: 0 }]);
  redis.run(["SET", "nl:bk:test:big", "z".repeat(5_000)]);
  const big = await copyInParts(limits, key, store);
  redis.run(["DEL", "nl:bk:test:big"]);
  is("a value larger than a part: the run refused, never a set without it", [big.ok, big.ok === false && big.reason], [false, "too_big"]);
  redis.run(["SET", `nl:bk:test:${"é".repeat(600)}`, "x"]);
  const longKey = await copyInParts(limits, key, store);
  redis.run(["DEL", `nl:bk:test:${"é".repeat(600)}`]);
  is("a key longer than the format keeps (1,024 bytes, UTF-8): too_big at the walk, nothing copied", [longKey.ok === false && longKey.reason, longKey.ok === false && longKey.parts], ["too_big", 0]);

  part("Rows are measured in the bytes they add to their part's JSON");
  {
    const scratch = new Map<string, Uint8Array>();
    const plain: BackupObjectStore = { putNew: async (id, bytes) => void scratch.set(id, new Uint8Array(bytes)), read: async (id) => scratch.get(id) ?? Promise.reject(new Error("missing")) };
    redis.clear();
    redis.now = () => T0;
    // Keys of euro signs (three bytes each) and quotes (two in JSON): far more bytes than characters.
    for (let i = 0; i < 30; i += 1) redis.run(["SET", `nl:bk:${"€".repeat(200)}${'"'.repeat(100)}${String(i).padStart(2, "0")}`, "v".repeat(300)]);
    const wide = await copyInParts({ ...limits, maxRows: 100, maxParts: 40 }, key, plain);
    is("copied in parts", [wide.ok, wide.ok && wide.keys, wide.ok ? "" : wide.reason], [true, 30, ""]);
    let largest = 0;
    if (wide.ok) await readBackupSet(wide.id, key, plain, 10_000_000, async (snapshot) => { largest = Math.max(largest, Buffer.byteLength(JSON.stringify(snapshot), "utf8")); });
    // A part's rows fill at most its bound less its 1,024 bytes of room; its envelope adds under 64.
    is(`no part's JSON past what it counts (${largest} <= ${limits.partBytes - 1_024 + 64})`, largest > 0 && largest <= limits.partBytes - 1_024 + 64, true);
    // The keys of the sections below, as they were.
    redis.clear();
    redis.now = () => T0;
    seed();
  }

  part("Failures say which side");
  const real = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
    if (list.some((c) => c[0] === "DUMP")) throw new Error("Redis request failed with status 503");
    return real(list);
  }) as typeof redis.pipeline;
  const dbDown = await copyInParts(limits, key, store);
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = real;
  is("the database failing while read: error, nothing written", [dbDown.ok === false && dbDown.reason, dbDown.ok === false && dbDown.parts], ["error", 0]);
  const at = objects.size;
  puts = 0;
  failPut = 2;
  const writeDown = await copyInParts(limits, key, store);
  failPut = -1;
  is("a write refused after one part: verify, the part before it kept", [writeDown.ok === false && writeDown.reason, writeDown.ok === false && writeDown.parts, objects.size], ["verify", 1, at + 1]);

  part("The walk reads at most BACKUP_SCAN_PAGES pages; past them the copy is refused, never partial (inbox C4-46)");
  {
    is("200 pages, enough for the design's 10,000 keys at 500 a page with room", BACKUP_SCAN_PAGES, 200);
    const pages = (fake: number) => {
      let page = 0;
      (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
        if (list[0]?.[0] !== "SCAN") return real(list);
        page += 1;
        // `fake` pages that each move the cursor and hold none of ours, then the real walk from its start.
        return page <= fake ? [[String(page), []]] : real([["SCAN", "0", ...list[0].slice(2)]]);
      }) as typeof redis.pipeline;
      return () => page;
    };
    const kept = objects.size;
    let read = pages(BACKUP_SCAN_PAGES);
    const over = await copyInParts({ ...limits, maxCommands: 10_000 }, key, store);
    is("201 pages: refused as scan_pages after 200 SCANs, nothing written", [over, read(), objects.size - kept], [{ ok: false, reason: "scan_pages", commands: BACKUP_SCAN_PAGES, parts: 0 }, BACKUP_SCAN_PAGES, 0]);
    read = pages(BACKUP_SCAN_PAGES - 1);
    const fits = await copyInParts({ ...limits, maxCommands: 10_000 }, key, store);
    is("exactly 200 pages: the whole set", [fits.ok, fits.ok && fits.keys, read()], [true, 21, BACKUP_SCAN_PAGES]);
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = real;
  }

  part("Bounds");
  is("a manifest of the most parts stays a small object", manifestBound(MAX_PARTS) < 2_000_000, true);
  is("what a run may store: its bytes, each part's seal and its manifest", runStoredBound({ maxParts: 3, maxRunBytes: 1_000 }), 1_000 + 3 * PART_SEAL_ROOM + manifestBound(3));
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
