/**
 * 273 [BK1]: what the daily backup can cost in its worst month, from the caps
 * of a cost review (lib/backup-run.ts, BackupCostReview) and the rates the
 * repository records (lib/spend-cost-table.ts). It is a company cost: one run
 * copies the whole database under the review's caps, so it belongs with the
 * LLC fixed costs, 100% Marktmorgen (FX275; lib/llc-fixed-costs.ts, line
 * "backup"), never inside a plan. Inbox C4-38 and C4-44 (4 November 2026).
 *
 * Every line is the most the caps allow, never an average:
 *   - 32 runs a month: one a UTC day, marked when it starts, so a run that
 *     starts before a midnight writes after it, and a 31-day billing period
 *     that does not start at 00:00 UTC touches 32 days (review of #2175);
 *   - R2 storage: the bucket keeps a set retentionDays, its lifecycle rule
 *     removes it "within 24 hours" of expiry, the day's set is being written
 *     and a run that wrote past its midnight is a day late, so retentionDays
 *     + 3 sets at the daily peak (validReview holds the same), each at its stored
 *     bound (runStoredBound); a GB-month is the average of the daily peaks,
 *     so the peak bounds it; the account's usage is rounded up to the next
 *     unit, so one more GB-month is added;
 *   - R2 operations: each object (every part and the manifest) is one Class A
 *     when written and one more when the lifecycle rule deletes it (whether
 *     that is billed is not said: taken as billed, never zero), one Class B
 *     when read back; the rounding adds one more million of each class;
 *   - Upstash: every command the run may send (maxCommands) and the two reads
 *     the daily report makes; the bytes it may move: every SCAN page at 500
 *     names of 1,024 bytes (as if every command were a page), every copied
 *     byte as read (maxRunBytes counts the base64 DUMPs it keeps), each key's
 *     name sent twice, and the marks and the report's reads; the marks kept;
 *   - Vercel: one call a run held for the route's maximum duration at 2 GB,
 *     its CPU the whole time;
 *   - and the provider allowance (PROVIDER_CHARGES_BPS) on all of it.
 * No supplier's free quota is credited (MR). What the caps cannot bound is in
 * BACKUP_COST_UNKNOWNS: while any is open, the fixed-cost line's reviewed
 * ceiling stays unknown, never zero.
 */
import { type BackupCostReview, validReview } from "@/lib/backup-run";
import { BACKUP_MAX_BYTES } from "@/lib/backup-export";
import { runStoredBound } from "@/lib/backup-parts";
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

/** Runs billed in the worst month: one a UTC day, and the one marked the day before that writes past midnight. */
export const BACKUP_RUNS_PER_MONTH = 32;
/** The daily report's reads of the backup's outcome (backupStale, backupLastFailure). */
export const BACKUP_REPORT_READS_PER_DAY = 2;
/** Sets at the daily peak beyond the retention: the lifecycle rule's day of delay, the day being written (inbox C4-38) and a run that wrote past its midnight. */
export const BACKUP_PEAK_EXTRA_SETS = 3;
/** Names a SCAN page is taken to answer (its COUNT, a hint) and the longest name, in bytes. */
export const BACKUP_SCAN_NAMES_PER_PAGE = 500;
export const BACKUP_SCAN_NAME_BYTES = 1_024;
/** The backup's own small keys (the day marks of two days, the last good copy, the last failure) and their commands' bytes, at the most. */
const MARK_KEYS = 4;
const MARK_BYTES = 1_024;
/** A PEXPIRETIME answer and a request's framing, at the most, in bytes. */
const ANSWER_FRAME_BYTES = 64;
/** R2 bills by decimal gigabytes. */
const GB = 1_000_000_000;

/**
 * What the caps cannot bound, each an open item of docs/backup-cost-2026-11-04.md
 * (section 5): while any is here, the fixed-cost line is not reviewed.
 */
