/**
 * 273 [BK1] (C1-20261109-1525-C4-68 items 2, 3 and 5): the database copy read one key at a time (BACKUP_DUMP_BATCH 1,
 * so no batch of oversized keys is read past the byte cap), stopped cleanly at a deadline derived below the run's
 * 700 s cutoff and resumed by the next run of the same UTC day. A copy is complete only when every key was copied in
 * its set window: the UTC day its first run started. Until it closes it is incomplete: never the last good copy,
 * never verified, never a month's copy, never a reason to prune.
 *
 * Synthetic only: the in-memory database and a stand-in bucket. Time is virtual where a test says so: each database
 * request and each bucket request adds a stated latency to Date.now(), the clock the run's cutoff and deadline read;
 * the CPU between requests is real. The backup stays off: BACKUP_COST_REVIEW is null.
 *
 * What fails here:
 *   - a batch above one key;
 *   - no deadline, or one at or past the 700 s cutoff, or not derived from the requests it must leave room for;
 *   - a run that reaches its deadline marked complete or verified, writing a manifest, a month's mark or the last good
 *     copy's mark, pruning, sending a sign of life, or raising the day's count past its limit;
 *   - a next run of the same day that copies again what the paused run copied, or does not close the set with every key
 *     once; a run of a later day that resumes an older day's copy; a progress whose parts are gone taken as resumable;
 *   - a stored progress that cannot be read taken as none, or a database answer of the wrong shape taken as none;
 *   - a pause with no part left for the rest of the copy.
 */
import * as backupRun from "@/lib/backup-run";
import * as backupStore from "@/lib/backup-store";
import { BACKUP_RUN_CUTOFF_MS, backupStale, runBackup, type BackupCostReview, type BackupRunResult } from "@/lib/backup-run";
import { isManifestEnvelope, openManifest, readBackupSet } from "@/lib/backup-parts";
import { backupAlarmSignal } from "@/lib/backup-alarm";
import { REDIS_TIMEOUT_MS } from "@/lib/fetch-timeout";
import type { BackupBucket } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const C = backupRun as unknown as Record<string, unknown>;
const S = backupStore as unknown as Record<string, unknown>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROGRESS = "nl:backup:progress";
// One set at 4 parts: 1,000,000 + 4 × 65,536 + 4 × 160 + 65,536 = 1,328,320; 35 sets = 46,491,200.
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, maxParts: 4, maxRunBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 46_491_200, reviewedAt: "2026-11-09", source: "synthetic test review, not a real one" };
const key = Buffer.alloc(32, 9);

/** Virtual time: what each request adds to Date.now(), and what has been added so far. */
let latency = 0;
let simulated = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + simulated;
const wait = () => {
  simulated += latency;
};

let bucketClock = 0;
const objects = new Map<string, Uint8Array>();
const writtenAt = new Map<string, number>();
const deletes: string[] = [];
const store: BackupBucket = {
  putNew: async (id, bytes) => {
    wait();
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
    writtenAt.set(id, bucketClock);
  },
  read: async (id) => {
    wait();
    return objects.get(id) ?? Promise.reject(new Error("missing"));
  },
  list: async () => {
    wait();
    return { objects: [...objects.keys()].sort().map((id) => ({ id, writtenAt: writtenAt.get(id)!, bytes: objects.get(id)!.byteLength })), next: null };
  },
  delete: async (id) => {
    wait();
    deletes.push(id);
    objects.delete(id);
    writtenAt.delete(id);
  },
};

/** Database requests: each one waits the latency; DUMPs counted; SCAN paged when a test asks; a reply replaced on demand. */
let dumps = 0;
let pageScan = 0;
let answerProgress: unknown = undefined;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
  wait();
  dumps += list.filter((c) => c[0] === "DUMP").length;
  if (answerProgress !== undefined && list.length === 1 && list[0][0] === "GET" && list[0][1] === PROGRESS) return [answerProgress];
  if (pageScan > 0 && list.length === 1 && list[0][0] === "SCAN") {
    const [, all] = (await real([["SCAN", "0", "MATCH", String(list[0][3])]]))[0] as [string, string[]];
    const sorted = [...all].sort();
    const from = Number(list[0][1]);
    const next = from + pageScan;
    return [[next < sorted.length ? String(next) : "0", sorted.slice(from, next)]];
  }
  return real(list);
}) as typeof redis.pipeline;

