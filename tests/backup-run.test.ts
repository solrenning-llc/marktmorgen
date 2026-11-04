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
 *   - more than one run, so more than one stored copy, in a day;
 *   - a copy that does not read back the same counted as done;
 *   - a good copy's time lost to a later failure, a failure's reason not kept,
 *     the outcome kept without expiry, or a failed write of the outcome turned
 *     into an exception after a good copy;
 *   - a step that throws, instead of a result that says which;
 *   - the report saying no good copy while one is under 48 hours old, or
 *     silent when there is none.
 */
import { readFileSync } from "node:fs";
import { BACKUP_COST_REVIEW, backupKey, backupLastFailure, backupStale, runBackup, validReview, type BackupCostReview } from "@/lib/backup-run";
import type { BackupObjectStore } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-02T03:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 40_000_000, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
const objects = new Map<string, Uint8Array>();
const store: BackupObjectStore = {
  putNew: async (id, bytes) => {
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
};
const broken: BackupObjectStore = { ...store, read: async () => new Uint8Array([1, 2, 3]) };
const key = Buffer.alloc(32, 5);

async function main(): Promise<void> {
  redis.clear();
  let clock = T0;
  redis.now = () => clock;
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
  for (const [name, bad] of [
    ["no date", { ...review, reviewedAt: "" }],
    ["a date that is not one", { ...review, reviewedAt: "2026-13-40" }],
    ["no source", { ...review, source: " " }],
    ["no retention", { ...review, retentionDays: 0 }],
    ["a storage ceiling the kept copies could pass", { ...review, maxStoredBytes: 30 * 1_000_000 }],
    ["no room for the run's own commands", { ...review, maxCommands: 3 }],
    ["a cap that is not a count", { ...review, maxRows: 1.5 }],
  ] as [string, BackupCostReview][]) {
    const at = sent;
    is(`${name}: refused, off, nothing sent`, [validReview(bad), await runBackup({ now: T0, review: bad, store, key }), sent - at], [false, { ok: false, reason: "off_review" }, 0]);
  }

  part("With all three, a copy is made, written once and read back the same");
  const ran = await runBackup({ now: T0, review, store, key });
  is("done, with the keys copied (its own day mark among them), one object", [ran.ok, ran.ok && ran.keys, objects.size], [true, 3, 1]);
  is("a second run the same day is refused before anything is written", [await runBackup({ now: T0 + HOUR, review, store: broken, key }), objects.size], [{ ok: false, reason: "already_ran" }, 1]);
  is("the good copy's time is kept, and survives that refusal", [await backupStale(T0 + 2 * HOUR), redis.run(["GET", "nl:backup:last-ok"])], [false, String(T0)]);
  is("the outcome expires by itself", Number(redis.run(["TTL", "nl:backup:last-ok"])) > 0, true);

  part("Failures say which step, and keep the last good copy's time");
  clock = T0 + DAY;
  is("a copy that does not read back the same is a failure", await runBackup({ now: clock, review, store: broken, key }), { ok: false, reason: "verify" });
  is("its reason is kept, with its time", await backupLastFailure(), { at: clock, reason: "verify" });
  is("one failed day after a good one: a good copy is still under 48 hours old", await backupStale(T0 + DAY + 20 * HOUR), false);
  clock = T0 + 2 * DAY;
  is("a cap reached is a failure that says which", await runBackup({ now: clock, review: { ...review, maxRows: 1 }, store, key }), { ok: false, reason: "export_too_many" });
  is("the reason kept is the latest", (await backupLastFailure())?.reason, "export_too_many");
  is("no good copy for over 48 hours: seen", await backupStale(T0 + 2 * DAY + HOUR), true);
  clock = T0 + 3 * DAY;
  failNext = "SCAN";
  is("the database failing during the export: a result, not an exception", await runBackup({ now: clock, review, store, key }), { ok: false, reason: "export_error" });
  is("and its reason is kept", (await backupLastFailure())?.reason, "export_error");
  clock = T0 + 4 * DAY;
  failNext = "SET";
  const noteLost = await runBackup({ now: clock, review, store, key });
  is("a refused day mark: the run stops before copying, as a result", [noteLost, objects.size], [{ ok: false, reason: "mark_error" }, 2]);
  clock = T0 + 5 * DAY;
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

  part("Nothing schedules it");
  is("vercel.json names no backup route", /backup/i.test(readFileSync("vercel.json", "utf8")), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
