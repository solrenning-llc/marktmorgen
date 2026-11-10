/**
 * 273 [BK1]: what the daily backup can cost in its worst month, from the caps
 * of a cost review (lib/backup-run.ts, BackupCostReview) and the rates the
 * repository records (lib/spend-cost-table.ts). It is a company cost: one run
 * copies the whole database under the review's caps, so it belongs with the
 * LLC fixed costs, 100% Marktmorgen (FX275; lib/llc-fixed-costs.ts, line
 * "backup"), never inside a plan. Inbox C4-38, C4-44, C4-46 and C4-49 (4 November 2026).
 *
 * The review is read once, as data (admitReview): a figure behind a getter, an
 * inherited review or one that throws when read is not priced (null, unknown).
 *
 * Every line is the most the code allows, never an average:
 *   - 64 runs a month: at most BACKUP_RUNS_PER_DAY (a run and one new try
 *     after a failure), one at a time, on each of 32 UTC days, since a run is counted on the
 *     day it starts, so one that starts before a midnight writes after it, and
 *     a 31-day billing period that does not start at 00:00 UTC touches 32 days;
 *     each run at its full caps (a new try follows a run that may have failed
 *     at its last step);
 *   - R2 storage: one run at a time writes only when its whole set fits under
 *     the review's maxStoredBytes (lib/backup-run.ts, inbox C4-53), so the
 *     bucket never holds more; validReview asks it for retention + 2 sets at
 *     their stored bound and the 3 months' copies (backupPeakSets, inbox
 *     C1-20261108-2021-C4-37 item 4); a GB-month is the average of the
 *     daily peaks, so the ceiling bounds it; the account's usage is rounded up
 *     to the next unit, so one more GB-month is added;
 *   - R2 operations: each object (every part, the manifest and, for a month's
 *     copy, its mark, an empty object; every run is taken as one that writes a
 *     mark) is one Class A
 *     when written and one more when deleted (the run's DeleteObject is free,
 *     but the lifecycle rule, kept as a safety net, may come first, and whether
 *     its deletion is billed is not said: taken as billed, never zero), one
 *     Class B when read back (every part and the manifest; a mark is never
 *     read); the objects alive when the month starts (at
 *     most backupKeptObjects) may be deleted in it too; each run lists twice
 *     (before it writes and after), backupListPages pages each, Class A, and
 *     may read the last verified manifest (or, when the bucket's rule took
 *     it, every object the bucket can hold, to keep every verified set) to
 *     keep it, Class B; the
 *     rounding adds one more million of each class;
 *   - Upstash: every command each run may send (maxCommands) and the two reads
 *     a day the report makes; the bytes a run may move: every SCAN page it may
 *     read (at most BACKUP_SCAN_PAGES, and no more than its commands allow) at
 *     500 names of 1,024 bytes, every copied byte as read (maxRunBytes counts
 *     the base64 DUMPs it keeps), each key's name sent twice, and the marks and
 *     the report's reads, and a paused copy's progress read and written, each at
 *     its bound (progressBound); the marks and the progress kept;
 *   - resumed runs (C1-20261109-1525-C4-68 item 3): a copy that stops at its
 *     deadline goes on in the day's next run, which walks the database again,
 *     lists the bucket twice and reads the progress. Each is one of the 64 runs
 *     above, priced at its full caps (every SCAN page, every copied byte, every
 *     command, every object written and read back, the route's whole duration),
 *     so a resumed run adds no run; the pause's own part is one of the review's
 *     maxParts;
 *   - Vercel: one call a run held for the route's maximum duration at 2 GB,
 *     its CPU the whole time, at the repository's iad1 rates and, as a line of its own, the difference up to gru1,
 *     the dearest region (the project pins no region);
 *   - the four lines docs/backup-costs-2026-11-08.md (#3271, section 3, items 2, 3, 4 and 8) priced outside the code
 *     until 9 November 2026: that dearest region; one more billing block of each Upstash and Vercel unit, as R2's
 *     rounding (no page says they do not round up); the batch of DUMPs read before the byte cap refuses it (one key
 *     since 9 November 2026, BACKUP_DUMP_BATCH), every key at Upstash's record cap; and every byte the function moves (Upstash, the set written and read back, the
 *     objects read to find the verified copies, that batch) at Vercel's dearest transfer rate, a ceiling;
 *   - and the provider allowance (PROVIDER_CHARGES_BPS) on all of it.
 * No supplier's free quota is credited (MR). What the code cannot bound is in
 * BACKUP_COST_UNKNOWNS: while any is open, the fixed-cost line's reviewed
 * ceiling stays unknown, never zero.
 */