const names = (n: number) => Array.from({ length: n }, (_, i) => `nl:r:k${String(i).padStart(2, "0")}`);
function reset(at: number, keys = 30): void {
  redis.clear();
  redis.now = () => at;
  objects.clear();
  writtenAt.clear();
  deletes.length = 0;
  bucketClock = at;
  for (const name of names(keys)) redis.run(["SET", name, `value of ${name}`]);
}
const at = (ms: number) => {
  redis.now = () => ms;
  bucketClock = ms;
};
/** The rows of a verified set, key → dump, read back as a restore would. */
async function rowsOf(id: string): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  await readBackupSet(id, key, store, 1e9, async (snapshot) => {
    for (const row of snapshot.rows) {
      if (rows.has(row.key)) throw new Error(`twice: ${row.key}`);
      rows.set(row.key, row.dump);
    }
  });
  return rows;
}
const dumpOf = async (name: string) => Buffer.from(String((await real([["DUMP", name]]))[0]), "utf8").toString("base64");
const ours = (r: Map<string, string>) => [...r.keys()].filter((k) => k.startsWith("nl:r:")).sort();
const reasonOf = (r: BackupRunResult) => (r.ok ? "ok" : r.reason);
const keysOf = (r: BackupRunResult) => ("keys" in r ? r.keys : -1);

