/**
 * 273 [BK1] (inbox C1-20261108-1941-C4-35, C1-20261108-2017-C4-36): the daily backup run under a bucket lock, a
 * shrinking database, its Vercel route and the external dead-man alarm. Synthetic only: the in-memory database and a
 * stand-in bucket; no real bucket, key, monitor or request. The backup stays off: BACKUP_COST_REVIEW is null.
 *
 * What fails here:
 *   - step 1 (making room) or the prune asking the bucket to delete an object younger than BACKUP_BUCKET_LOCK_DAYS
 *     (plus an hour of clock room), or a run that cannot make room without one reported as anything but room_locked;
 *   - the R2 store's delete answering 409 (a locked object, C4-36 item 5) thrown as a plain failure instead of
 *     BackupObjectLockedError, or the run reading it as room_error / prune_error instead of room_locked / prune_locked;
 *   - a prune after a copy whose keys or bytes fell more than BACKUP_SHRINK_LIMIT_PERCENT below the last good set;
 *     a shrunk copy taken as the new comparison base; a database that lost the last good copy's mark (wiped) while
 *     the bucket holds other copies pruned anyway;
 *   - (review round of 9 November 2026) step 1 deleting a good pre-shrink set while the prune is held, over many days
 *     (Claude 2's HIGH 6727145967, Claude 6's MEDIUM 1 5819683734); one unknown read of the mark, or a first day's
 *     leftover object, holding every later prune for good (Claude 6's MEDIUM 2); a retention the bucket lock outlives
 *     admitted (Claude 2's MEDIUM, Claude 6's LOW 1); step 1 deleting objects before it knows room can be made
 *     (Claude 6's LOW 2); (9 November 2026, second round) a first day's transient fault (a manifest read-back, a
 *     prune listing or an outcome write that failed once) holding every later prune for good, and a wiped database
 *     never released once restored (Claude 6's N1).
 * The route, the schedule and the alarm are held by tests/bk1-backup-route.test.ts.
 */
import {
  BACKUP_BUCKET_LOCK_DAYS,
  BACKUP_MIN_RETENTION_DAYS,
  BACKUP_SHRINK_LIMIT_PERCENT,
  backupLastFailure,
  runBackup,
  validReview,
  type BackupCostReview,
} from "@/lib/backup-run";
import { randomBytes } from "node:crypto";
import { BackupObjectLockedError, type BackupBucket } from "@/lib/backup-roundtrip";
import { r2BackupStore } from "@/lib/backup-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-02T03:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SET_BOUND = 1_131_232;
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 36_199_424, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
// The shortest retention admitted: the lock's 7 days and two (review of 9 November 2026).
const short: BackupCostReview = { ...review, retentionDays: 9 };
const key = Buffer.alloc(32, 7);