export const BACKUP_COST_UNKNOWNS = [
  "vercel-route: no route runs the backup yet, so its maximum duration is the one assumed here, not a setting",
  "vercel-rates: the Vercel rates were read on 7 October 2026 and not since",
  "vercel-transfer: whether Vercel bills the function's bytes sent to R2 and Upstash",
  "upstash-overshoot: the last batch of DUMPs is read before the cap refuses it, and a key's size is not capped by the backup",
  "scan-names: SCAN's COUNT is a hint, other products' key names in the shared database are not capped, and a name escaped in JSON can weigh more than its bytes",
  "calls-per-day: nothing limits how often a day the run is called; each call refused at the day's mark sends one command and is one Vercel call",
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
export function backupWorstMonth(review: BackupCostReview, routeSeconds: number): BackupWorstMonth | null {
  if (!validReview(review) || !Number.isSafeInteger(routeSeconds) || routeSeconds <= 0 || routeSeconds > 800) return null;
  const parts = review.maxParts ?? 1;
  const runBytes = review.maxRunBytes ?? Math.min(review.maxBytes, BACKUP_MAX_BYTES);
  const objects = parts + 1;
  const runs = BACKUP_RUNS_PER_MONTH;
  const up = (n: number) => Math.ceil(n);

  const peakBytes = (review.retentionDays + BACKUP_PEAK_EXTRA_SETS) * runStoredBound({ maxParts: parts, maxRunBytes: runBytes });
  const storage = up(((peakBytes / GB) + 1) * R2_STORAGE_MICRO_USD_PER_GB_MONTH);
  const classA = up(((runs * 2 * objects) / 1_000_000 + 1) * R2_CLASS_A_MICRO_USD_PER_MILLION);
  const classB = up(((runs * objects) / 1_000_000 + 1) * R2_CLASS_B_MICRO_USD_PER_MILLION);
  const commands = runs * (review.maxCommands + BACKUP_REPORT_READS_PER_DAY);
  const upstashCommands = up((commands / 1_000_000) * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS);
  const runTransfer =
    review.maxCommands * BACKUP_SCAN_NAMES_PER_PAGE * BACKUP_SCAN_NAME_BYTES
    + runBytes
    + review.maxRows * (2 * BACKUP_SCAN_NAME_BYTES + ANSWER_FRAME_BYTES)
    + (MARK_KEYS * MARK_BYTES);
  const upstashTransfer = up(((runs * runTransfer) / GB) * UPSTASH_MICRO_USD_PER_GB_TRANSFER);
  const marks = up(((MARK_KEYS * MARK_BYTES) / GB) * UPSTASH_MICRO_USD_PER_GB_MONTH);
  const hours = routeSeconds / 3_600;
  const vercel = up(runs * (VERCEL_FUNCTION_GB * hours * VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR + hours * VERCEL_CPU_MICRO_USD_PER_HOUR + VERCEL_CALL_MICRO_USD_PER_MILLION / 1_000_000));

  const used: BackupCostLine[] = [
    { id: "r2-storage", microUsd: storage, basis: `${review.retentionDays} + ${BACKUP_PEAK_EXTRA_SETS} sets of ${runStoredBound({ maxParts: parts, maxRunBytes: runBytes })} bytes at the daily peak, plus one GB-month of rounding` },
    { id: "r2-class-a", microUsd: classA, basis: `${runs} runs × ${objects} objects × 2 (written, then deleted by the lifecycle rule), plus one million of rounding` },
    { id: "r2-class-b", microUsd: classB, basis: `${runs} runs × ${objects} read-backs, plus one million of rounding` },
    { id: "upstash-commands", microUsd: upstashCommands, basis: `${runs} × (${review.maxCommands} + ${BACKUP_REPORT_READS_PER_DAY}) commands` },
    { id: "upstash-transfer", microUsd: upstashTransfer, basis: `${runs} runs × ${runTransfer} bytes: every command a SCAN page of ${BACKUP_SCAN_NAMES_PER_PAGE} names of ${BACKUP_SCAN_NAME_BYTES} bytes, ${runBytes} copied bytes, each key's name sent twice, the marks and the report's reads` },
    { id: "upstash-storage", microUsd: marks, basis: `${MARK_KEYS} marks of at most ${MARK_BYTES} bytes kept` },
    { id: "vercel", microUsd: vercel, basis: `${runs} calls of ${routeSeconds} s at ${VERCEL_FUNCTION_GB} GB, CPU the whole time` },
  ];
  const sum = used.reduce((n, line) => n + line.microUsd, 0);
  const allowance = up((sum * PROVIDER_CHARGES_BPS) / 10_000);
  const lines = [...used, { id: "provider-allowance", microUsd: allowance, basis: `${PROVIDER_CHARGES_BPS / 100}% on every supplier charge` }];
  return { lines, knownMicroUsd: sum + allowance, unknowns: BACKUP_COST_UNKNOWNS };
}
