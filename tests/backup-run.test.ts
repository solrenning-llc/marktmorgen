/**
 * 273 [BK1]: the daily backup run (lib/backup-run.ts): export → seal → write
 * to the backup's own bucket → read back, the outcome kept for the report.
 * Against the in-memory database and a stand-in store; nothing real. Off three
 * ways today, each checked: no reviewed cost ceiling (BACKUP_COST_REVIEW is
 * null), no backup bucket settings, no encryption key. Its route (app/api/cron/backup) is scheduled and refuses while the review is null.
 *
 * What fails here:
 *   - a run that sends a single command while any of the three is missing, or
 *     with a review that lacks its date, source, retention or storage ceiling,
 *     or whose ceiling the kept copies could pass;
 *   - a review read through a getter, inherited, or that throws when read;
 *   - more than a run and one new try after a failure in a day, or a call past
 *     them that sends more than the day's count;
 *   - a walk past its 200 SCAN pages taken as anything but its own failure;
 *   - a copy of its own older than the retention left after a run whose
 *     deletion finished; a failed deletion under the ceiling that costs the
 *     day's copy; a write that could take the bucket past the review's ceiling
 *     (retention + 2 sets), or one after a deletion at the ceiling that failed;
 *     the last verified copy deleted to make room; two runs at once;
 *   - a copy that does not read back the same counted as done;
 *   - a good copy's time lost to a later failure, a failure's reason not kept
 *     or kept without expiry, the last good copy's mark let expire, or a failed write of the outcome turned
 *     into an exception after a good copy;
 *   - a step that throws, instead of a result that says which;
 *   - the report saying no good copy while one is under 48 hours old, or
 *     silent when there is none.
 */
