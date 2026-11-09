/**
 * 273 [BK1] (inbox C1-20261108-2021-C4-37 item 4): the single retention of the database copy. Daily copies are kept
 * retentionDays (30); the first verified copy of each UTC month becomes that month's copy, written under
 * backups/monthly/<YYYY-MM>/<run>/ and marked there (an empty "verified" object) only once it is verified and passed
 * the shrink check; the 3 newest months' copies are kept past the retention; nothing lives past 120 days (the bucket's
 * lifecycle rule on backups/, the hard cap). No weekly copies (C4-37 replaced C4-36's weekly ones). Also the answer to
 * a create-only write on a locked name: 409 ObjectLockedByBucketPolicy, not 412
 * (https://developers.cloudflare.com/r2/buckets/bucket-locks/, read 8 November 2026).
 *
 * Synthetic only: the in-memory database and a stand-in bucket; no real bucket, key or request. The backup stays off:
 * BACKUP_COST_REVIEW is null.
 *
 * What fails here:
 *   - a month's first copy not written as the month's copy, or a later copy of the month written as one;
 *   - a month's copy marked when its copy shrank past BACKUP_SHRINK_LIMIT_PERCENT, when the last good set cannot be
 *     known, or the prune going on when the mark could not be written;
 *   - more or fewer than the 3 newest months' copies kept past the retention, any object older than 120 days, a
 *     delete asked inside the bucket lock or inside the retention, the bucket over the review's ceiling in bytes or
 *     in objects;
 *   - step 1 (making room) taking one of the 3 newest months' copies;
 *   - a month's copy that cannot be read back whole for a restore;
 *   - a review whose ceiling holds fewer than retention + 2 + 3 sets, or whose retention and 30 days of lifecycle
 *     pass the 120-day cap; the worst month not pricing the three monthly sets and their marks;
 *   - the R2 store taking a 409 on a create-only write as written, or saying it is anything but the bucket lock.
 */
import {
  BACKUP_BUCKET_LOCK_DAYS,
  BACKUP_LIFECYCLE_EXTRA_DAYS,
  backupKeptObjects,
  backupLastFailure,
  backupLifecycleDays,
  backupPeakSets,
  runBackup,
  validReview,
  type BackupCostReview,
} from "@/lib/backup-run";
import * as backupRun from "@/lib/backup-run";
import { randomBytes } from "node:crypto";
import { type BackupBucket } from "@/lib/backup-roundtrip";
import { readBackupSet } from "@/lib/backup-parts";
import { r2BackupStore, readListing } from "@/lib/backup-store";
import { backupWorstMonth } from "@/lib/backup-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SET_BOUND = 1_131_232;
const constants = backupRun as unknown as Record<string, unknown>;
const MONTHLY = constants.BACKUP_MONTHLY_COPIES as number | undefined;
const CAP_DAYS = constants.BACKUP_MAX_COPY_DAYS as number | undefined;
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 35 * SET_BOUND, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
const key = Buffer.alloc(32, 7);

