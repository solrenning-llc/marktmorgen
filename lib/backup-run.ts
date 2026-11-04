/**
 * 273 [BK1]: one daily backup run. Export every key of ours under the caps of
 * a reviewed cost ceiling (lib/backup-export.ts), seal it (lib/backup-codec.ts),
 * write it once to the backup's own bucket and read it back the same
 * (lib/backup-roundtrip.ts, lib/backup-store.ts), then keep the time of the
 * last good copy and the last failure's reason for the report.
 *
 * Off three ways, each checked before a single command is sent:
 *   - no reviewed cost ceiling: BACKUP_COST_REVIEW is null until the owner's
 *     review of what a run costs is recorded with its date and source, with
 *     the bucket's retention (a lifecycle rule the owner sets on the bucket,
 *     which this code cannot see) and a storage ceiling the kept copies cannot
 *     pass. Unknown cost is never zero.
 *   - no backup bucket settings (backupStoreConfig()).
 *   - no 32-byte BACKUP_ENCRYPTION_KEY.
 * At most one run a day (UTC), so at most one stored object a day, failed
 * read-backs included. Nothing schedules it: vercel.json is untouched (owner
 * prerequisite 6 of docs/backup.md), and no route calls it.
 */
import { BACKUP_MAX_BYTES, BACKUP_MAX_ROWS, exportSnapshot } from "@/lib/backup-export";
import { verifyBackupRoundtrip, type BackupObjectStore } from "@/lib/backup-roundtrip";
import { backupStoreConfig, r2BackupStore } from "@/lib/backup-store";
import { redisPipeline } from "@/lib/redis";

/** The reviewed ceiling: one run's caps, the bucket's retention and storage ceiling, and when and from what it was reviewed. */
export type BackupCostReview = {
  maxRows: number;
  /** Every database command one run may send, its own marks included. */
  maxCommands: number;
  maxBytes: number;
  /** Days the bucket keeps a copy before its lifecycle rule deletes it. */
  retentionDays: number;
  /** The most the kept copies may weigh in all. */
  maxStoredBytes: number;
  /** YYYY-MM-DD. */
  reviewedAt: string;
  source: string;
};

/** No review yet: the run stays off. */
export const BACKUP_COST_REVIEW: BackupCostReview | null = null;

/** Keys copied per request. */
const BATCH = 100;
/** Commands a run sends besides the export: the day mark and one outcome. */
const RUN_COMMANDS = 2;
/** What a stored object may weigh beyond the export's cap: the sealed header and the compressor's worst growth. */
const SEAL_ROOM = 65_536;
const OUTCOME_SECONDS = 8 * 86_400;
const STALE_MS = 48 * 3_600_000;
const LAST_OK = "nl:backup:last-ok";
const LAST_FAIL = "nl:backup:last-fail";

/** The UTC day of a moment. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const whole = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const objectBound = (review: BackupCostReview) => Math.min(review.maxBytes, BACKUP_MAX_BYTES) + SEAL_ROOM;

/** True only for a review with every cap a count, a real date, a source, a retention, and a storage ceiling above every copy kept at once. */
export function validReview(review: BackupCostReview | null | undefined): review is BackupCostReview {
  if (!review) return false;
  const { maxRows, maxCommands, maxBytes, retentionDays, maxStoredBytes, reviewedAt, source } = review;
  if (![maxRows, maxCommands, maxBytes, retentionDays, maxStoredBytes].every(whole)) return false;
  if (maxCommands <= RUN_COMMANDS + 1) return false;
  const day = typeof reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) ? Date.parse(`${reviewedAt}T00:00:00Z`) : NaN;
  if (!Number.isFinite(day) || dayOf(day) !== reviewedAt) return false;
  if (typeof source !== "string" || source.trim().length < 10) return false;
  // One object a day, kept retentionDays, plus the day being written.
  return (retentionDays + 1) * objectBound(review) <= maxStoredBytes;
}