import { BACKUP_DUMP_BATCH, BACKUP_RUN_COMMANDS, BACKUP_RUNS_PER_DAY, admitReview, backupKeptObjects, backupListPages, backupPeakSets, progressBound, type BackupCostReview } from "@/lib/backup-run";
import { BACKUP_MAX_BYTES } from "@/lib/backup-export";
import { BACKUP_SCAN_PAGES, MAX_PARTS, manifestBound, runStoredBound } from "@/lib/backup-parts";
import {
  PROVIDER_CHARGES_BPS,
  R2_CLASS_A_MICRO_USD_PER_MILLION,
  R2_CLASS_B_MICRO_USD_PER_MILLION,
  R2_STORAGE_MICRO_USD_PER_GB_MONTH,
  UPSTASH_MICRO_USD_PER_GB_MONTH,
  UPSTASH_MICRO_USD_PER_GB_TRANSFER,
  UPSTASH_MICRO_USD_PER_MILLION_COMMANDS,
  VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR,
  VERCEL_FUNCTION_GB,
  VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";

/** UTC days a billing month touches: 31 days that need not start at 00:00 UTC. */
export const BACKUP_DAYS_PER_MONTH = 32;
/** Runs billed in the worst month: BACKUP_RUNS_PER_DAY on each of those days. */
export const BACKUP_RUNS_PER_MONTH = BACKUP_DAYS_PER_MONTH * BACKUP_RUNS_PER_DAY;
/** The daily report's reads of the backup's outcome (backupStale, backupLastFailure). */
export const BACKUP_REPORT_READS_PER_DAY = 2;
/** Names a SCAN page is taken to answer (its COUNT, a hint) and the longest name, in bytes. */
export const BACKUP_SCAN_NAMES_PER_PAGE = 500;
export const BACKUP_SCAN_NAME_BYTES = 1_024;
/**
 * The backup's own small keys and their commands' bytes, at the most: the day counts of three days (each kept two days
 * from its first call, so the day before yesterday's lives into today), the last good copy, the last failure and the
 * lock (a random token).
 */
const MARK_KEYS = 6;
const MARK_BYTES = 1_024;
/** A PEXPIRETIME answer and a request's framing, at the most, in bytes. */
const ANSWER_FRAME_BYTES = 64;
/** R2 bills by decimal gigabytes. */
const GB = 1_000_000_000;

/*
 * The rates of the four lines below, each as docs/backup-costs-2026-11-08.md (#3271, sections 2 and 3) cites it, read
 * on 8 November 2026. No supplier's free quota is credited (MR).
 */
/**
 * Vercel's dearest region for functions, gru1: $0.221 an Active CPU-hour and $0.0183 a GB-hour of Provisioned Memory
 * (https://vercel.com/docs/functions/usage-and-pricing, last_updated 2026-06-16, read 2026-11-08). The project pins no
 * region and the live one is not verified, so the backup's route is priced there (item 2).
 */
const VERCEL_DEAREST_CPU_MICRO_USD_PER_HOUR = 221_000;
const VERCEL_DEAREST_MEMORY_MICRO_USD_PER_GB_HOUR = 18_300;
/**
 * Vercel's dearest transfer rate, Fast Origin Transfer at "$0.06 – $0.43" a GB by region
 * (https://vercel.com/docs/manage-cdn-usage and https://vercel.com/docs/pricing/regional-pricing, read 2026-11-08).
 * No page bills a function's outbound calls; "not listed" is not "not billed", so every byte the function moves is
 * priced at the top of the range, a ceiling (item 3).
 */
const VERCEL_TRANSFER_MICRO_USD_PER_GB = 430_000;
/**
 * Upstash's command block: "$0.20 per 100K" (https://upstash.com/docs/redis/overall/billing, read 2026-11-08). The page
 * states no rounding, and silence is not "no rounding": one more block of each unit is priced, as R2's (item 8).
 */
const UPSTASH_COMMAND_BLOCK = 100_000;
/**
 * Upstash's maximum record size, "100 MB" on Pay-As-You-Go (the same billing page, read 2026-11-08), read as 100 MiB,
 * the dearer reading: the most one key's DUMP can weigh, since the backup does not cap a key's size (item 4).
 */
const UPSTASH_MAX_RECORD_BYTES = 100 * 1_024 * 1_024;
/** A DUMP comes back as base64 (lib/redis.ts, redisPipelineBase64): 4 bytes for every 3, rounded up. */
const base64Bytes = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * The route's longest run, in seconds: app/api/cron/backup/route.ts's maxDuration (a literal there, as Next.js reads
 * it; tests/bk1-backup-route.test.ts holds the two equal). A review is priced at this duration (Claude 5's LOW,
 * 9 November 2026), never at a shorter one assumed.
 */
export const BACKUP_ROUTE_SECONDS = 800;

/**
 * What the code cannot bound, each an open item of docs/backup-cost-2026-11-04.md
 * (sections 5 and 5d): while any is here, the fixed-cost line is not reviewed.
 */
export const BACKUP_COST_UNKNOWNS = [
  "vercel-route: the route's maxDuration of 800 s (BACKUP_ROUTE_SECONDS) needs Fluid compute, and no deployment has accepted it yet",
  "vercel-rates: the Vercel rates were read on 7 October 2026 and not since",
  "vercel-transfer: whether Vercel bills the function's bytes sent to R2 and Upstash",
  "upstash-overshoot: the last key's DUMP (a batch of one) is read before the cap refuses it, and a key's size is not capped by the backup",
  "scan-names: SCAN's COUNT is a hint, so a page's names are taken at 500, other products' key names in the shared database are not capped, and a name escaped in JSON can weigh more than its bytes",
  "refused-calls: nothing limits how many calls a day reach the run; each one refused at the lock sends two commands (the lock, the note in the report), at the day's count six, and is one Vercel call",
  "report-reads: no schedule calls the report yet, so its two reads a day are assumed",
  "billing-units: whether Upstash and Vercel round usage up to a block, as R2 does",
  "restore-reads: reading a set back to restore (lib/backup-parts.ts, readBackupSet) is priced when a restore is decided",
] as const;

export type BackupCostLine = { id: string; microUsd: number; basis: string };
export type BackupWorstMonth = {
  lines: readonly BackupCostLine[];
  /** Every line, with the provider allowance, in micro-dollars. */
  knownMicroUsd: number;
  unknowns: readonly string[];
};

/**
 * The worst month of the backup under a review and the route's maximum
 * duration in seconds; null when the review is not one the run would accept.
 */
export function backupWorstMonth(raw: BackupCostReview, routeSeconds: number): BackupWorstMonth | null {
  // Priced only from the copy the run would use: read once, from data fields (lib/backup-run.ts, admitReview).
  const review = admitReview(raw);
  if (!review || !Number.isSafeInteger(routeSeconds) || routeSeconds <= 0 || routeSeconds > 800) return null;
  const parts = review.maxParts ?? 1;
  const runBytes = review.maxRunBytes ?? Math.min(review.maxBytes, BACKUP_MAX_BYTES);
  // Written and deleted: the parts, the manifest and a month's mark. Read back: the parts and the manifest.
  const objects = parts + 2;
  const readBacks = parts + 1;
  const runs = BACKUP_RUNS_PER_MONTH;
  const days = BACKUP_DAYS_PER_MONTH;
  const up = (n: number) => Math.ceil(n);
  const sets = backupPeakSets(review.retentionDays);
  const setBytes = runStoredBound({ maxParts: parts, maxRunBytes: runBytes });
  const listPages = backupListPages(review);
  const kept = backupKeptObjects(review);
  // The walk gets the commands the run does not keep for its own marks, one a page, and never more than the cap.
  const scanPages = Math.min(review.maxCommands - BACKUP_RUN_COMMANDS, BACKUP_SCAN_PAGES);

  const storage = up(((review.maxStoredBytes / GB) + 1) * R2_STORAGE_MICRO_USD_PER_GB_MONTH);
  // Deleted in a month: what it writes, and what was alive when it started (at most `kept` objects); two listings a run.
  const classA = up(((runs * (2 * objects + 2 * listPages) + kept) / 1_000_000 + 1) * R2_CLASS_A_MICRO_USD_PER_MILLION);
  // Each object read back, and, when room must be made, the last verified manifest, or every object the bucket can
  // hold when that copy is lost (lib/backup-run.ts, verifiedInBucket): at most `kept` reads a run.
  const classB = up(((runs * (readBacks + kept)) / 1_000_000 + 1) * R2_CLASS_B_MICRO_USD_PER_MILLION);
  const commands = runs * review.maxCommands + days * BACKUP_REPORT_READS_PER_DAY;
  const upstashCommands = up((commands / 1_000_000) * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS);
  // A paused copy's progress, at most a manifest's bound for the review's parts (lib/backup-run.ts refuses to keep a
  // larger one): read once and written once a run.
  const progress = progressBound(review);
  const runTransfer =
    scanPages * BACKUP_SCAN_NAMES_PER_PAGE * BACKUP_SCAN_NAME_BYTES
    + runBytes
    + review.maxRows * (2 * BACKUP_SCAN_NAME_BYTES + ANSWER_FRAME_BYTES)
    + (MARK_KEYS * MARK_BYTES)
    + 2 * progress;
  const upstashTransfer = up(((runs * runTransfer) / GB) * UPSTASH_MICRO_USD_PER_GB_TRANSFER);
  const marks = up(((MARK_KEYS * MARK_BYTES + progress) / GB) * UPSTASH_MICRO_USD_PER_GB_MONTH);
  const hours = routeSeconds / 3_600;
  const vercel = up(runs * (VERCEL_FUNCTION_GB * hours * VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR + hours * VERCEL_CPU_MICRO_USD_PER_HOUR + VERCEL_CALL_MICRO_USD_PER_MILLION / 1_000_000));
  // The same calls at gru1, less what the line above already counts at iad1 (the invocation is priced alike).
  const region = up(runs * (VERCEL_FUNCTION_GB * hours * (VERCEL_DEAREST_MEMORY_MICRO_USD_PER_GB_HOUR - VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) + hours * (VERCEL_DEAREST_CPU_MICRO_USD_PER_HOUR - VERCEL_CPU_MICRO_USD_PER_HOUR)));
  // One more block of each unit: Upstash commands, bandwidth (a GB) and storage (a GB-month), Vercel CPU (an hour) and
  // memory (a GB-hour), at the dearest region.
  const blocks = up(
    (UPSTASH_COMMAND_BLOCK / 1_000_000) * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS
    + UPSTASH_MICRO_USD_PER_GB_TRANSFER
    + UPSTASH_MICRO_USD_PER_GB_MONTH
    + VERCEL_DEAREST_CPU_MICRO_USD_PER_HOUR
    + VERCEL_DEAREST_MEMORY_MICRO_USD_PER_GB_HOUR,
  );
  // The batch of DUMPs read before the byte cap refuses it, every key at the record cap: the copied bytes above stop at
  // the cap, these are the bytes past it.
  const overshootBytes = BACKUP_DUMP_BATCH * base64Bytes(UPSTASH_MAX_RECORD_BYTES);
  const overshoot = up(((runs * overshootBytes) / GB) * UPSTASH_MICRO_USD_PER_GB_TRANSFER);
  // Every byte the function moves: Upstash's (above), the overshoot, the set written and read back, and the objects
  // read to find the verified copies (at most `kept`, each read only up to a manifest's bound: lib/backup-run.ts).
  const verifyBytes = kept * manifestBound(MAX_PARTS);
  const movedBytes = runTransfer + overshootBytes + 2 * setBytes + verifyBytes;
  const transfer = up(((runs * movedBytes) / GB) * VERCEL_TRANSFER_MICRO_USD_PER_GB);

  const used: BackupCostLine[] = [
    { id: "r2-storage", microUsd: storage, basis: `the review's ceiling of ${review.maxStoredBytes} bytes (at least ${sets} sets of ${setBytes}: the retention, two more and the 3 months' copies), never passed, plus one GB-month of rounding` },
    { id: "r2-class-a", microUsd: classA, basis: `${runs} runs × (${objects} objects (parts, manifest, a month's mark) × 2 (written, then deleted) + 2 listings of ${listPages} page) + ${kept} objects alive at the month's start, deleted, plus one million of rounding` },
    { id: "r2-class-b", microUsd: classB, basis: `${runs} runs × (${readBacks} read-backs + up to ${kept} reads to find the verified copies to keep), plus one million of rounding` },
    { id: "upstash-commands", microUsd: upstashCommands, basis: `${runs} × ${review.maxCommands} commands + ${days} × ${BACKUP_REPORT_READS_PER_DAY} report reads` },
    { id: "upstash-transfer", microUsd: upstashTransfer, basis: `${runs} runs × ${runTransfer} bytes: ${scanPages} SCAN pages of ${BACKUP_SCAN_NAMES_PER_PAGE} names of ${BACKUP_SCAN_NAME_BYTES} bytes, ${runBytes} copied bytes, each key's name sent twice, the marks and the report's reads, a paused copy's progress of up to ${progress} bytes read and written` },
    { id: "upstash-storage", microUsd: marks, basis: `${MARK_KEYS} marks of at most ${MARK_BYTES} bytes and a progress of up to ${progress} bytes kept` },
    { id: "vercel", microUsd: vercel, basis: `${runs} calls of ${routeSeconds} s at ${VERCEL_FUNCTION_GB} GB, CPU the whole time` },
    { id: "vercel-region", microUsd: region, basis: `the same ${runs} calls at gru1, the dearest region ($0.221 a CPU-hour, $0.0183 a GB-hour), less the iad1 rates above` },
    { id: "billing-blocks", microUsd: blocks, basis: `one more block of each unit: ${UPSTASH_COMMAND_BLOCK} Upstash commands, 1 GB of Upstash bandwidth, 1 GB-month of Upstash storage, 1 CPU-hour and 1 GB-hour at gru1` },
    { id: "upstash-overshoot", microUsd: overshoot, basis: `${runs} runs × ${BACKUP_DUMP_BATCH} keys read before the byte cap refuses them, each at Upstash's record cap (${UPSTASH_MAX_RECORD_BYTES} bytes, ${base64Bytes(UPSTASH_MAX_RECORD_BYTES)} as base64)` },
    { id: "vercel-transfer", microUsd: transfer, basis: `${runs} runs × ${movedBytes} bytes moved (${runTransfer} with Upstash, ${overshootBytes} past the cap, ${setBytes} written and read back, up to ${verifyBytes} read to find the verified copies) at $0.43 a GB, the dearest rate` },
  ];
  const sum = used.reduce((n, line) => n + line.microUsd, 0);
  const allowance = up((sum * PROVIDER_CHARGES_BPS) / 10_000);
  const lines = [...used, { id: "provider-allowance", microUsd: allowance, basis: `${PROVIDER_CHARGES_BPS / 100}% on every supplier charge` }];
  return { lines, knownMicroUsd: sum + allowance, unknowns: BACKUP_COST_UNKNOWNS };
}