let bucketClock = 0;
const objects = new Map<string, Uint8Array>();
const writtenAt = new Map<string, number>();
/** Every delete the run asked for, with the object's age then. */
const asked: { id: string; age: number }[] = [];
let lockMs = 0;
/** When set, a write of a month's mark fails. */
let failMark = false;
const store: BackupBucket = {
  putNew: async (id, bytes) => {
    if (objects.has(id)) throw new Error("exists");
    if (failMark && id.endsWith("/verified")) throw new Error("mark refused");
    objects.set(id, new Uint8Array(bytes));
    writtenAt.set(id, bucketClock);
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
  list: async () => ({ objects: [...objects.keys()].sort().map((id) => ({ id, writtenAt: writtenAt.get(id)!, bytes: objects.get(id)!.byteLength })), next: null }),
  delete: async (id) => {
    asked.push({ id, age: bucketClock - writtenAt.get(id)! });
    if (lockMs > 0 && bucketClock - writtenAt.get(id)! < lockMs) throw new Error("locked");
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
  failMark = false;
};
const MARK = /^monthly\/(\d{4}-\d{2})\/([0-9a-f-]{36})\/verified$/;
/** The months whose copy is marked, newest first, each with its folder. */
const marked = () =>
  [...objects.keys()]
    .map((id) => MARK.exec(id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ month: m[1], folder: `monthly/${m[1]}/${m[2]}/` }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
const inFolder = (folder: string) => [...objects.keys()].filter((id) => id.startsWith(folder));
const bytesNow = () => [...objects.values()].reduce((n, b) => n + b.byteLength, 0);

async function main(): Promise<void> {
  let clock = 0;
  const at = (ms: number) => {
    clock = ms;
    bucketClock = ms;
  };
  const wipe = () => {
    redis.clear();
    redis.now = () => clock;
  };
  const seed = (n: number, size = 40) => {
    for (let i = 0; i < n; i += 1) redis.run(["SET", `nl:store:s${i}`, randomBytes(size).toString("hex")]);
  };

  part("The single retention, as constants (C4-37 item 4)");
  is("monthly copies kept: 3", MONTHLY, 3);
  is("no copy past 120 days", CAP_DAYS, 120);
  is("the ceiling in sets: retention + 2 + the 3 monthly copies = 35 for 30 days", backupPeakSets(30), 35);
  is("objects the bucket may hold: 35 sets of a part, a manifest and a month's mark", backupKeptObjects(review), 105);
  is("the bucket's lifecycle rule on backups/: the 120-day cap, whatever the retention", [backupLifecycleDays(review), backupLifecycleDays({ retentionDays: 3 })], [120, 120]);
  is("a ceiling of retention + 2 sets only: refused", validReview({ ...review, maxStoredBytes: 32 * SET_BOUND }), false);
  is("a ceiling of retention + 5 sets: admitted", validReview(review), true);
  is(`a retention whose ${BACKUP_LIFECYCLE_EXTRA_DAYS} days of lifecycle pass the cap (91 days): refused`, validReview({ ...review, retentionDays: 91, maxStoredBytes: 96 * SET_BOUND }), false);
  is("90 days, at the cap: admitted", validReview({ ...review, retentionDays: 90, maxStoredBytes: 95 * SET_BOUND }), true);

  part("200 days of one run a day under a 7-day bucket lock: the month's copy, the 3 newest kept, nothing past 120 days");
  {
    reset();
    wipe();
    seed(5);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    const start = Date.parse("2026-11-01T03:00:00Z");
    const seen = new Set<string>();
    const monthCopy = new Map<string, string>();
    let designatedRight = true;
    let pruneDone = true;
    let underCeiling = true;
    let oldOnlyMonthly = true;
    let newestThreeWhole = true;
    let oldestAge = 0;
    let oldMonthsAtEnd: string[] = [];
    for (let d = 0; d < 200; d += 1) {
      at(start + d * DAY);
      const month = new Date(clock).toISOString().slice(0, 7);
      const first = !seen.has(month);
      seen.add(month);
      const result = await runBackup({ now: clock, review, store, key });
      if (!result.ok) {
        designatedRight = false;
        pruneDone = false;
        continue;
      }
      if (result.id.startsWith(`monthly/${month}/`) !== first) designatedRight = false;
      if (first) monthCopy.set(month, result.id);
      if (result.prune !== "done") pruneDone = false;
      if (bytesNow() > review.maxStoredBytes || objects.size > backupKeptObjects(review)) underCeiling = false;
      const newest = marked().slice(0, 3);
      const keptFolders = new Set(newest.map((m) => m.folder));
      for (const [id, when] of writtenAt) {
        const age = clock - when;
        oldestAge = Math.max(oldestAge, age);
        if (age > review.retentionDays * DAY && ![...keptFolders].some((f) => id.startsWith(f))) oldOnlyMonthly = false;
      }
      // Each kept month's copy whole: its part, its manifest and its mark.
      if (!newest.every((m) => inFolder(m.folder).length === 3)) newestThreeWhole = false;
      oldMonthsAtEnd = [...new Set([...writtenAt].filter(([, when]) => clock - when > review.retentionDays * DAY).map(([id]) => id.slice(8, 15)))].sort();
    }
    is("the first run of each UTC month wrote the month's copy, and no other run did", designatedRight, true);
    is("every prune done", pruneDone, true);
    is("never over the ceiling, in bytes or in objects", underCeiling, true);
    is("past the retention, only the 3 newest months' copies are left", oldOnlyMonthly, true);
    is("each kept month's copy whole (part, manifest, mark)", newestThreeWhole, true);
    is("at the end (19 May 2027): April's and March's copies are the ones past the retention; May's is inside it", oldMonthsAtEnd, ["2027-03", "2027-04"]);
    is("no object ever older than the 120-day cap", oldestAge <= 120 * DAY, true);
    is("every delete asked for was outside the bucket lock and past the retention", asked.length > 0 && asked.every((a) => a.age >= lockMs && a.age > review.retentionDays * DAY), true);
    is("the months marked, newest first", marked().map((m) => m.month), ["2027-05", "2027-04", "2027-03"]);
    const march = monthCopy.get("2027-03") ?? "";
    let rows = 0;
    const read = await readBackupSet(march, key, store, 10_000_000, async (snapshot) => {
      rows += snapshot.rows.length;
    }).then(() => "read", () => "refused");
    is("March's copy, 80 days old, reads back whole for a restore, its parts found in its folder", [read, rows > 0, march.startsWith("monthly/2027-03/")], ["read", true, true]);

    // Step 1 at the ceiling: the oldest objects that are no month's copy go first; the 3 months' copies stay.
    const before = marked().map((m) => [m.folder, inFolder(m.folder).length]);
    let i = 0;
    while (bytesNow() + SET_BOUND <= review.maxStoredBytes) filler(i++, clock - 40 * DAY);
    at(clock + DAY);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    const room = await runBackup({ now: clock, review, store, key });
    is("at the ceiling: room made, the copy written", room.ok, true);
    is("and the 3 months' copies untouched by step 1 or the prune", marked().map((m) => [m.folder, inFolder(m.folder).length]), before);
  }

  part("The shrink guard at a month's turn: a shrunk copy is never the month's copy, and nothing goes");
  {
    reset();
    wipe();
    seed(40);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    for (const day of ["2026-12-01", "2027-01-01", "2027-02-01"]) {
      at(Date.parse(`${day}T03:00:00Z`));
      await runBackup({ now: clock, review, store, key });
    }
    is("December, January and February marked", marked().map((m) => m.month), ["2027-02", "2027-01", "2026-12"]);
    const december = marked()[2]?.folder ?? "none";
    at(Date.parse("2027-03-01T03:00:00Z"));
    for (let k = 0; k < 14; k += 1) redis.run(["DEL", `nl:store:s${k}`]);
    const shrunk = await runBackup({ now: clock, review, store, key });
    is("35% of the keys gone on 1 March: the copy kept, the prune held", [shrunk.ok, shrunk.ok && shrunk.prune], [true, "prune_shrunk"]);
    is("written as March's copy, but never marked", [shrunk.ok && shrunk.id.startsWith("monthly/2027-03/"), marked().map((m) => m.month)], [true, ["2027-02", "2027-01", "2026-12"]]);
    is("December's copy, 90 days old, still there", inFolder(december).length, 3);
    at(Date.parse("2027-03-02T03:00:00Z"));
    const again = await runBackup({ now: clock, review, store, key });
    is("the next day, still shrunk: March's copy tried again, still not marked", [again.ok && again.id.startsWith("monthly/2027-03/"), again.ok && again.prune, marked().length], [true, "prune_shrunk", 3]);
    at(Date.parse("2027-03-03T03:00:00Z"));
    seed(40);
    const back = await runBackup({ now: clock, review, store, key });
    is("the keys back: March's copy marked, the prune done", [back.ok && back.id.startsWith("monthly/2027-03/"), back.ok && back.prune, marked().map((m) => m.month)], [true, "done", ["2027-03", "2027-02", "2027-01"]]);
    is("and December's copy, now the 4th, gone", inFolder(december).length, 0);
  }

  part("A month's mark that cannot be written: nothing pruned, said in the report, tried again the next run");
  {
    reset();
    wipe();
    seed(5);
    at(Date.parse("2026-12-01T03:00:00Z"));
    await runBackup({ now: clock, review, store, key });
    const stale = filler(1, clock - 10 * DAY, 2_000);
    at(Date.parse("2027-01-01T03:00:00Z"));
    failMark = true;
    const refused = await runBackup({ now: clock, review, store, key });
    is("the copy stands; the prune is held as prune_monthly", [refused.ok, refused.ok && refused.prune], [true, "prune_monthly"]);
    is("the report says so", (await backupLastFailure())?.reason, "prune_monthly");
    is("no January mark, and the object past the retention still there", [marked().map((m) => m.month), objects.has(stale)], [["2026-12"], true]);
    failMark = false;
    at(Date.parse("2027-01-02T03:00:00Z"));
    const next = await runBackup({ now: clock, review, store, key });
    is("the next run writes January's copy again and marks it; the prune goes on", [next.ok && next.id.startsWith("monthly/2027-01/"), next.ok && next.prune, marked().map((m) => m.month), objects.has(stale)], [true, "done", ["2027-01", "2026-12"], false]);
  }

  part("The database wiped with its marks while the bucket holds copies: no month's mark, nothing deleted");
  {
    reset();
    wipe();
    seed(10);
    at(Date.parse("2026-12-01T03:00:00Z"));
    await runBackup({ now: clock, review, store, key });
    const stale = filler(1, clock - 10 * DAY, 2_000);
    at(Date.parse("2027-01-01T03:00:00Z"));
    wipe();
    seed(1);
    const blind = await runBackup({ now: clock, review, store, key });
    // Claude 6's N1 (#3273, 9 November 2026): with no mark, the copy is compared with the largest verified set in the
    // bucket, here December's copy (the months' copies are read for it when no other set is there): fallen far below
    // it, the prune is held with that set as the base.
    is("prune_shrunk, no January mark, nothing deleted", [blind.ok && blind.prune, marked().map((m) => m.month), objects.has(stale)], ["prune_shrunk", ["2026-12"], true]);
    at(Date.parse("2027-01-02T03:00:00Z"));
    wipe();
    seed(10);
    const back = await runBackup({ now: clock, review, store, key });
    is("the database restored the next day: the hold ends, January's copy marked, the prune done", [back.ok && back.prune, marked().map((m) => m.month), objects.has(stale)], ["done", ["2027-01", "2026-12"], false]);
  }

  part("The last good copy lost, a month's copy sealed under a key the run no longer holds: kept by name, never a stop");
  {
    // After a rotation because the key leaked, the old key is removed from the deployment at once (docs/backup.md), so a
    // month's copy (up to 120 days) may be sealed under a key the run does not read with. It is kept by name, so the
    // run need not open it, and it must not stop the run.
    reset();
    wipe();
    seed(5);
    const before = Buffer.alloc(32, 9);
    at(Date.parse("2026-12-01T03:00:00Z"));
    await runBackup({ now: clock, review, store, key: before });
    const december = marked()[0]?.folder ?? "none";
    // The mark then names a copy the bucket's rule took, and the bucket fills with leftovers past the lock.
    redis.run(["SET", "nl:backup:last-ok", JSON.stringify({ at: clock, set: "dddddddd-dddd-4ddd-8ddd-000000000000", base: { keys: 0, bytes: 0 } })]);
    for (let i = 0; i < 34; i += 1) filler(i, clock + 1_000 + i);
    at(Date.parse("2026-12-20T03:00:00Z"));
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    const result = await runBackup({ now: clock, review, store, key, previousKeys: [] });
    is("room made from the leftovers, the copy written, said as last good copy lost", [result.ok, result.ok && result.note], [true, "last_good_copy_lost"]);
    is("December's copy, under the old key, whole", inFolder(december).length, 3);
  }

  part("A copy sealed under the previous key, 60 to 120 days old, still opens on the lost path (C1-20261109-0025-C4-47 item 1)");
  {
    // Claude 2's probe A on #3293 (MEDIUM, 2nd review): the bucket rule keeps any object up to 120 days, so the run must
    // read the previous key as long. Here the keyring comes from the deployment's settings, as in production.
    is("the previous key is read for the 120-day cap, the same constant", constants.BACKUP_KEY_PREVIOUS_DAYS, CAP_DAYS);
    const env = process.env as Record<string, string | undefined>;
    const saved = [env.BACKUP_ENCRYPTION_KEY, env.BACKUP_ENCRYPTION_KEY_PREVIOUS, env.BACKUP_ENCRYPTION_KEY_ROTATED_AT];
    reset();
    wipe();
    seed(5);
    const before = Buffer.alloc(32, 9);
    at(Date.parse("2026-12-01T03:00:00Z"));
    await runBackup({ now: clock, review, store, key: before });
    const december = marked()[0]?.folder ?? "none";
    at(Date.parse("2026-12-02T03:00:00Z"));
    const daily = await runBackup({ now: clock, review, store, key: before });
    const dailyId = daily.ok ? daily.id : "none";
    is("a daily copy sealed under the old key, outside the month's folder", [daily.ok, dailyId.startsWith("monthly/")], [true, false]);
    // The key is rotated the next day; the mark then names a copy the bucket's rule took, and the bucket fills.
    env.BACKUP_ENCRYPTION_KEY = key.toString("base64");
    env.BACKUP_ENCRYPTION_KEY_PREVIOUS = before.toString("base64");
    env.BACKUP_ENCRYPTION_KEY_ROTATED_AT = "2026-12-03";
    redis.run(["SET", "nl:backup:last-ok", JSON.stringify({ at: clock, set: "dddddddd-dddd-4ddd-8ddd-000000000000", base: { keys: 0, bytes: 0 } })]);
    for (let i = 0; i < 34; i += 1) filler(i, clock + 1_000 + i);
    lockMs = BACKUP_BUCKET_LOCK_DAYS * DAY;
    // 20 February 2027: 79 days after the rotation, the daily copy 80 days old, inside the 120-day bucket rule.
    at(Date.parse("2027-02-20T03:00:00Z"));
    const result = await runBackup({ now: clock, review, store, key });
    is("room made, the copy written, said as last good copy lost (not room_unverified)", [result.ok, result.ok ? result.note : !result.ok && result.reason], [true, "last_good_copy_lost"]);
    // The daily copy opened under the previous key, so step 1 kept it as a verified set; the prune then takes it, past
    // the 30-day retention, only after the new copy was verified.
    is("the prune done after the new copy; the 80-day daily copy gone past the retention", [result.ok && result.prune, objects.has(dailyId)], ["done", false]);
    is("December's copy, under the old key, whole", inFolder(december).length, 3);
    [env.BACKUP_ENCRYPTION_KEY, env.BACKUP_ENCRYPTION_KEY_PREVIOUS, env.BACKUP_ENCRYPTION_KEY_ROTATED_AT] = saved;
    for (const [name, value] of [["BACKUP_ENCRYPTION_KEY", saved[0]], ["BACKUP_ENCRYPTION_KEY_PREVIOUS", saved[1]], ["BACKUP_ENCRYPTION_KEY_ROTATED_AT", saved[2]]] as const) if (value === undefined) delete env[name];
  }

  part("The R2 store: monthly names, and a create-only write on a locked name (409)");
  {
    const run = "dddddddd-dddd-4ddd-8ddd-000000000001";
    const part1 = "eeeeeeee-eeee-4eee-8eee-000000000002";
    const daily = "ffffffff-ffff-4fff-8fff-000000000003";
    const entry = (name: string, size: number) => `<Contents><Key>${name}</Key><LastModified>2026-11-08T03:00:00.000Z</LastModified><Size>${size}</Size></Contents>`;
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${[
      entry(`backups/${daily}.mmbk`, 10),
      entry(`backups/monthly/2026-11/${run}/${part1}.mmbk`, 20),
      entry(`backups/monthly/2026-11/${run}/verified.mmbk`, 0),
      entry(`backups/monthly/2026-13/${run}/${part1}.mmbk`, 20),
      entry(`backups/monthly/2026-11/${run}/other.mmbk`, 20),
      entry(`backups/monthly/2026-11/${part1}.mmbk`, 20),
    ].join("")}</ListBucketResult>`;
    const listed = (() => {
      try {
        return readListing(xml).objects.map((o) => o.id);
      } catch {
        return "threw";
      }
    })();
    is("the listing offers daily objects, a month's parts and its mark; other names under backups/ are left alone", listed, [daily, `monthly/2026-11/${run}/${part1}`, `monthly/2026-11/${run}/verified`]);

    const config = { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "mm-backup-test", key: { accessKeyId: "k".repeat(20), secretAccessKey: "s".repeat(40) } };
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    let status = 200;
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)).pathname);
      return new Response(status === 200 ? "" : status === 409 ? "<Error><Code>ObjectLockedByBucketPolicy</Code></Error>" : "<Error><Code>PreconditionFailed</Code></Error>", { status });
    }) as typeof fetch;
    const r2 = r2BackupStore(config);
    const wrote = await r2.putNew(`monthly/2026-11/${run}/${part1}`, new Uint8Array([1])).then(() => "written", () => "refused");
    is("a month's part is written under backups/monthly/<month>/<run>/", [wrote, urls.at(-1)], ["written", `/mm-backup-test/backups/monthly/2026-11/${run}/${part1}.mmbk`]);
    const marking = await r2.putNew(`monthly/2026-11/${run}/verified`, new Uint8Array(0)).then(() => "written", () => "refused");
    is("its mark, an empty object", [marking, urls.at(-1)], ["written", `/mm-backup-test/backups/monthly/2026-11/${run}/verified.mmbk`]);
    const sent = urls.length;
    const odd = await Promise.all(["monthly/2026-11/../x", `monthly/2026-13/${run}/${part1}`, `monthly/2026-11/${run}/other`].map((id) => r2.putNew(id, new Uint8Array([1])).then(() => "written", () => "refused")));
    is("a name that is not one of ours: refused before any request", [odd, urls.length - sent], [["refused", "refused", "refused"], 0]);
    status = 409;
    const locked = await r2.putNew(daily, new Uint8Array([1])).then(() => null, (e: unknown) => e);
    is("409 on a create-only write (the name exists and is locked): never taken as written", locked instanceof Error, true);
    is("and said as the bucket lock, not as an id taken", locked instanceof Error && /lock/i.test(locked.message) && /409/.test(locked.message), true);
    status = 412;
    const taken = await r2.putNew(daily, new Uint8Array([1])).then(() => null, (e: unknown) => e);
    is("412 (the name exists, no lock): still refused as an id taken", taken instanceof Error && /already exists/.test(taken.message), true);
    globalThis.fetch = realFetch;
  }

  part("The worst month prices the three monthly sets and their marks (docs/backup-costs-2026-11-08.md, section 5a)");
  {
    // One part of at most 4 MiB, 30 days: a set's stored bound is 4,325,536 bytes; 30 + 2 + 3 = 35 sets = 151,393,760.
    const builtAsIs: BackupCostReview = { maxRows: 10_000, maxCommands: 20_210, maxBytes: 4_194_304, maxParts: 1, maxRunBytes: 4_194_304, retentionDays: 30, maxStoredBytes: 151_393_760, reviewedAt: "2026-11-08", source: "synthetic: the design as built with 3 monthly copies" };
    const month = backupWorstMonth(builtAsIs, 300);
    const line = (id: string) => month?.lines.find((l) => l.id === id)?.microUsd ?? -1;
    is("the ceiling of retention + 2 sets only is no longer one the run accepts: not priced", backupWorstMonth({ ...builtAsIs, maxStoredBytes: 138_417_152 }, 300), null);
    // (0.15139376 GB + 1 GB-month of rounding) × 15,000 = 17,270.91 → 17,271.
    is("R2 storage: 35 sets, plus a GB-month of rounding", line("r2-storage"), 17_271);
    // 35 sets × 3 objects (part, manifest, mark) = 105 alive at the month's start; 64 runs × (3 objects × 2 + 2 listings
    // of 1 page) = 512; 617; (617 / 1,000,000 + 1) × 4,500,000 = 4,502,776.5 → 4,502,777.
    is("R2 Class A: each object written and deleted (the mark too), 105 alive at the start, two listings a run", line("r2-class-a"), 4_502_777);
    // 64 × (2 read-backs + up to 105 reads when the last good copy is lost) = 6,848; (6,848 / 1,000,000 + 1) × 360,000
    // = 362,465.28 → 362,466.
    is("R2 Class B: each part and manifest read back (never the mark), up to 105 reads when the last good copy is lost", line("r2-class-b"), 362_466);
  }

  part("One unknown read of the mark never ends the months' copies (Claude 6's MEDIUM 1 on #3293, after #3273's fix)");
  {
    reset();
    wipe();
    seed(40);
    const start = Date.parse("2027-01-01T03:00:00Z");
    const plain = redis.pipeline.bind(redis);
    let fail = 0;
    (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (commands: (string | number)[][]) => {
      if (fail > 0 && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === "nl:backup:last-ok") {
        fail -= 1;
        throw new Error("a transient database error");
      }
      return plain(commands);
    }) as typeof redis.pipeline;
    const states: string[] = [];
    try {
      for (let d = 0; d < 100; d += 1) {
        at(start + d * DAY);
        // Day 40 (9 February): one read of the mark fails, and nothing else.
        if (d === 40) fail = 1;
        const result = await runBackup({ now: clock, review, store, key });
        states.push(result.ok ? result.prune : result.reason);
      }
    } finally {
      (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = plain;
    }
    is("the day of the unknown read holds its prune, and every day after prunes", [states[40], states.slice(41).filter((s) => s !== "done")], ["prune_unverified", []]);
    is("the next months' copies are marked again: February, March and April", marked().map((m) => m.month).slice(0, 3), ["2027-04", "2027-03", "2027-02"]);
  }

  part("A first day's leftover never ends the months' copies (Claude 6's MEDIUM 1 on #3293, case b)");
  {
    reset();
    wipe();
    seed(10);
    const start = Date.parse("2027-01-01T03:00:00Z");
    at(start);
    // A failed try's part from the same morning: an object that opens as no manifest.
    filler(9, start - HOUR, 2_000);
    const states: string[] = [];
    for (let d = 0; d < 4; d += 1) {
      at(start + d * DAY);
      const result = await runBackup({ now: clock, review, store, key });
      states.push(result.ok ? result.prune : result.reason);
    }
    is("the first copy is the base, and every day prunes", states, ["done", "done", "done", "done"]);
    is("January's copy is marked", marked().map((m) => m.month), ["2027-01"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
