/**
 * 273 [BK1]: one daily backup run. Copy every key of ours under the caps of
 * a reviewed cost ceiling as a set of sealed parts and a sealed manifest
 * (lib/backup-parts.ts, inbox C4-30), each written once to the backup's own
 * bucket and read back the same (lib/backup-store.ts), then keep the time of
 * the last good copy and the last failure's reason for the report.
 *
 * Off three ways, each checked before a single command is sent:
 *   - no reviewed cost ceiling: BACKUP_COST_REVIEW is null until the owner's
 *     review of what a run costs is recorded with its date and source, with
 *     the retention and a storage ceiling the kept copies cannot pass. Unknown
 *     cost is never zero. The review is read once, from its own data fields
 *     (admitReview): a getter is never run, so it cannot pass with one figure
 *     and be priced or used with another (Codex G on #2175, inbox C4-49).
 *   - no backup bucket settings (backupStoreConfig()).
 *   - no 32-byte BACKUP_ENCRYPTION_KEY.
 *
 * At most BACKUP_RUNS_PER_DAY runs a UTC day (inbox C4-49): the day's count is
 * taken before anything costly, and a run that ends well raises it past the
 * limit, so a second run that day is a new try after a failure (or a call that
 * came while the first was running); every call after them is refused at the
 * count, two commands and nothing else.
 *
 * Retention by the run itself (inbox C4-49): R2's lifecycle rule removes what
 * expired "typically" within a day, not within a bound, and bills it until it
 * goes, so the run deletes, before it writes anything, every object of the
 * backup the bucket says was written more than retentionDays days before the
 * run started; a run whose deletion does not complete (an error, or a listing
 * longer than its pages, or its cutoff) writes nothing and says so
 * ("prune_error", "prune_pages", "prune_cutoff"), and the owner's report
 * shows it. The deletion and the copy run under BACKUP_RUN_CUTOFF_MS. Deleting first is what
 * makes the ceiling a proof: every object alive at any moment was written by
 * a run that started no earlier than retentionDays days and one run's length
 * before the start of the latest run whose deletion completed, so its runs
 * fall within retentionDays + 2 UTC days, at most BACKUP_RUNS_PER_DAY sets
 * each (backupPeakSets). The deletion removes only copies past the retention,
 * which the lifecycle rule would remove anyway, so no copy inside it is lost
 * by going first. Without a run, nothing new is written and the lifecycle
 * rule, kept as a safety net, removes the rest. Nothing schedules it:
 * vercel.json is untouched (owner prerequisite 6 of docs/backup.md), and no
 * route calls it.
 */
import { BACKUP_MAX_BYTES } from "@/lib/backup-export";
import type { BackupBucket, BackupListPage, BackupObjectStore } from "@/lib/backup-roundtrip";
import { MAX_PARTS, copyInParts, runStoredBound } from "@/lib/backup-parts";
import { BACKUP_LIST_PAGE_KEYS, backupStoreConfig, r2BackupStore } from "@/lib/backup-store";
import { timeLeft, withCutoff } from "@/lib/fetch-timeout";
import { redisPipeline } from "@/lib/redis";

/** The reviewed ceiling: one run's caps, the retention and storage ceiling, and when and from what it was reviewed. */
export type BackupCostReview = {
  maxRows: number;
  /** Every database command one run may send, its own marks included. */
  maxCommands: number;
  maxBytes: number;
  /** Days a copy is kept: the run deletes every copy older than this before it writes. */
  retentionDays: number;
  /** The most the kept copies may weigh in all. */
  maxStoredBytes: number;
  /**
   * The most parts one run writes (lib/backup-parts.ts), and the most it copies
   * as sealed JSON, every part together. Left out: one part of at most
   * maxBytes, as before the format in parts.
   */
  maxParts?: number;
  maxRunBytes?: number;
  /** YYYY-MM-DD. */
  reviewedAt: string;
  source: string;
};

/** No review yet: the run stays off. */
export const BACKUP_COST_REVIEW: BackupCostReview | null = null;

