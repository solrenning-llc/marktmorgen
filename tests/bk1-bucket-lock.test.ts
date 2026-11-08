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
 * The route, the schedule and the alarm are held by tests/bk1-backup-route.test.ts.
 */
import {
  BACKUP_BUCKET_LOCK_DAYS,
  BACKUP_SHRINK_LIMIT_PERCENT,
  backupLastFailure,
  runBackup,
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
// The review's ceiling: retention + 2 + the 3 months' copies (inbox C1-20261108-2021-C4-37) = 35 sets of SET_BOUND.
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 39_593_120, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
const short: BackupCostReview = { ...review, retentionDays: 3 };
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
    // Thirty-four full sets, all written in the last two days: the ceiling is reached and every candidate is locked.
    for (let i = 0; i < 34; i += 1) filler(i, clock + DAY + i);
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
    // Ten old sets (outside the lock) and twenty-four young ones (inside it): room is made from the old ones only.
    const old = Array.from({ length: 10 }, (_, i) => filler(i, clock - 20 * DAY + i));
    const young = Array.from({ length: 24 }, (_, i) => filler(100 + i, clock + HOUR + i));
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
    for (let i = 0; i < 33; i += 1) filler(10 + i, clock + HOUR + i);
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
    // Copies 4 to 6 days old: past a 3-day retention but inside the 7-day lock.
    const inside = [filler(1, clock - 4 * DAY), filler(2, clock - 5 * DAY), filler(3, clock - 6 * DAY, 2_000)];
    const outside = filler(4, clock - 9 * DAY, 2_000);
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
    for (let i = 0; i < 34; i += 1) filler(i, clock - 10 * DAY + i);
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
    is("no mark of the last good copy while the bucket holds others: prune held (prune_unverified)", [blind.ok && blind.prune, objects.has(stale)], ["prune_unverified", true]);
    at(T0 + 702 * DAY);
    const next = await runBackup({ now: clock, review: short, store, key });
    is("and still held the day after: the blind copy is not a base", [next.ok && next.prune, objects.has(stale)], ["prune_unverified", true]);
  }
  {
    reset();
    wipe();
    seed(3);
    at(T0 + 800 * DAY);
    const firstEver = await runBackup({ now: clock, review: short, store, key });
    is("control: the very first copy, an empty bucket, no mark: prune done", firstEver.ok && firstEver.prune, "done");
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
