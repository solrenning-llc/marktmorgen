/**
 * 273 [BK1]: the daily backup run (lib/backup-run.ts): export → seal → write
 * to the backup's own bucket → read back, the outcome kept for the report.
 * Against the in-memory database and a stand-in store; nothing real. Off three
 * ways today, each checked: no reviewed cost ceiling (BACKUP_COST_REVIEW is
 * null), no backup bucket settings, no encryption key. No schedule calls it.
 *
 * What fails here:
 *   - a run that sends a single command while any of the three is missing, or
 *     with a review that lacks its date, source, retention or storage ceiling,
 *     or whose ceiling the kept copies could pass;
 *   - a review read through a getter, inherited, or that throws when read;
 *   - more than a run and one new try after a failure in a day, or a call past
 *     them that sends more than the day's count;
 *   - a walk past its 200 SCAN pages taken as anything but its own failure;
 *   - a copy older than the retention left after a run that passed the day's
 *     count, a write after a deletion that did not complete, or more sets kept
 *     at once than the code proves (2 × (retention + 2));
 *   - a copy that does not read back the same counted as done;
 *   - a good copy's time lost to a later failure, a failure's reason not kept,
 *     the outcome kept without expiry, or a failed write of the outcome turned
 *     into an exception after a good copy;
 *   - a step that throws, instead of a result that says which;
 *   - the report saying no good copy while one is under 48 hours old, or
 *     silent when there is none.
 */