/** Runs a UTC day at the most: one, and one new try after a failure (inbox C4-49). */
export const BACKUP_RUNS_PER_DAY = 2;
/**
 * Commands a run sends besides the walk and the copy: the day's count (SET NX with its expiry, INCRBY) and one
 * outcome (the last good copy and the count raised past the day's limit, or the failure).
 */
export const BACKUP_RUN_COMMANDS = 4;
/**
 * The most a run's deletion and copy may last, in ms (independent review of #2175): every request inside is given up
 * by then and none is sent after it (lib/fetch-timeout.ts, withCutoff), and the walk, each part and the manifest are
 * refused once it has passed. Its writes therefore land within 800 s of its start, under a day, which the retention's
 * proof needs (backupPeakSets) whatever route or machine runs it. The outcome is written after it, outside it.
 */
export const BACKUP_RUN_CUTOFF_MS = 800_000;
/**
 * The shortest retention a review may set. The run deletes before it writes, so a retention of a day or two could
 * delete the last good copy after one or two failed days; at 3 days, the report says no good copy has been verified
 * for 48 hours (backupStale) before the last one can be deleted.
 */
export const BACKUP_MIN_RETENTION_DAYS = 3;
/** Keys copied per request. */
const BATCH = 100;
const DAY_MS = 86_400_000;
const OUTCOME_SECONDS = 8 * 86_400;
const STALE_MS = 48 * 3_600_000;
const LAST_OK = "nl:backup:last-ok";
const LAST_FAIL = "nl:backup:last-fail";

/** The UTC day of a moment. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const whole = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
/** One run's caps in parts: the review's, or one part of at most maxBytes when it names none. */
const runLimits = (review: BackupCostReview) => ({
  maxParts: review.maxParts ?? 1,
  maxRunBytes: review.maxRunBytes ?? Math.min(review.maxBytes, BACKUP_MAX_BYTES),
});
/** What one run's stored objects weigh at the most: every part sealed, and its manifest. */
const objectBound = (review: BackupCostReview) => runStoredBound(runLimits(review));

/**
 * The most sets the bucket holds at once under a retention (inbox C4-49), proved by the run's order: every object
 * alive was written by a run started within retentionDays days and one run's length (at most Vercel's longest function, 800 s, under a day) before the
 * start of the latest run whose deletion completed, a span that touches at most retentionDays + 2 UTC days, each with
 * at most BACKUP_RUNS_PER_DAY runs, each writing at most one set (a failed run's parts weigh no more than a set).
 * A run marked before a midnight that writes after it is counted on the day it was marked, so it is inside the span.
 */
export const backupPeakSets = (retentionDays: number) => BACKUP_RUNS_PER_DAY * (retentionDays + 2);
/** Listing pages one deletion may read: every object the bucket can hold at once, 1,000 a page (S3's limit). */
export const backupListPages = (review: BackupCostReview) =>
  Math.max(1, Math.ceil((backupPeakSets(review.retentionDays) * (runLimits(review).maxParts + 1)) / BACKUP_LIST_PAGE_KEYS));

const REVIEW_FIELDS = ["maxRows", "maxCommands", "maxBytes", "retentionDays", "maxStoredBytes", "maxParts", "maxRunBytes", "reviewedAt", "source"] as const;
const OPTIONAL_FIELDS = new Set<string>(["maxParts", "maxRunBytes"]);

/**
 * The review as data, read once: each field from the object's own data property, never through a getter, never
 * inherited; an object that is not a plain one, a field behind a getter, or anything that throws while it is read
 * (a revoked Proxy) gives null. Everything after works on this copy only.
 */
function snapshotReview(raw: unknown): BackupCostReview | null {
  try {
    if (raw === null || typeof raw !== "object") return null;
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    // No prototype: a field missing here is missing, never one found on Object.prototype.
    const copy: Record<string, unknown> = Object.create(null);
    for (const field of REVIEW_FIELDS) {
      const held = Object.getOwnPropertyDescriptor(raw, field);
      if (held === undefined) {
        if (OPTIONAL_FIELDS.has(field)) continue;
        return null;
      }
      if (!("value" in held)) return null;
      if (held.value === undefined && OPTIONAL_FIELDS.has(field)) continue;
      copy[field] = held.value;
    }
    return Object.freeze(copy) as BackupCostReview;
  } catch {
    return null;
  }
}