let bucketClock = T0;
const objects = new Map<string, Uint8Array>();
const writtenAt = new Map<string, number>();
/** Every id the run asked the bucket to delete, whether or not it was allowed. */
const asked: string[] = [];
/** The bucket's own lock, as R2 would hold it: an object younger than this many ms is refused (409). */
let lockMs = 0;
const locked = (id: string) => lockMs > 0 && bucketClock - writtenAt.get(id)! < lockMs;
const store: BackupBucket = {
  putNew: async (id, bytes) => {
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
    writtenAt.set(id, bucketClock);
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
  list: async () => ({ objects: [...objects.keys()].sort().map((id) => ({ id, writtenAt: writtenAt.get(id)!, bytes: objects.get(id)!.byteLength })), next: null }),
  delete: async (id) => {
    asked.push(id);
    if (locked(id)) throw new BackupObjectLockedError();
    objects.delete(id);
    writtenAt.delete(id);
  },
};
const filler = (i: number, at: number, bytes = SET_BOUND) => {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;
  objects.set(id, new Uint8Array(bytes));
  writtenAt.set(id, at);
  return id;
};
const reset = () => {
  objects.clear();
  writtenAt.clear();
  asked.length = 0;
  lockMs = 0;
};

async function main(): Promise<void> {
  let clock = T0;
  const at = (ms: number) => {
    clock = ms;
    bucketClock = ms;
  };
  const wipe = () => {
    redis.clear();
    redis.now = () => clock;
  };
  wipe();
  // Values that do not compress away, so the sealed bytes follow them.
  const seed = (n: number, size = 40) => {
    for (let i = 0; i < n; i += 1) redis.run(["SET", `nl:store:s${i}`, randomBytes(size).toString("hex")]);
  };

  part("The bucket lock: no delete is ever asked for inside it (C4-35)");
  is("the lock the code respects: 7 days (proposal)", BACKUP_BUCKET_LOCK_DAYS, 7);
  {
    reset();
    wipe();
    seed(5);
    at(T0);
    const good = await runBackup({ now: clock, review, store, key });
    // Thirty-one full sets, all written in the last two days: the ceiling is reached and every candidate is locked.
    for (let i = 0; i < 31; i += 1) filler(i, clock + DAY + i);
    at(T0 + 3 * DAY);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    asked.length = 0;
    const before = objects.size;
    const full = await runBackup({ now: clock, review, store, key });
    is("a good copy first", good.ok, true);
    is("at the ceiling with every candidate inside the lock: room_locked, nothing written", [full, objects.size - before], [{ ok: false, reason: "room_locked" }, 0]);
    is("and no delete was even asked for", asked.length, 0);
    is("the owner's report says room_locked", (await backupLastFailure())?.reason, "room_locked");
  }
  {
    reset();
    wipe();
    seed(5);
    at(T0 + 40 * DAY);
    await runBackup({ now: clock, review, store, key });
    // Ten old sets (outside the lock) and twenty-one young ones (inside it): room is made from the old ones only.
    const old = Array.from({ length: 10 }, (_, i) => filler(i, clock - 20 * DAY + i));
    const young = Array.from({ length: 21 }, (_, i) => filler(100 + i, clock + HOUR + i));
    at(T0 + 41 * DAY);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    asked.length = 0;
    const room = await runBackup({ now: clock, review, store, key });
    is("room made from objects outside the lock: the copy is written", room.ok, true);
    is("only objects outside the lock were asked to go", [asked.length > 0, asked.every((id) => old.includes(id)), young.every((id) => objects.has(id))], [true, true, true]);
  }
  {
    // The bucket's clock a little ahead: an object 7 days old by the run's clock but not yet by the bucket's is left.
    reset();
    wipe();
    seed(5);
    at(T0 + 60 * DAY);
    await runBackup({ now: clock, review, store, key });
    const run = T0 + 61 * DAY;
    // Seven days and a half hour old at the run: past the lock by the run's clock, inside it if the bucket's runs late.
    const edge = filler(1, run - BACKUP_BUCKET_LOCK_DAYS * DAY - 30 * 60_000);
    for (let i = 0; i < 30; i += 1) filler(10 + i, clock + HOUR + i);
    at(run);
    asked.length = 0;
    const result = await runBackup({ now: clock, review, store, key });
    is("an object within an hour of the lock's end is still treated as locked", [result, asked.includes(edge)], [{ ok: false, reason: "room_locked" }, false]);
  }

  part("The prune never asks for a delete inside the lock");
  {
    reset();
    wipe();
    seed(5);
    at(T0 + 100 * DAY);
    // Copies 4 to 6 days old: inside the 7-day lock. Since 9 November 2026 no admitted retention is shorter than the
    // lock and two days, so they are inside the retention too; the prune's own lock check stays as a second guard.
    const inside = [filler(1, clock - 4 * DAY), filler(2, clock - 5 * DAY), filler(3, clock - 6 * DAY, 2_000)];
    const outside = filler(4, clock - 10 * DAY, 2_000);
    redis.run(["SET", "nl:backup:last-ok", JSON.stringify({ at: clock - DAY, set: "bbbbbbbb-bbbb-4bbb-8bbb-000000000000", base: { keys: 5, bytes: 1 } })]);
    asked.length = 0;
    const result = await runBackup({ now: clock, review: short, store, key });
    is("the run writes and prunes", [result.ok, result.ok && result.prune], [true, "done"]);
    is("the object past the retention and outside the lock goes", objects.has(outside), false);
    is("those inside the lock were never asked for", inside.every((id) => !asked.includes(id) && objects.has(id)), true);
  }

  part("A locked delete answers 409: thrown as BackupObjectLockedError and reported as such (C4-36 item 5)");
  {
    const env = { BACKUP_R2_ACCOUNT_ID: "a".repeat(32), BACKUP_R2_BUCKET: "mm-backup-test", BACKUP_R2_ACCESS_KEY_ID: "k".repeat(20), BACKUP_R2_SECRET_ACCESS_KEY: "s".repeat(40) };
    const config = { endpoint: `https://${env.BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, bucket: env.BACKUP_R2_BUCKET, key: { accessKeyId: env.BACKUP_R2_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_R2_SECRET_ACCESS_KEY } };
    const realFetch = globalThis.fetch;
    let status = 409;
    globalThis.fetch = (async () => new Response(status === 204 ? null : "<Error><Code>ObjectLockedByBucketPolicy</Code></Error>", { status })) as typeof fetch;
    const r2 = r2BackupStore(config);
    const id = "cccccccc-cccc-4ccc-8ccc-000000000000";
    const thrown = await r2.delete(id).then(() => null, (e: unknown) => e);
    is("409: BackupObjectLockedError", thrown instanceof BackupObjectLockedError, true);
    status = 403;
    const other = await r2.delete(id).then(() => null, (e: unknown) => e);
    is("403: a plain failure, not a lock", [other instanceof Error, other instanceof BackupObjectLockedError], [true, false]);
    status = 204;
    is("204: done", await r2.delete(id).then(() => "done", () => "failed"), "done");
    globalThis.fetch = realFetch;
  }
  {
    // The bucket's lock longer than the code thinks (the owner set more than 7 days): the bucket refuses with 409.
    reset();
    wipe();
    seed(5);
    at(T0 + 200 * DAY);
    await runBackup({ now: clock, review, store, key });
    for (let i = 0; i < 31; i += 1) filler(i, clock - 10 * DAY + i);
    at(T0 + 201 * DAY);
    lockMs = 30 * DAY;
    const full = await runBackup({ now: clock, review, store, key });
    is("step 1 refused by the bucket's lock: room_locked, nothing written", full, { ok: false, reason: "room_locked" });
    reset();
    wipe();
    seed(5);
    at(T0 + 300 * DAY);
    await runBackup({ now: clock, review: short, store, key });
    filler(1, clock - 10 * DAY, 2_000);
    at(T0 + 301 * DAY);
    lockMs = 30 * DAY;
    const pruned = await runBackup({ now: clock, review: short, store, key });
    is("the prune refused by the bucket's lock: the copy stands, prune_locked", [pruned.ok, pruned.ok && pruned.prune], [true, "prune_locked"]);
    is("and the report says prune_locked", (await backupLastFailure())?.reason, "prune_locked");
  }

  part("A database emptied or corrupted: no prune when keys or bytes fall more than 20% (C4-36 item 1)");
  is("the limit: 20%", BACKUP_SHRINK_LIMIT_PERCENT, 20);
  {
    reset();
    wipe();
    // Forty keys of ours: the copy also holds the backup's own few marks, so the fall is measured on enough keys.
    seed(40);
    at(T0 + 400 * DAY);
    const first = await runBackup({ now: clock, review: short, store, key });
    const stale = filler(1, clock - 10 * DAY, 2_000);
    at(T0 + 401 * DAY);
    for (let i = 0; i < 14; i += 1) redis.run(["DEL", `nl:store:s${i}`]);
    const shrunk = await runBackup({ now: clock, review: short, store, key });
    is("a first good copy", first.ok, true);
    is("35% of the keys gone: the copy is kept, the prune held (prune_shrunk)", [shrunk.ok, shrunk.ok && shrunk.prune, shrunk.ok && shrunk.pruned], [true, "prune_shrunk", 0]);
    is("the old copy is still there", objects.has(stale), true);
    is("the report says prune_shrunk", (await backupLastFailure())?.reason, "prune_shrunk");
    at(T0 + 402 * DAY);
    const again = await runBackup({ now: clock, review: short, store, key });
    is("the shrunk copy is never the new base: the next day still holds the prune", [again.ok && again.prune, objects.has(stale)], ["prune_shrunk", true]);
  }
  {
    reset();
    wipe();
    seed(40);
    at(T0 + 500 * DAY);
    await runBackup({ now: clock, review: short, store, key });
    const stale = filler(1, clock - 10 * DAY, 2_000);
    at(T0 + 501 * DAY);
    redis.run(["DEL", "nl:store:s0"]);
    const fine = await runBackup({ now: clock, review: short, store, key });
    is("control: one key in forty gone, the prune runs", [fine.ok && fine.prune, objects.has(stale)], ["done", false]);
  }
  {
    reset();
    wipe();
    seed(10, 2_000);
    at(T0 + 600 * DAY);
    await runBackup({ now: clock, review: short, store, key });
    const stale = filler(1, clock - 10 * DAY, 2_000);
    at(T0 + 601 * DAY);
    for (let i = 0; i < 10; i += 1) redis.run(["SET", `nl:store:s${i}`, "short"]);
    const thin = await runBackup({ now: clock, review: short, store, key });
    is("same keys, bytes fallen more than 20%: prune held", [thin.ok && thin.prune, objects.has(stale)], ["prune_shrunk", true]);
  }
  {
    // The database wiped whole, the backup's own marks with it, while the bucket still holds copies.
    reset();
    wipe();
    seed(10);
    at(T0 + 700 * DAY);
    await runBackup({ now: clock, review: short, store, key });
    const stale = filler(1, clock - 10 * DAY, 2_000);
    at(T0 + 701 * DAY);
    wipe();
    seed(1);
    const blind = await runBackup({ now: clock, review: short, store, key });
    // No mark: the copy is compared with the largest verified set the bucket holds (Claude 6's N1, 9 November 2026),
    // whose manifest carries its rows and part sizes; a wiped database fell far below it, so the prune is held with
    // that set as the base.
    is("no mark of the last good copy, the copy far below the bucket's verified set: prune held (prune_shrunk)", [blind.ok && blind.prune, objects.has(stale)], ["prune_shrunk", true]);
    at(T0 + 702 * DAY);
    const next = await runBackup({ now: clock, review: short, store, key });
    is("and still held the day after: the blind copy is not a base", [next.ok && next.prune, objects.has(stale)], ["prune_shrunk", true]);
    // The database restored to its size (ten keys again): the hold ends, never kept for good.
    wipe();
    seed(10);
    at(T0 + 703 * DAY);
    const back = await runBackup({ now: clock, review: short, store, key });
    is("the database restored: the hold ends and the prune runs (never held for good)", [back.ok && back.prune, objects.has(stale)], ["done", false]);
  }
  {
    reset();
    wipe();
    seed(3);
    at(T0 + 800 * DAY);
    const firstEver = await runBackup({ now: clock, review: short, store, key });
    is("control: the very first copy, an empty bucket, no mark: prune done", firstEver.ok && firstEver.prune, "done");
  }

  // Review round of 9 November 2026. A retention of 9 days (the shortest past the 7-day lock and its day of runs):
  // the ceiling holds 11 sets, so the bucket fills within days and step 1 has to make room.
  const nine: BackupCostReview = { ...review, retentionDays: 9 };
  const ran = (r: Awaited<ReturnType<typeof runBackup>>) => (r.ok ? r.prune : r.reason);
  /** Twelve good days, then `change` on day 12 and `days` more days; what the bucket and the results were. */
  const holdProbe = async (change: () => void, days: number) => {
    reset();
    wipe();
    seed(40);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    const start = T0 + 1_000 * DAY;
    for (let d = 0; d < 12; d += 1) {
      at(start + d * DAY);
      await runBackup({ now: clock, review: nine, store, key });
    }
    const good = [...objects.keys()];
    at(start + 12 * DAY);
    change();
    asked.length = 0;
    const states: string[] = [];
    for (let d = 12; d < 12 + days; d += 1) {
      at(start + d * DAY);
      states.push(ran(await runBackup({ now: clock, review: nine, store, key })));
    }
    return { good, states, start };
  };

  part("A shrunk database: step 1 never deletes a good set while the prune is held (Claude 2 HIGH, Claude 6 MEDIUM 1)");
  {
    const { good, states, start } = await holdProbe(() => {
      for (let i = 0; i < 30; i += 1) redis.run(["DEL", `nl:store:s${i}`]);
    }, 30);
    is("twelve good days leave a full retention of good sets", good.length >= 20, true);
    // The bucket is at its ceiling with the good sets, so a held copy can make room for the next only once the lock lets
    // it go: the days between write nothing (room_shrunk), and the alarm fails every day.
    is("thirty shrunk days: each a held copy or no room without a good set, never anything else", [states.length, states.every((s) => s === "prune_shrunk" || s === "room_shrunk")], [30, true]);
    is("held copies keep being made once the lock lets the older ones go", states.filter((s) => s === "prune_shrunk").length >= 4, true);
    is("no good pre-shrink object was even asked to go", good.filter((id) => asked.includes(id)), []);
    is("every good pre-shrink object is still in the bucket", good.filter((id) => !objects.has(id)), []);
    is("the bucket stays inside its ceiling while it holds them", [...objects.values()].reduce((n, o) => n + o.byteLength, 0) <= nine.maxStoredBytes, true);
    for (let i = 0; i < 30; i += 1) redis.run(["SET", `nl:store:s${i}`, randomBytes(40).toString("hex")]);
    const back: string[] = [];
    for (let d = 42; d < 52; d += 1) {
      at(start + d * DAY);
      back.push(ran(await runBackup({ now: clock, review: nine, store, key })));
    }
    is("the database back to its size: within the lock's days a copy is made, and it prunes again", [back.includes("done"), back.at(-1)], [true, "done"]);
  }

  part("A wiped database (its marks gone): step 1 never deletes a good set while the prune is held (Claude 6 MEDIUM 1)");
  {
    const { good, states } = await holdProbe(() => {
      wipe();
      seed(1);
    }, 20);
    is("every blind run holds the prune, or writes nothing when only good sets could make room", [states[0], states.every((s) => s === "prune_shrunk" || s === "room_shrunk")], ["prune_shrunk", true]);
    is("every good pre-wipe object is still in the bucket, none asked for", [good.filter((id) => !objects.has(id)), good.filter((id) => asked.includes(id))], [[], []]);
  }

  part("One unknown read of the mark never holds the prune for good (Claude 6 MEDIUM 2, case a)");
  {
    reset();
    wipe();
    seed(40);
    const start = T0 + 1_100 * DAY;
    at(start);
    await runBackup({ now: clock, review: nine, store, key });
    const was = redis.run(["GET", "nl:backup:last-ok"]);
    const plain = redis.pipeline.bind(redis);
    let fail = 1;
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (commands: (string | number)[][]) => {
      if (fail > 0 && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === "nl:backup:last-ok") {
        fail -= 1;
        throw new Error("a transient database error");
      }
      return plain(commands);
    }) as typeof redis.pipeline;
    at(start + DAY);
    const blind = ran(await runBackup({ now: clock, review: nine, store, key }));
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = plain;
    is("the day the mark could not be read: the copy kept, the prune held", blind, "prune_unverified");
    is("and the mark that could not be read is left as it was, its base with it", redis.run(["GET", "nl:backup:last-ok"]), was);
    const after: string[] = [];
    for (let d = 2; d < 8; d += 1) {
      at(start + d * DAY);
      after.push(ran(await runBackup({ now: clock, review: nine, store, key })));
    }
    is("every day after it prunes again", after, ["done", "done", "done", "done", "done", "done"]);
  }

  part("A first day's leftover object (a failed try's part) never holds the prune for good (Claude 6 MEDIUM 2, case b)");
  {
    reset();
    wipe();
    seed(10);
    const start = T0 + 1_200 * DAY;
    at(start);
    filler(77, clock - HOUR, 2_000);
    const first: string[] = [];
    for (let d = 0; d < 4; d += 1) {
      at(start + d * DAY);
      first.push(ran(await runBackup({ now: clock, review: nine, store, key })));
    }
    is("no other verified set in the bucket: the first copy is the base, and every day prunes", first, ["done", "done", "done", "done"]);
  }

  part("A first day's transient fault never holds the prune for good (Claude 6 N1, 9 November 2026)");
  {
    // P2c: try 1 writes its manifest and its read-back fails, so a valid manifest is left in the bucket; try 2 six
    // hours later finds it with no mark.
    reset();
    wipe();
    seed(10);
    const start = T0 + 1_250 * DAY;
    let puts = 0;
    let failRead: string | null = null;
    const flaky: BackupBucket = {
      ...store,
      putNew: async (id, bytes) => {
        await store.putNew(id, bytes);
        puts += 1;
        // The second object of the first try is its manifest (one part, then the manifest).
        if (puts === 2) failRead = id;
      },
      read: async (id, cap) => {
        if (id === failRead) {
          failRead = null;
          throw new Error("a transient read-back failure");
        }
        return store.read(id, cap);
      },
    };
    at(start);
    const tryOne = ran(await runBackup({ now: clock, review: nine, store: flaky, key }));
    at(start + 6 * HOUR);
    const tryTwo = ran(await runBackup({ now: clock, review: nine, store: flaky, key }));
    const later: string[] = [];
    for (let d = 1; d <= 25; d += 1) {
      at(start + d * DAY);
      later.push(ran(await runBackup({ now: clock, review: nine, store: flaky, key })));
    }
    is("P2c: try 1's manifest read-back fails (verify), try 2 finds it with no mark and prunes", [tryOne, tryTwo], ["verify", "done"]);
    is("P2c: and every one of the next 25 days prunes", later.filter((s) => s !== "done"), []);
  }
  {
    // P2d: on day 0 the prune's listing fails once, so no mark is written; day 1 finds day 0's set with no mark.
    reset();
    wipe();
    seed(10);
    const start = T0 + 1_260 * DAY;
    let lists = 0;
    const flaky: BackupBucket = {
      ...store,
      list: async (next) => {
        lists += 1;
        // Step 1's listing is the first of the run; the prune's is the second.
        if (lists === 2) throw new Error("a transient listing failure");
        return store.list(next);
      },
    };
    at(start);
    const dayZero = ran(await runBackup({ now: clock, review: nine, store: flaky, key }));
    const later: string[] = [];
    for (let d = 1; d <= 20; d += 1) {
      at(start + d * DAY);
      later.push(ran(await runBackup({ now: clock, review: nine, store: flaky, key })));
    }
    is("P2d: day 0's prune listing fails once (prune_error)", dayZero, "prune_error");
    is("P2d: every one of the next 20 days prunes", later.filter((s) => s !== "done"), []);
  }
  {
    // Day 0's outcome write fails (mark_error's path: the mark never written), with no new try that day.
    reset();
    wipe();
    seed(10);
    const start = T0 + 1_270 * DAY;
    const plain = redis.pipeline.bind(redis);
    let fail = 1;
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (commands: (string | number)[][]) => {
      if (fail > 0 && commands.some((c) => c[0] === "SET" && c[1] === "nl:backup:last-ok")) {
        fail -= 1;
        throw new Error("a transient database error");
      }
      return plain(commands);
    }) as typeof redis.pipeline;
    at(start);
    const dayZero = ran(await runBackup({ now: clock, review: nine, store, key }));
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = plain;
    is("day 0: the copy verified, its mark not written", [dayZero, redis.run(["GET", "nl:backup:last-ok"])], ["done", null]);
    const later: string[] = [];
    for (let d = 1; d <= 20; d += 1) {
      at(start + d * DAY);
      later.push(ran(await runBackup({ now: clock, review: nine, store, key })));
    }
    is("every one of the next 20 days prunes", later.filter((s) => s !== "done"), []);
  }
  {
    // Healthy control: a bucket read that fails while the run looks for a base with no mark deletes nothing and
    // writes no mark, so the next run decides again (rule 24: unknown is never "no other set").
    reset();
    wipe();
    seed(10);
    const start = T0 + 1_280 * DAY;
    at(start);
    await runBackup({ now: clock, review: nine, store, key });
    redis.run(["DEL", "nl:backup:last-ok"]);
    const before = new Set(objects.keys());
    let failNext = true;
    const flaky: BackupBucket = {
      ...store,
      read: async (id, cap) => {
        if (failNext && before.has(id)) {
          failNext = false;
          throw new Error("a transient read failure");
        }
        return store.read(id, cap);
      },
    };
    at(start + DAY);
    const unread = ran(await runBackup({ now: clock, review: nine, store: flaky, key }));
    is("no mark and a bucket read that fails: prune_unverified, nothing deleted, no mark written", [unread, [...before].every((id) => objects.has(id)), redis.run(["GET", "nl:backup:last-ok"])], ["prune_unverified", true, null]);
    at(start + 2 * DAY);
    is("the next day decides again and prunes", ran(await runBackup({ now: clock, review: nine, store, key })), "done");
  }

  part("A retention the bucket lock outlives is refused (Claude 2 MEDIUM, Claude 6 LOW 1)");
  is("the shortest retention: the lock's 7 days and two", BACKUP_MIN_RETENTION_DAYS, BACKUP_BUCKET_LOCK_DAYS + 2);
  is("8 days: refused", validReview({ ...review, retentionDays: 8 }), false);
  is("9 days: admitted", validReview(nine), true);
  {
    reset();
    wipe();
    seed(5);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    const start = T0 + 1_300 * DAY;
    const states: string[] = [];
    for (let d = 0; d < 40; d += 1) {
      at(start + d * DAY);
      states.push(ran(await runBackup({ now: clock, review: nine, store, key })));
    }
    is("9 days under the 7-day lock: forty days, every one done", states.filter((s) => s !== "done"), []);
  }

  part("Step 1 deletes nothing when the objects it may delete cannot make room (Claude 6 LOW 2)");
  {
    reset();
    wipe();
    seed(5);
    const start = T0 + 1_400 * DAY;
    at(start);
    await runBackup({ now: clock, review, store, key });
    const old = [filler(1, clock - 20 * DAY, 2_000), filler(2, clock - 19 * DAY, 2_000)];
    for (let i = 0; i < 62; i += 1) filler(100 + i, clock + HOUR + i, 2_000);
    at(start + DAY);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    asked.length = 0;
    const full = await runBackup({ now: clock, review, store, key });
    is("two old objects free, the rest inside the lock: room_locked, and neither old one asked to go", [full, asked.length, old.every((id) => objects.has(id))], [{ ok: false, reason: "room_locked" }, 0, true]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
