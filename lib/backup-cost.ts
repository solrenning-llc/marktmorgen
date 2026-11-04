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
 *     their stored bound (backupPeakSets); a GB-month is the average of the
 *     daily peaks, so the ceiling bounds it; the account's usage is rounded up
 *     to the next unit, so one more GB-month is added;
 *   - R2 operations: each object (every part and the manifest) is one Class A
 *     when written and one more when deleted (the run's DeleteObject is free,
 *     but the lifecycle rule, kept as a safety net, may come first, and whether
 *     its deletion is billed is not said: taken as billed, never zero), one
 *     Class B when read back; the objects alive when the month starts (at
 *     most backupKeptObjects) may be deleted in it too; each run lists twice
 *     (before it writes and after), backupListPages pages each, Class A, and
 *     may read the last verified manifest once (Class B) to keep it; the
 *     rounding adds one more million of each class;
 *   - Upstash: every command each run may send (maxCommands) and the two reads
 *     a day the report makes; the bytes a run may move: every SCAN page it may
 *     read (at most BACKUP_SCAN_PAGES, and no more than its commands allow) at
 *     500 names of 1,024 bytes, every copied byte as read (maxRunBytes counts
 *     the base64 DUMPs it keeps), each key's name sent twice, and the marks and
 *     the report's reads; the marks kept;
 *   - Vercel: one call a run held for the route's maximum duration at 2 GB,
 *     its CPU the whole time;
 *   - and the provider allowance (PROVIDER_CHARGES_BPS) on all of it.
 * No supplier's free quota is credited (MR). What the code cannot bound is in
 * BACKUP_COST_UNKNOWNS: while any is open, the fixed-cost line's reviewed
 * ceiling stays unknown, never zero.
 */
import { BACKUP_RUN_COMMANDS, BACKUP_RUNS_PER_DAY, admitReview, backupKeptObjects, backupListPages, backupPeakSets, type BackupCostReview } from "@/lib/backup-run";
import { BACKUP_MAX_BYTES } from "@/lib/backup-export";
import { BACKUP_SCAN_PAGES, runStoredBound } from "@/lib/backup-parts";
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

/**
 * What the code cannot bound, each an open item of docs/backup-cost-2026-11-04.md
 * (sections 5 and 5d): while any is here, the fixed-cost line is not reviewed.
 */
export const BACKUP_COST_UNKNOWNS = [
  "vercel-route: no route runs the backup yet, so its maximum duration is the one assumed here, not a setting",
  "vercel-rates: the Vercel rates were read on 7 October 2026 and not since",
  "vercel-transfer: whether Vercel bills the function's bytes sent to R2 and Upstash",
  "upstash-overshoot: the last batch of DUMPs is read before the cap refuses it, and a key's size is not capped by the backup",
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
  const objects = parts + 1;
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
  // Each object read back, and the last verified manifest read once a run when room must be made.
  const classB = up(((runs * (objects + 1)) / 1_000_000 + 1) * R2_CLASS_B_MICRO_USD_PER_MILLION);
  const commands = runs * review.maxCommands + days * BACKUP_REPORT_READS_PER_DAY;
  const upstashCommands = up((commands / 1_000_000) * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS);
  const runTransfer =
    scanPages * BACKUP_SCAN_NAMES_PER_PAGE * BACKUP_SCAN_NAME_BYTES
    + runBytes
    + review.maxRows * (2 * BACKUP_SCAN_NAME_BYTES + ANSWER_FRAME_BYTES)
    + (MARK_KEYS * MARK_BYTES);
  const upstashTransfer = up(((runs * runTransfer) / GB) * UPSTASH_MICRO_USD_PER_GB_TRANSFER);
  const marks = up(((MARK_KEYS * MARK_BYTES) / GB) * UPSTASH_MICRO_USD_PER_GB_MONTH);
  const hours = routeSeconds / 3_600;
  const vercel = up(runs * (VERCEL_FUNCTION_GB * hours * VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR + hours * VERCEL_CPU_MICRO_USD_PER_HOUR + VERCEL_CALL_MICRO_USD_PER_MILLION / 1_000_000));

  const used: BackupCostLine[] = [
    { id: "r2-storage", microUsd: storage, basis: `the review's ceiling of ${review.maxStoredBytes} bytes (at least ${sets} sets of ${setBytes}), never passed, plus one GB-month of rounding` },
    { id: "r2-class-a", microUsd: classA, basis: `${runs} runs × (${objects} objects × 2 (written, then deleted) + 2 listings of ${listPages} page) + ${kept} objects alive at the month's start, deleted, plus one million of rounding` },
    { id: "r2-class-b", microUsd: classB, basis: `${runs} runs × (${objects} read-backs + 1 manifest read to keep the last verified copy), plus one million of rounding` },
    { id: "upstash-commands", microUsd: upstashCommands, basis: `${runs} × ${review.maxCommands} commands + ${days} × ${BACKUP_REPORT_READS_PER_DAY} report reads` },
    { id: "upstash-transfer", microUsd: upstashTransfer, basis: `${runs} runs × ${runTransfer} bytes: ${scanPages} SCAN pages of ${BACKUP_SCAN_NAMES_PER_PAGE} names of ${BACKUP_SCAN_NAME_BYTES} bytes, ${runBytes} copied bytes, each key's name sent twice, the marks and the report's reads` },
    { id: "upstash-storage", microUsd: marks, basis: `${MARK_KEYS} marks of at most ${MARK_BYTES} bytes kept` },
    { id: "vercel", microUsd: vercel, basis: `${runs} calls of ${routeSeconds} s at ${VERCEL_FUNCTION_GB} GB, CPU the whole time` },
  ];
  const sum = used.reduce((n, line) => n + line.microUsd, 0);
  const allowance = up((sum * PROVIDER_CHARGES_BPS) / 10_000);
  const lines = [...used, { id: "provider-allowance", microUsd: allowance, basis: `${PROVIDER_CHARGES_BPS / 100}% on every supplier charge` }];
  return { lines, knownMicroUsd: sum + allowance, unknowns: BACKUP_COST_UNKNOWNS };
}