import { readFileSync } from "node:fs";
import { REDIS_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { BACKUP_COST_REVIEW, BACKUP_LOCK_MS, backupLifecycleDays, BACKUP_RUN_CUTOFF_MS, backupKeptObjects, backupKey, backupLastFailure, backupListPages, backupPeakSets, backupStale, runBackup, validReview, type BackupCostReview } from "@/lib/backup-run";
import { openManifest } from "@/lib/backup-parts";
import { BACKUP_SCAN_PAGES } from "@/lib/backup-parts";
import type { BackupBucket } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-02T03:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// One set's stored bound: 1,000,000 + 65,536 + 160 + 65,536 = 1,131,232 bytes; 30 + 2 = 32 sets = 36,199,424.
const SET_BOUND = 1_131_232;
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 36_199_424, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
/** The stand-in bucket: each object with the moment it was written, listed in pages of LIST_PAGE, deleted on request. */
let bucketClock = T0;
let LIST_PAGE = 1_000;
let failDelete = false;
const objects = new Map<string, Uint8Array>();
const writtenAt = new Map<string, number>();
const deletes: string[] = [];
/** What each object the run deleted held, to tell a verified manifest from anything else. */
const deletedBytes = new Map<string, Uint8Array>();
let lists = 0;
/** The most the bucket held, in bytes and in objects, right after any write. */
let peakBytes = 0;
let peakObjects = 0;
/** What the bucket says an object weighs: its bytes, unless a test makes the listing say more. */
let weigh = (id: string) => objects.get(id)!.byteLength;
const held = () => [...objects.keys()].reduce((n, id) => n + weigh(id), 0);
const store: BackupBucket = {
  putNew: async (id, bytes) => {
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
    writtenAt.set(id, bucketClock);
    peakBytes = Math.max(peakBytes, held());
    peakObjects = Math.max(peakObjects, objects.size);
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
  list: async (next) => {
    lists += 1;
    const ids = [...objects.keys()].sort();
    const from = next === null ? 0 : Number(next);
    const page = ids.slice(from, from + LIST_PAGE);
    return { objects: page.map((id) => ({ id, writtenAt: writtenAt.get(id)!, bytes: weigh(id) })), next: from + LIST_PAGE < ids.length ? String(from + LIST_PAGE) : null };
  },
  delete: async (id) => {
    if (failDelete) throw new Error("delete refused");
    deletes.push(id);
    deletedBytes.set(id, objects.get(id)!);
    objects.delete(id);
    writtenAt.delete(id);
  },
};
const broken: BackupBucket = { ...store, read: async () => new Uint8Array([1, 2, 3]) };
const key = Buffer.alloc(32, 5);

async function main(): Promise<void> {
  redis.clear();
  let clock = T0;
  redis.now = () => clock;
  const at = (ms: number) => {
    clock = ms;
    bucketClock = ms;
  };
  // A clean database on the test's clock (MemoryRedis.clear puts its clock back on the real one).
  const wipe = () => {
    redis.clear();
    redis.now = () => clock;
  };
  redis.run(["SET", "nl:store:one", "a shop"]);
  redis.run(["HSET", "nl:stats:x", "v", "3"]);
  let sent = 0;
  let failNext: string | null = null;
  const real = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
    sent += list.length;
    if (failNext && list.some((c) => String(c[0]) === failNext)) {
      failNext = null;
      throw new Error("Redis request failed with status 503");
    }
    return real(list);
  }) as typeof redis.pipeline;

  part("Off three ways today, and nothing is sent while off");
  is("no reviewed cost ceiling exists yet", BACKUP_COST_REVIEW, null);
  const before = sent;
  is("no review: off, nothing sent", [await runBackup({ now: T0, review: null, store, key }), sent - before], [{ ok: false, reason: "off_review" }, 0]);
  is("no store: off, nothing sent", [await runBackup({ now: T0, review, store: null, key }), sent - before], [{ ok: false, reason: "off_store" }, 0]);
  is("no key: off, nothing sent", [await runBackup({ now: T0, review, store, key: null }), sent - before], [{ ok: false, reason: "off_key" }, 0]);
  delete process.env.BACKUP_ENCRYPTION_KEY;
  is("the key: none without the setting", backupKey(), null);
  process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
  is("the key: not 32 bytes, none", backupKey(), null);
  process.env.BACKUP_ENCRYPTION_KEY = key.toString("base64");
  is("the key: 32 bytes from base64", backupKey()?.length, 32);
  is("the default run, with a key but no review or bucket, is off and sends nothing", [await runBackup({ now: T0 }), sent - before], [{ ok: false, reason: "off_review" }, 0]);
  is("the default store: none without the bucket settings", (await runBackup({ now: T0, review })).ok === false && sent - before === 0, true);
  delete process.env.BACKUP_ENCRYPTION_KEY;

  part("A review counts only with its date, its source, a retention and a storage ceiling the copies cannot pass");
  is("the synthetic review is whole", validReview(review), true);
  {
    // Codex G on #2175 (inbox C4-49): a review is read once, from its own data fields; a getter is never run.
    let reads = 0;
    const getter = { ...review } as BackupCostReview;
    Object.defineProperty(getter, "maxRows", { enumerable: true, get: () => (reads++, review.maxRows) });
    const was = sent;
    is("a cap behind a getter: refused, off, nothing sent, the getter never run", [validReview(getter), await runBackup({ now: T0, review: getter, store, key }), sent - was, reads], [false, { ok: false, reason: "off_review" }, 0, 0]);
    is("a review inherited from another object: refused, nothing sent", [await runBackup({ now: T0, review: Object.create(review) as BackupCostReview, store, key }), sent - was], [{ ok: false, reason: "off_review" }, 0]);
    // The copy the run uses carries no prototype: nothing on Object.prototype can stand in for a field.
    const proto = Object.prototype as Record<string, unknown>;
    proto.maxParts = 40;
    proto.maxRunBytes = 40_000_000;
    const polluted = validReview(review);
    delete proto.maxParts;
    delete proto.maxRunBytes;
    is("a field added to Object.prototype is never read into the copy", polluted, true);
    // The shortest: the bucket lock's 7 days and two (review of 9 November 2026; tests/bk1-bucket-lock.test.ts).
    is("a retention of 9 days is admitted", validReview({ ...review, retentionDays: 9 }), true);
    const { proxy, revoke } = Proxy.revocable(review, {});
    revoke();
    is("a revoked proxy: refused as a result, never an exception", [(() => {
      try {
        return validReview(proxy);
      } catch {
        return "threw";
      }
    })(), await runBackup({ now: T0, review: proxy, store, key }).catch(() => "threw"), sent - was], [false, { ok: false, reason: "off_review" }, 0]);
  }
  for (const [name, bad] of [
    ["no date", { ...review, reviewedAt: "" }],
    ["a date that is not one", { ...review, reviewedAt: "2026-13-40" }],
    ["no source", { ...review, source: " " }],
    ["no retention", { ...review, retentionDays: 0 }],
    // Under 3 days, one or two failed days could let the last good copy go before the report (no good copy for 48
    // hours) says so.
    ["a retention of 1 day", { ...review, retentionDays: 1 }],
    ["a retention of 2 days", { ...review, retentionDays: 2 }],
    // The bucket lock outlives it: the prune could not keep it (Claude 2's MEDIUM, Claude 6's LOW 1, 9 November 2026).
    ["a retention of 8 days", { ...review, retentionDays: 8 }],
    ["a storage ceiling the kept copies could pass", { ...review, maxStoredBytes: 30 * 1_000_000 }],
    // One byte short of retention + 2 sets (inbox C4-53): no room for the day's set over a full retention and a day.
    ["a storage ceiling one byte short of retention + 2 sets", { ...review, maxStoredBytes: 32 * SET_BOUND - 1 }],
    ["no room for the run's own commands", { ...review, maxCommands: 3 }],
    ["a cap that is not a count", { ...review, maxRows: 1.5 }],
    ["more parts than a set may have", { ...review, maxParts: 10_001 }],
    ["parts whose stored weight the ceiling cannot hold", { ...review, maxParts: 40, maxRunBytes: 40_000_000 }],
  ] as [string, BackupCostReview][]) {
    const was = sent;
    is(`${name}: refused, off, nothing sent`, [validReview(bad), await runBackup({ now: T0, review: bad, store, key }), sent - was], [false, { ok: false, reason: "off_review" }, 0]);
  }

  part("With all three, a copy is made, written once and read back the same");
  const ran = await runBackup({ now: T0, review, store, key });
  // In parts (lib/backup-parts.ts): here one part and the manifest that names it.
  is("done, with the keys copied (its own day count and lock among them), one part and its manifest", [ran.ok, ran.ok && ran.keys, ran.ok && ran.parts, objects.size], [true, 4, 1, 2]);
  is("a second run the same day is refused before anything is written", [await runBackup({ now: T0 + HOUR, review, store: broken, key }), objects.size], [{ ok: false, reason: "already_ran" }, 2]);
  is("the good copy's time and its manifest are kept, and survive that refusal", [await backupStale(T0 + 2 * HOUR), JSON.parse(String(redis.run(["GET", "nl:backup:last-ok"])))], [false, { at: T0, set: ran.ok ? ran.id : "", base: { keys: ran.ok ? ran.keys : -1, bytes: ran.ok ? ran.bytes : -1 } }]);
  is("the last good copy's mark is kept for good: it names the copy never deleted to make room", Number(redis.run(["TTL", "nl:backup:last-ok"])), -1);

  part("Failures say which step, and keep the last good copy's time");
  at(T0 + DAY);
  is("a copy that does not read back the same is a failure", await runBackup({ now: clock, review, store: broken, key }), { ok: false, reason: "verify" });
  is("its reason is kept, with its time", await backupLastFailure(), { at: clock, reason: "verify" });
  is("a failure's note expires by itself", Number(redis.run(["TTL", "nl:backup:last-fail"])) > 0, true);
  is("one failed day after a good one: a good copy is still under 48 hours old", await backupStale(T0 + DAY + 20 * HOUR), false);
  at(T0 + 2 * DAY);
  is("a cap reached is a failure that says which", await runBackup({ now: clock, review: { ...review, maxRows: 1 }, store, key }), { ok: false, reason: "export_too_many" });
  is("the reason kept is the latest", (await backupLastFailure())?.reason, "export_too_many");
  is("no good copy for over 48 hours: seen", await backupStale(T0 + 2 * DAY + HOUR), true);
  at(T0 + 3 * DAY);
  failNext = "SCAN";
  is("the database failing during the export: a result, not an exception", await runBackup({ now: clock, review, store, key }), { ok: false, reason: "export_error" });
  is("and its reason is kept", (await backupLastFailure())?.reason, "export_error");
  at(T0 + 4 * DAY);
  failNext = "SET";
  const noteLost = await runBackup({ now: clock, review, store, key });
  // Three objects so far: the good set's part and manifest, and the part of the day whose read-back differed, left
  // unreferenced (no manifest names it); the refused runs wrote nothing.
  is("a refused day mark: the run stops before copying, as a result", [noteLost, objects.size], [{ ok: false, reason: "mark_error" }, 3]);
  at(T0 + 5 * DAY);
  let calls = 0;
  const realRun = redis.pipeline;
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
    if (list.some((c) => c[0] === "SET" && c[1] === "nl:backup:last-ok") && calls++ === 0) throw new Error("Redis request failed with status 503");
    return realRun(list);
  }) as typeof redis.pipeline;
  const good = await runBackup({ now: clock, review, store, key });
  is("a good copy whose outcome could not be written is still reported done", [good.ok, calls], [true, 1]);
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = realRun;
  is("with nothing ever kept, the report says there is no good copy", (redis.clear(), await backupStale(clock)), true);

  part("At most one run a day and one new try after a failure, counted before any cost (inbox C4-49)");
  wipe();
  redis.run(["SET", "nl:store:one", "a shop"]);
  at(T0 + 10 * DAY);
  is("the day's first run fails", (await runBackup({ now: clock, review, store: broken, key })).ok, false);
  at(T0 + 10 * DAY + HOUR);
  is("one new try the same day runs, and is done", (await runBackup({ now: clock, review, store, key })).ok, true);
  {
    const [was, listed, kept] = [sent, lists, objects.size];
    at(T0 + 10 * DAY + 2 * HOUR);
    // Rule 23: the lock's release is one script, never a GET and DEL after it (lib/redis-lock.ts; Codex G on #2721),
    // so the count is four, not six; what this checks, that nothing is listed or written, is unchanged.
    is("a third call that day: refused at the day's count, four commands (the lock; the count; the lock let go only if it is its own, in one script), nothing listed or written", [await runBackup({ now: clock, review, store, key }), sent - was, lists - listed, objects.size - kept], [{ ok: false, reason: "already_ran" }, 4, 0, 0]);
  }
  at(T0 + 11 * DAY);
  is("a day whose first run is done", (await runBackup({ now: clock, review, store, key })).ok, true);
  {
    const [was, kept] = [sent, objects.size];
    at(T0 + 11 * DAY + HOUR);
    is("no new try after a good run: refused, four commands, nothing written", [await runBackup({ now: clock, review, store, key }), sent - was, objects.size - kept], [{ ok: false, reason: "already_ran" }, 4, 0]);
  }
  at(T0 + 12 * DAY);
  await runBackup({ now: clock, review, store: broken, key });
  at(T0 + 12 * DAY + HOUR);
  is("two failures in a day: the second was the new try", (await runBackup({ now: clock, review, store: broken, key })).ok, false);
  at(T0 + 12 * DAY + 2 * HOUR);
  is("and nothing more that day", await runBackup({ now: clock, review, store, key }), { ok: false, reason: "already_ran" });
  is("the count of the day expires by itself", Number(redis.run(["TTL", `nl:backup:ran:${new Date(clock).toISOString().slice(0, 10)}`])) > 0, true);

  part("A walk past its pages is a failure that says so, never a partial copy (inbox C4-46)");
  {
    at(T0 + 13 * DAY);
    const kept = objects.size;
    let page = 0;
    const real = redis.pipeline;
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
      if (list[0]?.[0] === "SCAN") return [[String((page += 1)), []]];
      return real(list);
    }) as typeof redis.pipeline;
    const endless = await runBackup({ now: clock, review, store, key });
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = real;
    is("refused at the walk's page cap, nothing written", [endless, page, objects.size - kept], [{ ok: false, reason: "export_scan_pages" }, BACKUP_SCAN_PAGES, 0]);
    is("and the owner's report says so", (await backupLastFailure())?.reason, "export_scan_pages");
  }

  part("Write first, then delete past the retention; under the ceiling a failed delete never costs the day's copy (inbox C4-53)");
  {
    objects.clear();
    writtenAt.clear();
    at(T0 + 40 * DAY);
    // The database was wiped above while the bucket kept its copies, so the prune held (prune_unverified, C4-36): a
    // last good set's base of nothing lets this part test the retention alone.
    redis.run(["SET", "nl:backup:last-ok", JSON.stringify({ at: clock - DAY, set: "00000000-0000-4000-8000-000000000000", base: { keys: 0, bytes: 0 } })]);
    const line = clock - 30 * DAY;
    for (const [id, when] of [["11111111-1111-4111-8111-111111111111", line - 1], ["22222222-2222-4222-8222-222222222222", line], ["33333333-3333-4333-8333-333333333333", line + DAY]] as const) {
      objects.set(id, new Uint8Array([1]));
      writtenAt.set(id, when);
    }
    deletes.length = 0;
    const normal = await runBackup({ now: clock, review, store, key });
    is("the normal case: written, then the copy older than 30 days deleted, the one of exactly 30 days and the younger kept", [normal.ok, normal.ok && normal.pruned, deletes, objects.size], [true, 1, ["11111111-1111-4111-8111-111111111111"], 4]);
    at(T0 + 71 * DAY);
    failDelete = true;
    const kept = objects.size;
    const below = await runBackup({ now: clock, review, store, key });
    failDelete = false;
    is("a delete that fails under the ceiling: the day's copy is still written, done", [below.ok, below.ok && below.prune, objects.size - kept], [true, "prune_error", 2]);
    is("and the owner's report says the deletion failed", (await backupLastFailure())?.reason, "prune_error");
    is("the good copy's time is the new one", JSON.parse(String(redis.run(["GET", "nl:backup:last-ok"]))).at, clock);
    at(T0 + 72 * DAY);
    const next = await runBackup({ now: clock, review, store, key });
    is("the next run deletes what was left past the retention", [next.ok, next.ok && next.pruned, objects.size], [true, 4, 4]);
  }

  part("At the ceiling, the oldest go first, never the last verified copy; a failed delete there writes nothing (inbox C4-53)");
  {
    objects.clear();
    writtenAt.clear();
    wipe();
    redis.run(["SET", "nl:store:one", "a shop"]);
    at(T0 + 100 * DAY);
    const good = await runBackup({ now: clock, review, store, key });
    const goodIds = good.ok ? [good.id, ...openManifest(objects.get(good.id)!, key).parts.map((p) => p.id)] : [];
    // Thirty-one sets of full weight, younger than the retention but older than the good one would be if it had been
    // written first: here they are written just after it, so the good copy is the oldest in the bucket.
    for (let i = 0; i < 31; i += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;
      objects.set(id, new Uint8Array(SET_BOUND));
      writtenAt.set(id, clock + 1_000 + i);
    }
    // Eight days on: every set is past the bucket lock (BACKUP_BUCKET_LOCK_DAYS and its hour), so it may be deleted.
    at(T0 + 108 * DAY);
    failDelete = true;
    const kept = objects.size;
    const full = await runBackup({ now: clock, review, store, key });
    failDelete = false;
    is("at the ceiling, a delete that fails: nothing written, said so", [full, objects.size - kept, (await backupLastFailure())?.reason], [{ ok: false, reason: "room_error" }, 0, "room_error"]);
    at(T0 + 108 * DAY + HOUR);
    deletes.length = 0;
    const room = await runBackup({ now: clock, review, store, key });
    is("the day's new try makes room from the oldest, keeps the last verified copy, and writes", [room.ok, goodIds.length > 1 && goodIds.every((id) => objects.has(id)), deletes.length > 0 && deletes.every((id) => !goodIds.includes(id))], [true, true, true]);
    is("and the bucket stays within the review's ceiling", held() <= review.maxStoredBytes, true);
  }

  part("The last verified copy is known for sure before any copy is deleted to make room (Codex G on e95705e66)");
  {
    // A verified copy, then the bucket filled to the ceiling with younger sets, so the next run must make room.
    const fill = async (day: number) => {
      objects.clear();
      writtenAt.clear();
      wipe();
      redis.run(["SET", "nl:store:one", "a shop"]);
      at(T0 + day * DAY);
      const good = await runBackup({ now: clock, review, store, key });
      for (let i = 0; i < 31; i += 1) {
        const id = `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`;
        objects.set(id, new Uint8Array(SET_BOUND));
        writtenAt.set(id, clock + 1_000 + i);
      }
      at(T0 + (day + 1) * DAY);
      return good.ok ? good.id : "";
    };
    const real = redis.pipeline;
    const answerLastOk = (reply: unknown[] | null, value?: unknown) => {
      (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
        if (list.length === 1 && list[0][0] === "GET" && list[0][1] === "nl:backup:last-ok") return reply ?? [value];
        return real(list);
      }) as typeof redis.pipeline;
    };
    for (const [name, reply, value] of [
      ["an empty answer from the database", [], undefined],
      ["two answers for one command", ["x", "y"], undefined],
      ["a value that is not text", null, 7],
      ["a value that is not the kept shape", null, "{not json"],
      ["an old mark with a time and no manifest", null, String(T0)],
      ["no mark at all, with copies in the bucket", null, null],
    ] as [string, unknown[] | null, unknown][]) {
      const good = await fill(500);
      deletes.length = 0;
      answerLastOk(reply, value);
      // The day's write would fail after the room was made (the read-back differs).
      const result = await runBackup({ now: clock, review, store: broken, key });
      (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = real;
      is(`${name}: no copy deleted to make room, nothing written, said so`, [result, deletes.length, objects.has(good), (await backupLastFailure())?.reason], [{ ok: false, reason: "room_unverified" }, 0, true, "room_unverified"]);
    }
  }

  part("The bucket's rule outlives the retention, and a last good copy lost to it never stops the backup (Reviewer 1 on e81007570)");
  {
    is(`the bucket's lifecycle rule to set: ${backupLifecycleDays(review)} days, longer than the ${review.retentionDays}-day retention`, backupLifecycleDays(review) > review.retentionDays, true);
    is("30 days more than the retention", backupLifecycleDays({ ...review, retentionDays: 3 }), 33);
    // Today's rule on the bucket is 30 days: here it deletes everything older than that before each run, the last good
    // copy too, while 32 days of runs fail after writing their part.
    objects.clear();
    writtenAt.clear();
    deletedBytes.clear();
    wipe();
    redis.run(["SET", "nl:store:one", "a shop"]);
    weigh = () => Math.floor((SET_BOUND * 6) / 10);
    const lifecycle = (now: number) => {
      for (const [id, when] of [...writtenAt]) {
        if (when < now - 30 * DAY) {
          objects.delete(id);
          writtenAt.delete(id);
        }
      }
    };
    const start = T0 + 800 * DAY;
    at(start);
    const good = await runBackup({ now: clock, review, store, key });
    const goodIds = good.ok ? [good.id, ...openManifest(objects.get(good.id)!, key).parts.map((p) => p.id)] : [];
    // Every later write's read-back differs; the last good copy itself still reads back whole.
    const failing: BackupBucket = { ...store, read: async (id) => (goodIds.includes(id) ? store.read(id, 0) : new Uint8Array([1, 2, 3])) };
    let lostSeen = false;
    for (let day = 1; day <= 32; day += 1) {
      for (const hour of [0, 1]) {
        at(start + day * DAY + hour * HOUR);
        lifecycle(clock);
        await runBackup({ now: clock, review, store: failing, key });
        if ((await backupLastFailure())?.note === "last good copy lost") lostSeen = true;
      }
    }
    at(start + 33 * DAY);
    lifecycle(clock);
    const back = await runBackup({ now: clock, review, store, key });
    const failure = await backupLastFailure();
    weigh = (id: string) => objects.get(id)!.byteLength;
    is("the last good copy was taken by the bucket's rule", goodIds.length > 1 && goodIds.every((id) => !objects.has(id)), true);
    is("the first good run after it writes again", back.ok, true);
    is("and the report says the last good copy was lost", lostSeen || failure?.reason === "last_good_copy_lost", true);
    is("the run's own note: last good copy lost", failure?.reason, "last_good_copy_lost");
    const opens = (bytes: Uint8Array) => {
      try {
        openManifest(bytes, key);
        return true;
      } catch {
        return false;
      }
    };
    is("only objects with no valid manifest were deleted to make room", deletedBytes.size > 0 && [...deletedBytes.values()].every((bytes) => !opens(bytes)), true);
  }

  part("A failed day deletes nothing after it: the last good copy stays past the retention while new ones fail (Codex G on e95705e66)");
  {
    objects.clear();
    writtenAt.clear();
    wipe();
    redis.run(["SET", "nl:store:one", "a shop"]);
    const short = { ...review, retentionDays: 9 };
    at(T0 + 700 * DAY);
    const good = await runBackup({ now: clock, review: short, store, key });
    const goodIds = good.ok ? [good.id, ...openManifest(objects.get(good.id)!, key).parts.map((p) => p.id)] : [];
    at(T0 + 710 * DAY);
    const refusing: BackupBucket = { ...store, putNew: async () => { throw new Error("write refused"); } };
    deletes.length = 0;
    const failed = await runBackup({ now: clock, review: short, store: refusing, key });
    is("day 10, the first write refused: a failure, nothing deleted, the good copy of day 0 whole", [failed.ok, deletes.length, goodIds.length > 1 && goodIds.every((id) => objects.has(id))], [false, 0, true]);
    // Past the bucket lock too (BACKUP_BUCKET_LOCK_DAYS and its hour), or the old copy may not be deleted yet.
    at(T0 + 711 * DAY);
    const next = await runBackup({ now: clock, review: short, store, key });
    is("the next good copy is written, and only then is the old one, past the retention, deleted", [next.ok, goodIds.every((id) => !objects.has(id))], [true, true]);
  }

  part("When even deleting every other copy leaves no room, nothing is written");
  {
    objects.clear();
    writtenAt.clear();
    wipe();
    redis.run(["SET", "nl:store:one", "a shop"]);
    at(T0 + 110 * DAY);
    const good = await runBackup({ now: clock, review, store, key });
    // The last verified copy's part made to weigh all but a set's bound less one byte: kept, it leaves no room.
    const partId = good.ok ? openManifest(objects.get(good.id)!, key).parts[0].id : "";
    objects.set(partId, new Uint8Array(review.maxStoredBytes - SET_BOUND + 1 - objects.get(good.ok ? good.id : "")!.byteLength));
    objects.set("bbbbbbbb-bbbb-4bbb-8bbb-000000000001", new Uint8Array(10));
    // Older than the bucket lock, younger than the retention.
    writtenAt.set("bbbbbbbb-bbbb-4bbb-8bbb-000000000001", clock - 8 * DAY);
    at(T0 + 111 * DAY);
    const kept = objects.size;
    const none = await runBackup({ now: clock, review, store, key });
    // Nothing is asked to go when the others cannot make room (Claude 6's LOW 2, 9 November 2026): before, the other
    // copy was deleted first and the run still found no room.
    is("the others cannot make room with the last verified copy kept: room_error, nothing deleted, nothing written", [none, objects.has(partId), objects.has("bbbbbbbb-bbbb-4bbb-8bbb-000000000001"), objects.size, (await backupLastFailure())?.reason], [{ ok: false, reason: "room_error" }, true, true, kept, "room_error"]);
  }

  part("A listing longer than the ceiling allows: nothing written, said so");
  {
    at(T0 + 120 * DAY);
    LIST_PAGE = 1;
    const [listed, kept] = [lists, objects.size];
    const long = await runBackup({ now: clock, review, store, key });
    LIST_PAGE = 1_000;
    is(`more than its ${backupListPages(review)} page: refused as room_pages after one page, nothing written or deleted`, [long, lists - listed, objects.size - kept, (await backupLastFailure())?.reason], [{ ok: false, reason: "room_pages" }, backupListPages(review), 0, "room_pages"]);
  }

  part("Two calls at once: one runs, the other is refused before anything costly (inbox C4-53)");
  {
    objects.clear();
    writtenAt.clear();
    wipe();
    redis.run(["SET", "nl:store:one", "a shop"]);
    at(T0 + 150 * DAY);
    const slow: BackupBucket = {
      ...store,
      putNew: async (id, bytes) => {
        await new Promise((done) => setTimeout(done, 50));
        return store.putNew(id, bytes);
      },
    };
    const [first, second] = await Promise.all([runBackup({ now: clock, review, store: slow, key }), runBackup({ now: clock + 1, review, store: slow, key })]);
    is("one is done, the other refused as busy; one set written", [[first.ok, second.ok].filter(Boolean).length, [first, second].some((r) => !r.ok && r.reason === "busy"), objects.size], [1, true, 2]);
    is("the busy call left the day's new try untouched", redis.run(["GET", `nl:backup:ran:${new Date(clock).toISOString().slice(0, 10)}`]), String(1 + 2));
  }

  // 90 days of runs at awkward times: just before midnight, writing past it; first runs that fail, new tries, deletes
  // that fail now and then. The bucket's peaks are taken right after every write.
  const ninetyDays = async (from: number) => {
    objects.clear();
    writtenAt.clear();
    wipe();
    peakBytes = 0;
    peakObjects = 0;
    let seed = 7;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const start = from - (from % DAY);
    let lastGood: string[] = [];
    let lostGood = false;
    let oldest = 0;
    for (let day = 0; day < 90; day += 1) {
      const first = start + day * DAY + (rand() < 0.5 ? DAY - 1_000 : Math.floor(rand() * DAY));
      for (const [when, bad] of [[first, rand() < 0.4], [first + 1_200, rand() < 0.3]] as const) {
        at(when);
        bucketClock = when + 800_000;
        failDelete = rand() < 0.15;
        const result = await runBackup({ now: when, review, store: bad ? broken : store, key });
        failDelete = false;
        if (result.ok) lastGood = [result.id, ...openManifest(objects.get(result.id)!, key).parts.map((p) => p.id)];
        if (lastGood.some((id) => !objects.has(id))) lostGood = true;
        if (result.ok && result.prune === "done") oldest = Math.max(oldest, ...[...writtenAt.values()].map((w) => when - w));
      }
    }
    return { lostGood, oldest };
  };

  part("The lock: only its own run lets it go, it outlives the run's cutoff, and a busy call is reported");
  {
    objects.clear();
    writtenAt.clear();
    wipe();
    redis.run(["SET", "nl:store:one", "a shop"]);
    at(T0 + 160 * DAY);
    is("the lock lives longer than the cutoff and the admission's two requests, with a minute to spare", BACKUP_LOCK_MS >= BACKUP_RUN_CUTOFF_MS + 2 * REDIS_TIMEOUT_MS + 60_000, true);
    let ttl = -1;
    const watched: BackupBucket = {
      ...store,
      putNew: async (id, bytes) => {
        // Read at the first write, before the lock is taken over below.
        if (ttl === -1) ttl = Number(redis.run(["PTTL", "nl:backup:lock"]));
        // The lock ran out and another run took it, while this one was still writing.
        redis.run(["SET", "nl:backup:lock", "someone-else"]);
        return store.putNew(id, bytes);
      },
    };
    const ran = await runBackup({ now: clock, review, store: watched, key });
    is("held, while writing, for at least the cutoff", ttl >= BACKUP_RUN_CUTOFF_MS, true);
    is("a lock taken by another run since is never let go by this one", [ran.ok, redis.run(["GET", "nl:backup:lock"])], [true, "someone-else"]);
    at(T0 + 160 * DAY + HOUR);
    const busy = await runBackup({ now: clock, review, store, key });
    is("a call that finds the lock: busy, and the owner's report says so", [busy, await backupLastFailure()], [{ ok: false, reason: "busy" }, { at: clock, reason: "busy" }]);
    redis.run(["DEL", "nl:backup:lock"]);
  }

  part("What the code proves: never past the review's ceiling in objects, and the last verified copy always kept");
  {
    const seen = await ninetyDays(T0 + 200 * DAY);
    is(`never more than the review's ${review.maxStoredBytes} bytes (seen ${peakBytes})`, peakBytes > 0 && peakBytes <= review.maxStoredBytes, true);
    is(`objects are what limits here: ${backupKeptObjects(review)} reached, never passed, one listing page of ${backupListPages(review)}`, peakObjects, backupKeptObjects(review));
    is("the last verified copy is never deleted", seen.lostGood, false);
    is("after each run whose deletion finished, none of its own copies older than 30 days", seen.oldest <= 30 * DAY, true);
    is(`the ceiling in sets: retention + 2 = ${backupPeakSets(30)}`, backupPeakSets(30), 32);
  }

  part("The same 90 days with copies that weigh more than half a set each: bytes are what limits");
  {
    // Every object listed at just over half a set's bound, so a whole set (a part and its manifest) weighs a little
    // more than the bound and 31 sets would pass the ceiling of 32 × the bound: the byte ceiling binds before the count.
    weigh = () => Math.floor(SET_BOUND / 2) + 1;
    const seen = await ninetyDays(T0 + 600 * DAY);
    weigh = (id: string) => objects.get(id)!.byteLength;
    is(`never more than the review's ${review.maxStoredBytes} bytes as listed (seen ${peakBytes})`, peakBytes <= review.maxStoredBytes && peakBytes > review.maxStoredBytes - 2 * SET_BOUND, true);
    is(`and fewer objects than the ${backupKeptObjects(review)} the count allows (seen ${peakObjects})`, peakObjects < backupKeptObjects(review), true);
    is("the last verified copy is never deleted", seen.lostGood, false);
  }

  part("A run that passes its cutoff stops before its manifest (independent review of #2175)");
  {
    objects.clear();
    writtenAt.clear();
    wipe();
    redis.run(["SET", "nl:store:one", "a shop"]);
    at(T0 + 300 * DAY);
    const slow: BackupBucket = {
      ...store,
      putNew: async (id, bytes) => {
        await new Promise((done) => setTimeout(done, 300));
        return store.putNew(id, bytes);
      },
    };
    is("the run's cutoff: 700 s, under a day (the retention's proof needs it) and under the route's 800 s (inbox C4-36)", BACKUP_RUN_CUTOFF_MS, 700_000);
    const late = await runBackup({ now: clock, review, store: slow, key, cutoffMs: 200 });
    is("past the cutoff: refused as such, its part left unreferenced, no manifest written", [late, objects.size, (await backupLastFailure())?.reason], [{ ok: false, reason: "export_cutoff" }, 1, "export_cutoff"]);
  }

  part("With the shortest retention, the report says no good copy before the last one can be deleted");
  {
    objects.clear();
    writtenAt.clear();
    const short = { ...review, retentionDays: 9 };
    at(T0 + 400 * DAY);
    const good = await runBackup({ now: clock, review: short, store, key });
    const kept = [...objects.keys()];
    for (let day = 1; day <= 2; day += 1) {
      at(T0 + 400 * DAY + day * DAY);
      await runBackup({ now: clock, review: short, store: broken, key });
      at(T0 + 400 * DAY + day * DAY + HOUR);
      await runBackup({ now: clock, review: short, store: broken, key });
    }
    is("two failed days: the good copy is still there, and the report already says no good copy for 48 hours", [good.ok, kept.length, kept.every((id) => objects.has(id)), await backupStale(T0 + 402 * DAY + 2 * HOUR)], [true, 2, true, true]);
  }

  part("Scheduled, and off: the route refuses before any command while BACKUP_COST_REVIEW is null");
  is("vercel.json names only the backup's own route (tests/bk1-backup-route.test.ts holds its schedule and its refusal)", readFileSync("vercel.json", "utf8").match(/"\/api\/cron\/[a-z-]*backup[a-z-]*"/g), ['"/api/cron/backup"']);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