export type BackupRunResult =
  | { ok: true; id: string; keys: number; bytes: number }
  | {
      ok: false;
      reason:
        | "off_review" | "off_store" | "off_key" | "already_ran" | "mark_error"
        | "export_limits" | "export_budget" | "export_too_many" | "export_too_big" | "export_unreadable" | "export_error"
        | "verify";
    };

/** The encryption key from BACKUP_ENCRYPTION_KEY (base64 of exactly 32 bytes), or none. */
export function backupKey(): Uint8Array | null {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? new Uint8Array(key) : null;
}


export type BackupRunOptions = { now?: number; review?: BackupCostReview | null; store?: BackupObjectStore | null; key?: Uint8Array | null };

function defaultStore(): BackupObjectStore | null {
  const config = backupStoreConfig();
  return config ? r2BackupStore(config) : null;
}

/** One run: off unless all three are there; otherwise a verified copy, or a failure that says which step. Never throws. */
export async function runBackup(options: BackupRunOptions = {}): Promise<BackupRunResult> {
  const now = options.now ?? Date.now();
  const review = "review" in options ? options.review : BACKUP_COST_REVIEW;
  if (!validReview(review)) return { ok: false, reason: "off_review" };
  const store = "store" in options ? options.store : defaultStore();
  if (!store) return { ok: false, reason: "off_store" };
  const key = "key" in options ? options.key : backupKey();
  if (!key || key.length !== 32) return { ok: false, reason: "off_key" };

  try {
    const [marked] = await redisPipeline([["SET", `nl:backup:ran:${dayOf(now)}`, "1", "NX", "EX", 2 * 86_400]]);
    if (marked !== "OK") return { ok: false, reason: "already_ran" };
  } catch {
    return { ok: false, reason: "mark_error" };
  }

  const result = await copy(review, store, key, now);
  try {
    await redisPipeline([
      result.ok
        ? ["SET", LAST_OK, String(now), "EX", OUTCOME_SECONDS]
        : ["SET", LAST_FAIL, JSON.stringify({ at: now, reason: result.reason }), "EX", OUTCOME_SECONDS],
    ]);
  } catch {
    // The copy stands as it is; a lost note only makes the report look older.
  }
  return result;
}

async function copy(review: BackupCostReview, store: BackupObjectStore, key: Uint8Array, now: number): Promise<BackupRunResult> {
  let exported: Awaited<ReturnType<typeof exportSnapshot>>;
  try {
    exported = await exportSnapshot({
      maxRows: Math.min(review.maxRows, BACKUP_MAX_ROWS),
      maxCommands: review.maxCommands - RUN_COMMANDS,
      batch: BATCH,
      maxBytes: Math.min(review.maxBytes, BACKUP_MAX_BYTES),
      now,
    });
  } catch {
    return { ok: false, reason: "export_error" };
  }
  if (!exported.ok) return { ok: false, reason: `export_${exported.reason}` };
  try {
    const done = await verifyBackupRoundtrip(exported.snapshot, key, store, objectBound(review));
    return { ok: true, id: done.id, keys: done.keys, bytes: done.bytes };
  } catch {
    // Sealing, the write or the read-back failed; every earlier copy is left as it was.
    return { ok: false, reason: "verify" };
  }
}

/** True when no copy has been verified in the last 48 hours (none kept counts as none). */
export async function backupStale(now: number = Date.now()): Promise<boolean> {
  const [last] = await redisPipeline([["GET", LAST_OK]]);
  const at = Number(last);
  return !(last && Number.isFinite(at) && now - at <= STALE_MS);
}

/** The latest failure kept, if any. */
export async function backupLastFailure(): Promise<{ at: number; reason: string } | null> {
  const [raw] = await redisPipeline([["GET", LAST_FAIL]]);
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { at: unknown; reason: unknown };
    return typeof parsed.at === "number" && typeof parsed.reason === "string" ? { at: parsed.at, reason: parsed.reason } : null;
  } catch {
    return null;
  }
}