async function main(): Promise<void> {
  const D = Date.parse("2026-11-03T04:23:00Z");

  part("One key a request, and a deadline below the 700 s cutoff, derived from what must still fit after it");
  is("BACKUP_DUMP_BATCH is 1 (C1-20261109-1525-C4-68 item 2)", C.BACKUP_DUMP_BATCH, 1);
  const deadline = C.BACKUP_COPY_DEADLINE_MS as number;
  const room = C.BACKUP_COPY_STOP_ROOM_MS as number;
  const storeTimeout = S.BACKUP_STORE_TIMEOUT_MS as number;
  is("the bucket's request timeout is exported as the one its requests use (20 s)", storeTimeout, 20_000);
  is("the deadline is the cutoff less the room kept after it", typeof deadline === "number" && deadline === BACKUP_RUN_CUTOFF_MS - room, true);
  is("below the 700 s cutoff", typeof deadline === "number" && deadline > 0 && deadline < 700_000, true);
  // The room: the request in flight at the deadline (one key), a part a row overflows into, the open part closed at
  // the pause (or the manifest when the copy ends), each written and read back at the bucket's timeout.
  is("the room holds one database request and three bucket writes and read-backs, with a margin", typeof room === "number" && room > REDIS_TIMEOUT_MS + 3 * 2 * storeTimeout, true);

  part("A run that reaches its deadline stops cleanly: its parts kept, a cursor saved, the copy incomplete");
  reset(D);
  // A copy of its own past the retention (40 days, past the bucket lock): a prune would take it.
  const old = "00000000-0000-4000-8000-000000000001";
  objects.set(old, new Uint8Array([1, 2, 3]));
  writtenAt.set(old, D - 40 * DAY);
  // 20 s a request: the deadline comes after about 25 of the 30 keys.
  latency = 20_000;
  dumps = 0;
  const first = await runBackup({ now: D, review, store, key });
  latency = 0;
  const firstParts = [...objects.keys()].filter((id) => id !== old);
  is("incomplete: copy_incomplete, never ok", reasonOf(first), "copy_incomplete");
  is("some keys copied, not all", keysOf(first) > 0 && keysOf(first) < 30, true);
  is("one DUMP for each key it copied", dumps, keysOf(first));
  is("its parts written and kept, none of them a manifest, no month's mark", [firstParts.length > 0, firstParts.some((id) => isManifestEnvelope(objects.get(id)!)), firstParts.some((id) => id.endsWith("/verified"))], [true, false, false]);
  is("nothing pruned: the old copy is still there, nothing deleted", [objects.has(old), deletes.length], [true, 0]);
  is("never the last good copy: no mark, and the report says no good copy", [(await real([["GET", "nl:backup:last-ok"]]))[0], await backupStale(D + HOUR)], [null, true]);
  const failNote = JSON.parse(String((await real([["GET", "nl:backup:last-fail"]]))[0] ?? "{}")) as { reason?: string };
  is("the report says incomplete", failNote.reason, "copy_incomplete");
  is("the alarm: no sign of life", backupAlarmSignal(first)?.kind !== "alive", true);
  const saved = (await real([["GET", PROGRESS]]))[0];
  const ttl = (await real([["TTL", PROGRESS]]))[0] as number;
  is("its progress is kept, with an end", [typeof saved === "string", ttl > 0 && ttl <= 2 * 86_400], [true, true]);
  is("the day's count is not raised past its limit", (await real([["GET", `nl:backup:ran:${new Date(D).toISOString().slice(0, 10)}`]]))[0], "1");

  part("The next run of the same day resumes from the cursor and closes the set with every key once");
  at(D + 6 * HOUR);
  dumps = 0;
  const second = await runBackup({ now: D + 6 * HOUR, review, store, key });
  is("complete", [second.ok, keysOf(second)], [true, 30]);
  is("only the keys after the cursor read: no key DUMPed twice", dumps, 30 - keysOf(first));
  if (second.ok) {
    const manifest = openManifest(objects.get(second.id)!, key);
    const folder = second.id.slice(0, second.id.lastIndexOf("/") + 1);
    is("the set names the paused run's parts too", firstParts.filter((id) => !id.endsWith("/verified")).every((id) => manifest.parts.some((p) => folder + p.id === id)), true);
    is("captured at the start of its window (the first run's moment)", manifest.capturedAt, D);
    is("every key once, each as the database holds it", [...(await rowsOf(second.id)).entries()].filter(([k]) => k.startsWith("nl:r:")), await Promise.all(names(30).map(async (n) => [n, await dumpOf(n)])));
    is("the month's first copy: written in the month's folder the paused run chose, then marked", [folder.startsWith("monthly/2026-11/"), objects.has(`${folder}verified`), firstParts.every((id) => id.startsWith(folder))], [true, true, true]);
    is("verified now: the last good copy names it, and the prune ran", [JSON.parse(String((await real([["GET", "nl:backup:last-ok"]]))[0])).set, second.prune, objects.has(old)], [second.id, "done", false]);
  }
  is("the progress is gone", (await real([["GET", PROGRESS]]))[0], null);
  is("a sign of life", backupAlarmSignal(second)?.kind, "alive");

  part("The set window is the UTC day of the copy's first run: a later day starts a new copy");
  reset(D + 10 * DAY);
  latency = 20_000;
  const paused = await runBackup({ now: D + 10 * DAY, review, store, key });
  latency = 0;
  const pausedParts = [...objects.keys()];
  at(D + 11 * DAY);
  dumps = 0;
  const nextDay = await runBackup({ now: D + 11 * DAY, review, store, key });
  is("the day's copy paused; the next day's run copied every key afresh", [reasonOf(paused), nextDay.ok, keysOf(nextDay), dumps], ["copy_incomplete", true, 30, 30]);
  if (nextDay.ok) {
    const manifest = openManifest(objects.get(nextDay.id)!, key);
    const folder = nextDay.id.slice(0, nextDay.id.lastIndexOf("/") + 1);
    is("none of the older day's parts in it, captured at its own start", [manifest.parts.some((p) => pausedParts.includes(folder + p.id)), manifest.capturedAt], [false, D + 11 * DAY]);
  }

  part("Keys that change between the runs: before the cursor as they were copied, after it as they are");
  reset(D + 20 * DAY);
  latency = 20_000;
  const before = await runBackup({ now: D + 20 * DAY, review, store, key });
  latency = 0;
  is("paused past k06 and before k28", [reasonOf(before), keysOf(before) > 6 && keysOf(before) < 28], ["copy_incomplete", true]);
  const k03 = await dumpOf("nl:r:k03");
  const k05 = await dumpOf("nl:r:k05");
  redis.run(["SET", "nl:r:k03", "changed after its copy"]);
  redis.run(["DEL", "nl:r:k05"]);
  redis.run(["SET", "nl:r:k03a", "new, named before the cursor"]);
  redis.run(["SET", "nl:r:k28", "changed before its copy"]);
  redis.run(["DEL", "nl:r:k29"]);
  redis.run(["SET", "nl:r:k29z", "new, named after the cursor"]);
  at(D + 20 * DAY + 6 * HOUR);
  const after = await runBackup({ now: D + 20 * DAY + 6 * HOUR, review, store, key });
  if (after.ok) {
    const rows = await rowsOf(after.id);
    is("k03 as copied, k05 still in it (deleted after its copy), k03a not (new before the cursor)", [rows.get("nl:r:k03") === k03, rows.get("nl:r:k05") === k05, rows.has("nl:r:k03a")], [true, true, false]);
    is("k28 as it is now, k29 gone, k29z in", [rows.get("nl:r:k28") === (await dumpOf("nl:r:k28")), rows.has("nl:r:k29"), rows.has("nl:r:k29z")], [true, false, true]);
    is("30 keys in all", ours(rows).length, 30);
  } else is("the resumed copy closed", reasonOf(after), "ok");

  part("A progress whose parts are gone is never resumed: the run copies afresh");
  reset(D + 30 * DAY);
  latency = 20_000;
  await runBackup({ now: D + 30 * DAY, review, store, key });
  latency = 0;
  const gone = [...objects.keys()][0];
  objects.delete(gone);
  writtenAt.delete(gone);
  at(D + 30 * DAY + 6 * HOUR);
  dumps = 0;
  const fresh = await runBackup({ now: D + 30 * DAY + 6 * HOUR, review, store, key });
  is("complete from the first key", [fresh.ok, keysOf(fresh), dumps], [true, 30, 30]);
  if (fresh.ok) is("captured at its own start", openManifest(objects.get(fresh.id)!, key).capturedAt, D + 30 * DAY + 6 * HOUR);

  part("A progress that cannot be read is never taken as none (rule 24)");
  reset(D + 40 * DAY);
  redis.run(["SET", PROGRESS, "not a progress"]);
  const unreadable = await runBackup({ now: D + 40 * DAY, review, store, key });
  is("refused as such, nothing written, the progress let go so the next run starts afresh", [reasonOf(unreadable), objects.size, (await real([["GET", PROGRESS]]))[0]], ["resume_unreadable", 0, null]);
  at(D + 40 * DAY + 6 * HOUR);
  is("the day's new try copies afresh", reasonOf(await runBackup({ now: D + 40 * DAY + 6 * HOUR, review, store, key })), "ok");
  reset(D + 50 * DAY);
  answerProgress = 1;
  const odd = await runBackup({ now: D + 50 * DAY, review, store, key });
  answerProgress = undefined;
  is("a database answer of the wrong shape: refused, nothing listed or written", [reasonOf(odd), objects.size], ["mark_error", 0]);

  part("A pause needs a part left for the rest of the copy");
  reset(D + 60 * DAY);
  latency = 20_000;
  const onePart = await runBackup({ now: D + 60 * DAY, review: { ...review, maxParts: 1, maxStoredBytes: 35 * 1_131_232 }, store, key });
  latency = 0;
  is("with one part allowed, the deadline ends the copy as too many parts, and no progress is kept", [reasonOf(onePart), (await real([["GET", PROGRESS]]))[0]], ["export_too_many_parts", null]);

  part("Measured: the full copy at the cap of 10,000 keys, 200 SCAN pages, 0.25 s a request (tests/plan-cost-registry.ts, ROUND_TRIP_SECONDS)");
  {
    // The design's caps: 10,000 keys, 4 MiB copied, its commands; 8 parts, so the copy can span as many runs as it takes.
    const big: BackupCostReview = { maxRows: 10_000, maxCommands: 20_212, maxBytes: 4_194_304, maxParts: 8, maxRunBytes: 4_194_304, retentionDays: 30, maxStoredBytes: 35 * (4_194_304 + 8 * 65_536 + 8 * 160 + 65_536), reviewedAt: "2026-11-09", source: "synthetic: the design's caps, for the timing" };
    const T = D + 70 * DAY;
    redis.clear();
    redis.now = () => T;
    objects.clear();
    writtenAt.clear();
    bucketClock = T;
    // 9,990 keys of ours and the backup's own marks: at most the 10,000 the review allows. About 410 bytes a row.
    const total = 9_990;
    for (let i = 0; i < total; i += 1) redis.run(["SET", `nl:m:${String(i).padStart(5, "0")}`, "v".repeat(240)]);
    // 50 keys of ours a SCAN page: the walk takes the 200 pages a shared database may take (BACKUP_SCAN_PAGES).
    pageScan = 50;
    latency = 250;
    const runs: { keys: number; seconds: number; cpuMs: number; reason: string }[] = [];
    let closed: BackupRunResult | null = null;
    let copied = 0;
    for (let run = 0; run < 10 && !closed; run += 1) {
      // Every run on the same day, the day's count cleared: how many runs the copy takes, whatever the day allows.
      await real([["DEL", `nl:backup:ran:${new Date(T).toISOString().slice(0, 10)}`]]);
      at(T + run * HOUR);
      const v0 = simulated;
      const c0 = performance.now();
      const result = await runBackup({ now: T + run * HOUR, review: big, store, key });
      const cpuMs = performance.now() - c0;
      const keys = keysOf(result) - copied;
      copied = keysOf(result);
      runs.push({ keys, seconds: Math.round(((simulated - v0) + cpuMs) / 100) / 10, cpuMs: Math.round(cpuMs), reason: reasonOf(result) });
      if (result.ok) closed = result;
    }
    latency = 0;
    pageScan = 0;
    for (const [i, r] of runs.entries()) console.log(`  measure: run ${i + 1}: ${r.reason}, ${r.keys} keys, ${r.seconds} s (${r.cpuMs} ms of it CPU)`);
    const cpuPerKey = runs.reduce((n, r) => n + r.cpuMs, 0) / total;
    console.log(`  measure: ${runs.length} runs for the full copy; CPU ${cpuPerKey.toFixed(3)} ms a key; ${runs.reduce((n, r) => n + r.seconds, 0).toFixed(1)} s in all`);
    is("the copy closes", closed?.ok, true);
    if (closed && closed.ok) is("every one of the 9,990 keys in it, once (rowsOf throws on a key twice)", [...(await rowsOf(closed.id)).keys()].filter((k) => k.startsWith("nl:m:")).length, total);
    is("it takes more runs than the 2 a day allows (BACKUP_RUNS_PER_DAY): it does not close inside its window at this latency", runs.length > (C.BACKUP_RUNS_PER_DAY as number), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