import { readFileSync } from "node:fs";
import { BACKUP_COST_REVIEW, backupKey, backupLastFailure, backupListPages, backupPeakSets, backupStale, runBackup, validReview, type BackupCostReview } from "@/lib/backup-run";
import { BACKUP_SCAN_PAGES } from "@/lib/backup-parts";
import type { BackupBucket } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-02T03:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// One set's stored bound: 1,000,000 + 65,536 + 160 + 65,536 = 1,131,232 bytes; 2 × (30 + 2) = 64 sets = 72,398,848.
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 72_398_848, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
/** The stand-in bucket: each object with the moment it was written, listed in pages of LIST_PAGE, deleted on request. */
let bucketClock = T0;
let LIST_PAGE = 1_000;
let failDelete = false;
const objects = new Map<string, Uint8Array>();
const writtenAt = new Map<string, number>();
const deletes: string[] = [];
let lists = 0;
const store: BackupBucket = {
  putNew: async (id, bytes) => {
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
    writtenAt.set(id, bucketClock);
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
  list: async (next) => {
    lists += 1;
    const ids = [...objects.keys()].sort();
    const from = next === null ? 0 : Number(next);
    const page = ids.slice(from, from + LIST_PAGE);
    return { objects: page.map((id) => ({ id, writtenAt: writtenAt.get(id)! })), next: from + LIST_PAGE < ids.length ? String(from + LIST_PAGE) : null };
  },
  delete: async (id) => {
    if (failDelete) throw new Error("delete refused");
    deletes.push(id);
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
    ["a storage ceiling the kept copies could pass", { ...review, maxStoredBytes: 30 * 1_000_000 }],
    // 33 sets: the ceiling of the lifecycle rule's reading (inbox C4-38), no longer enough.
    ["a storage ceiling of retention + 3 sets", { ...review, maxStoredBytes: 33 * 1_131_232 }],
    // 63 sets of 1,131,232 bytes: one short of 2 runs a day over the 32 days a 30-day line and a run's length touch.
    ["a storage ceiling one set short of what the code proves", { ...review, maxStoredBytes: 72_398_847 }],
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
  is("done, with the keys copied (its own day mark among them), one part and its manifest", [ran.ok, ran.ok && ran.keys, ran.ok && ran.parts, objects.size], [true, 3, 1, 2]);
  is("a second run the same day is refused before anything is written", [await runBackup({ now: T0 + HOUR, review, store: broken, key }), objects.size], [{ ok: false, reason: "already_ran" }, 2]);
  is("the good copy's time is kept, and survives that refusal", [await backupStale(T0 + 2 * HOUR), redis.run(["GET", "nl:backup:last-ok"])], [false, String(T0)]);
  is("the outcome expires by itself", Number(redis.run(["TTL", "nl:backup:last-ok"])) > 0, true);

  part("Failures say which step, and keep the last good copy's time");
  at(T0 + DAY);
  is("a copy that does not read back the same is a failure", await runBackup({ now: clock, review, store: broken, key }), { ok: false, reason: "verify" });
  is("its reason is kept, with its time", await backupLastFailure(), { at: clock, reason: "verify" });
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
  redis.clear();
  redis.run(["SET", "nl:store:one", "a shop"]);
  at(T0 + 10 * DAY);
  is("the day's first run fails", (await runBackup({ now: clock, review, store: broken, key })).ok, false);
  at(T0 + 10 * DAY + HOUR);
  is("one new try the same day runs, and is done", (await runBackup({ now: clock, review, store, key })).ok, true);
  {
    const [was, listed, kept] = [sent, lists, objects.size];
    at(T0 + 10 * DAY + 2 * HOUR);
    is("a third call that day: refused at the day's count, two commands, nothing listed or written", [await runBackup({ now: clock, review, store, key }), sent - was, lists - listed, objects.size - kept], [{ ok: false, reason: "already_ran" }, 2, 0, 0]);
  }
  at(T0 + 11 * DAY);
  is("a day whose first run is done", (await runBackup({ now: clock, review, store, key })).ok, true);
  {
    const [was, kept] = [sent, objects.size];
    at(T0 + 11 * DAY + HOUR);
    is("no new try after a good run: refused, two commands, nothing written", [await runBackup({ now: clock, review, store, key }), sent - was, objects.size - kept], [{ ok: false, reason: "already_ran" }, 2, 0]);
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

  part("The run deletes its own copies past the retention before it writes (inbox C4-49)");
  {
    objects.clear();
    writtenAt.clear();
    at(T0 + 40 * DAY);
    const line = clock - 30 * DAY;
    for (const [id, when] of [["11111111-1111-4111-8111-111111111111", line - 1], ["22222222-2222-4222-8222-222222222222", line], ["33333333-3333-4333-8333-333333333333", line + DAY]] as const) {
      objects.set(id, new Uint8Array([1]));
      writtenAt.set(id, when);
    }
    deletes.length = 0;
    const pruned = await runBackup({ now: clock, review, store, key });
    is("done; the copy older than 30 days deleted, the one of exactly 30 days and the younger kept", [pruned.ok, pruned.ok && pruned.pruned, deletes, objects.has("22222222-2222-4222-8222-222222222222"), objects.has("33333333-3333-4333-8333-333333333333"), objects.size], [true, 1, ["11111111-1111-4111-8111-111111111111"], true, true, 4]);
    at(T0 + 71 * DAY);
    failDelete = true;
    const kept = objects.size;
    const refused = await runBackup({ now: clock, review, store, key });
    failDelete = false;
    is("a delete that fails: the run writes nothing and says so", [refused, objects.size - kept, (await backupLastFailure())?.reason], [{ ok: false, reason: "prune_error" }, 0, "prune_error"]);
    is("the last good copy's time is not touched by it", redis.run(["GET", "nl:backup:last-ok"]), String(T0 + 40 * DAY));
    at(T0 + 71 * DAY + HOUR);
    const again = await runBackup({ now: clock, review, store, key });
    is("the day's new try deletes them and writes", [again.ok, again.ok && again.pruned, objects.size], [true, 4, 2]);
    at(T0 + 102 * DAY);
    for (const id of ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"]) {
      objects.set(id, new Uint8Array([1]));
      writtenAt.set(id, clock - 40 * DAY);
    }
    LIST_PAGE = 1;
    const [listed, kept2] = [lists, objects.size];
    const capped = await runBackup({ now: clock, review, store, key });
    LIST_PAGE = 1_000;
    is(`a listing longer than its ${backupListPages(review)} page: what it read deleted, nothing written, said so`, [capped, lists - listed, objects.size, (await backupLastFailure())?.reason], [{ ok: false, reason: "prune_pages" }, backupListPages(review), kept2 - 1, "prune_pages"]);
  }

  part("What the code proves: never more than 2 × (retention + 2) sets kept, none older than the retention after a run");
  {
    objects.clear();
    writtenAt.clear();
    // 90 days of runs at awkward times: just before midnight, writing past it; a first run that fails and a new try.
    let seed = 7;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const start = T0 + 200 * DAY - (T0 % DAY);
    let most = 0;
    let oldest = 0;
    for (let day = 0; day < 90; day += 1) {
      const first = start + day * DAY + (rand() < 0.5 ? DAY - 1_000 : Math.floor(rand() * DAY));
      for (const [when, bad] of [[first, rand() < 0.4], [first + 1_200, rand() < 0.3]] as const) {
        at(when);
        // Every object of this run is written 800 s after it starts, past a midnight when it started just before one.
        bucketClock = when + 800_000;
        const result = await runBackup({ now: when, review, store: bad ? broken : store, key });
        most = Math.max(most, objects.size);
        // A call refused at the day's count deletes nothing; every other run deleted first.
        if (result.ok || result.reason !== "already_ran") oldest = Math.max(oldest, ...[...writtenAt.values()].map((w) => when - w));
      }
    }
    is(`at most ${backupPeakSets(30)} sets of 2 objects at once (seen ${most})`, most <= 2 * backupPeakSets(30) && most > 2 * 30, true);
    is("after each run that passed the day's count, nothing older than 30 days", oldest <= 30 * DAY, true);
  }

  part("Nothing schedules it");
  is("vercel.json names no backup route", /backup/i.test(readFileSync("vercel.json", "utf8")), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