/**
 * The review the run and its cost model use: a copy of its data (snapshotReview), returned only when it has every
 * cap a count, a real date, a source, a retention of at least BACKUP_MIN_RETENTION_DAYS, and a storage ceiling above
 * every copy that can be kept at once.
 */
export function admitReview(raw: unknown): BackupCostReview | null {
  const review = snapshotReview(raw);
  if (!review) return null;
  const { maxRows, maxCommands, maxBytes, retentionDays, maxStoredBytes, reviewedAt, source } = review;
  if (![maxRows, maxCommands, maxBytes, retentionDays, maxStoredBytes].every(whole)) return null;
  if (retentionDays < BACKUP_MIN_RETENTION_DAYS) return null;
  const { maxParts, maxRunBytes } = runLimits(review);
  if (!whole(maxParts) || maxParts > MAX_PARTS || !whole(maxRunBytes)) return null;
  if (maxCommands <= BACKUP_RUN_COMMANDS + 1) return null;
  const day = typeof reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) ? Date.parse(`${reviewedAt}T00:00:00Z`) : NaN;
  if (!Number.isFinite(day) || dayOf(day) !== reviewedAt) return null;
  if (typeof source !== "string" || source.trim().length < 10) return null;
  // Every set the code lets the bucket hold at once (backupPeakSets), each at its stored bound.
  const kept = backupPeakSets(retentionDays) * objectBound(review);
  return Number.isSafeInteger(kept) && kept <= maxStoredBytes ? review : null;
}

/** True only for a review admitReview admits; callers that go on to use it take admitReview's copy instead. */
export function validReview(review: unknown): review is BackupCostReview {
  return admitReview(review) !== null;
}

export type BackupRunResult =
  | { ok: true; id: string; keys: number; bytes: number; parts: number; pruned: number }
  | {
      ok: false;
      reason:
        | "off_review" | "off_store" | "off_key" | "already_ran" | "mark_error"
        | "prune_error" | "prune_pages" | "prune_cutoff"
        | "export_limits" | "export_budget" | "export_cutoff" | "export_scan_pages" | "export_too_many" | "export_too_big" | "export_too_many_parts" | "export_unreadable" | "export_error"
        | "verify";
    };

/** The encryption key from BACKUP_ENCRYPTION_KEY (base64 of exactly 32 bytes), or none. */
export function backupKey(): Uint8Array | null {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? new Uint8Array(key) : null;
}


export type BackupRunOptions = {
  now?: number;
  review?: BackupCostReview | null;
  store?: BackupBucket | null;
  key?: Uint8Array | null;
  /** The run's cutoff, in ms from when it starts deleting; BACKUP_RUN_CUTOFF_MS unless a test shortens it. */
  cutoffMs?: number;
};

function defaultStore(): BackupBucket | null {
  const config = backupStoreConfig();
  return config ? r2BackupStore(config) : null;
}

/** One run: off unless all three are there; otherwise a verified copy, or a failure that says which step. Never throws. */
export async function runBackup(options: BackupRunOptions = {}): Promise<BackupRunResult> {
  const now = options.now ?? Date.now();
  const review = admitReview("review" in options ? options.review : BACKUP_COST_REVIEW);
  if (!review) return { ok: false, reason: "off_review" };
  const store = "store" in options ? options.store : defaultStore();
  if (!store) return { ok: false, reason: "off_store" };
  const key = "key" in options ? options.key : backupKey();
  if (!key || key.length !== 32) return { ok: false, reason: "off_key" };

  // The day's count, before anything costly: kept two days, so the count of a run marked before a midnight that
  // writes after it is still there for the day after.
  const day = `nl:backup:ran:${dayOf(now)}`;
  try {
    const [, count] = await redisPipeline([["SET", day, "0", "NX", "EX", 2 * 86_400], ["INCRBY", day, 1]]);
    const runs = Number(count);
    if (!Number.isSafeInteger(runs) || runs < 1) return { ok: false, reason: "mark_error" };
    if (runs > BACKUP_RUNS_PER_DAY) return { ok: false, reason: "already_ran" };
  } catch {
    return { ok: false, reason: "mark_error" };
  }

  const cutoff = Date.now() + Math.min(options.cutoffMs ?? BACKUP_RUN_CUTOFF_MS, BACKUP_RUN_CUTOFF_MS);
  const result: BackupRunResult = await withCutoff(cutoff, async () => {
    const pruned = await prune(review, store, now);
    return pruned.ok ? copy(review, store, key, now, pruned.deleted) : { ok: false, reason: pruned.reason };
  });
  try {
    await redisPipeline(
      result.ok
        // Done: no new try today; the count goes past the day's limit.
        ? [["SET", LAST_OK, String(now), "EX", OUTCOME_SECONDS], ["INCRBY", day, BACKUP_RUNS_PER_DAY]]
        : [["SET", LAST_FAIL, JSON.stringify({ at: now, reason: result.reason }), "EX", OUTCOME_SECONDS]],
    );
  } catch {
    // The copy stands as it is; a lost note only makes the report look older (and may let one new try run today).
  }
  return result;
}

/**
 * Deletes every object of the backup written more than retentionDays days before `now`, reading at most
 * backupListPages pages; complete, or a reason. Deletes are one by one (DeleteObject, free on R2); deleting while the
 * listing goes on is safe because a page goes on from the last name read, and a deleted name is behind it.
 */
async function prune(
  review: BackupCostReview,
  store: BackupBucket,
  now: number,
): Promise<{ ok: true; deleted: number } | { ok: false; reason: "prune_error" | "prune_pages" | "prune_cutoff" }> {
  const line = now - review.retentionDays * DAY_MS;
  const pages = backupListPages(review);
  let next: string | null = null;
  let deleted = 0;
  try {
    for (let page = 0; page < pages; page += 1) {
      if (timeLeft() <= 0) return { ok: false, reason: "prune_cutoff" };
      const answer: BackupListPage = await store.list(next);
      if (!answer || !Array.isArray(answer.objects) || (answer.next !== null && typeof answer.next !== "string")) return { ok: false, reason: "prune_error" };
      for (const object of answer.objects) {
        if (!object || typeof object.id !== "string" || !Number.isSafeInteger(object.writtenAt)) return { ok: false, reason: "prune_error" };
        // Older than the retention: written before the line (a run's late writes land at most 800 s after its start).
        if (object.writtenAt < line) {
          if (timeLeft() <= 0) return { ok: false, reason: "prune_cutoff" };
          await store.delete(object.id);
          deleted += 1;
        }
      }
      if (answer.next === null) return { ok: true, deleted };
      next = answer.next;
    }
    return { ok: false, reason: "prune_pages" };
  } catch {
    return { ok: false, reason: timeLeft() <= 0 ? "prune_cutoff" : "prune_error" };
  }
}

async function copy(review: BackupCostReview, store: BackupObjectStore, key: Uint8Array, now: number, pruned: number): Promise<BackupRunResult> {
  // The copy in parts (lib/backup-parts.ts): every part verified as written, the set verified by its manifest last.
  let done: Awaited<ReturnType<typeof copyInParts>>;
  try {
    done = await copyInParts({ maxRows: review.maxRows, maxCommands: review.maxCommands - BACKUP_RUN_COMMANDS, ...runLimits(review), batch: BATCH, now }, key, store);
  } catch {
    return { ok: false, reason: "export_error" };
  }
  if (done.ok) return { ok: true, id: done.id, keys: done.keys, bytes: done.bytes, parts: done.parts, pruned };
  // Sealing, a write or a read-back failed: every earlier set is left as it was.
  if (done.reason === "verify") return { ok: false, reason: "verify" };
  return { ok: false, reason: `export_${done.reason}` };
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
