/**
 * 273 [BK1]: one daily backup run. Copy every key of ours under the caps of
 * a reviewed cost ceiling as a set of sealed parts and a sealed manifest
 * (lib/backup-parts.ts, inbox C4-30), each written once to the backup's own
 * bucket and read back the same (lib/backup-store.ts), then keep the time of
 * the last good copy (and its manifest) and the last failure's reason for the
 * report.
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
 * One run at a time: a lock (lib/redis-lock.ts: SET NX EX holding the run's
 * own random token) taken before anything else, held longer than a run can
 * write (BACKUP_LOCK_MS > the admission's own requests + BACKUP_RUN_CUTOFF_MS),
 * and let go only if it still holds that token (a compare-and-delete script),
 * so a run never lets go of a lock another run took after its own ran out. A
 * call that finds it is refused as "busy", noted as the last failure (two
 * commands), without touching the day's count. At most BACKUP_RUNS_PER_DAY runs
 * a UTC day (inbox C4-49): the day's count is taken next, and a run that ends
 * well raises it past the limit, so a second run that day is a new try after
 * a failure; a call past them is refused at six commands (the lock, the
 * count, and the lock let go: the script and the two commands it runs).
 *
 * Retention by the run itself (inbox C4-49, C4-53): write first, delete after.
 *   1. Before it writes, the run lists every object of its own (complete, or
 *      it writes nothing: "room_pages"). If they and one more set at its bound
 *      would pass the review's maxStoredBytes, or backupKeptObjects objects, it
 *      deletes the oldest first, never the last verified copy (the manifest
 *      kept with the last good copy's time, and the parts it names), until
 *      the set fits; if that deletion fails, it writes nothing ("room_error",
 *      "room_cutoff"; the day's new try may try again). It deletes only when it
 *      knows the last verified copy for sure (lastVerified): otherwise nothing
 *      is deleted and nothing written ("room_unverified").
 *   2. Then it writes the set and, only when the set was verified, deletes
 *      every copy of its own the bucket says was written more than
 *      retentionDays days before the run started, as best it can: a failure
 *      ("prune_error", "prune_pages", "prune_cutoff") is in the owner's report
 *      and never costs the day's copy; the next run's step 1 holds the ceiling
 *      meanwhile. A failed day deletes nothing after it, so the last good copy
 *      stays, past the retention if need be, until a new one is verified.
 * The ceiling is a proof: no other run writes while one holds the lock (its
 * writes end by its cutoff, before the lock expires, and R2 lists what was
 * written), and a run writes only after its own complete listing showed room
 * for its whole set, so the bucket never holds more than maxStoredBytes nor
 * more than backupKeptObjects objects. validReview asks maxStoredBytes for
 * retention + 2 sets (backupPeakSets): with one good run a day, the copies of
 * the last retentionDays days and the one that is about to age out are there
 * before the day's write, so step 1 deletes nothing inside the retention; it
 * acts only after failed runs or failed deletions. The last good copy kept
 * past the retention stays inside the ceiling: it is one set, and step 1 can
 * always make room for one more beside it by deleting the others (2 sets <=
 * retention + 2, the retention being at least 3), so keeping it never stops
 * a write while the deletions work. Names under backups/ this
 * code does not write are never listed as its own nor deleted; the bucket's
 * lifecycle rule, kept as a safety net, removes them and anything left while
 * no run happens.
 *
 * The bucket lock (inbox C4-35): neither step ever asks the bucket to delete an
 * object younger than BACKUP_BUCKET_LOCK_DAYS and an hour (the owner's lock on
 * backups/, proposed at 7 days); step 1 that cannot make room without one
 * writes nothing ("room_locked"), and a delete the bucket refuses as locked
 * (409, BackupObjectLockedError) is "room_locked" or "prune_locked".
 *
 * A database emptied or corrupted (inbox C4-36 item 1): before the prune, the
 * copy just verified is compared with the last good set's keys and bytes (the
 * base kept with the last good copy's mark). When either fell more than
 * BACKUP_SHRINK_LIMIT_PERCENT, nothing is deleted ("prune_shrunk") and the base
 * stays the earlier, larger set, so the next days hold the prune too. With no
 * mark at all, the copy is compared the same way with the largest verified
 * set the bucket holds (its manifest's rows and sizes; Claude 6's N1): fallen
 * further (the marks went with a wiped database), nothing is deleted
 * ("prune_shrunk") and that set becomes the base, so the hold ends once the
 * database is back to its size; a bucket read that fails deletes nothing and
 * writes no mark. A mark without a base deletes nothing either
 * ("prune_unverified") and no base is written. Accepting a
 * smaller database as the new base is not built: it is the owner's decision.
 * While the prune is held, the mark keeps the moment the hold began
 * (heldSince), and step 1 makes room only from objects written since then (the
 * held copies, the newest too), never from an older, good set; when those
 * cannot make room it writes nothing ("room_shrunk"). The newest held copy is
 * one of those, so on a rotation day step 1 may delete it before the day's
 * copy is verified; if that copy then fails, only the pre-shrink sets remain
 * until a held copy is verified again (a trade-off of the retention + 2 sets
 * ceiling, Claude 6's N2, recorded in docs/backup.md for the owner). A mark
 * that could not be read is left as it is, never rewritten without its base;
 * a first copy with no mark is the base when no other set in the bucket opens
 * as a verified one (a failed try's leftover is no copy) or none is more than
 * the limit larger.
 *
 * Called by app/api/cron/backup/route.ts, scheduled in vercel.json twice a
 * day (the day's run and its new try); off while BACKUP_COST_REVIEW is null,
 * before any command is sent.
 */
import { BACKUP_MAX_BYTES } from "@/lib/backup-export";
import { BackupObjectLockedError, type BackupBucket, type BackupListedObject, type BackupObjectStore } from "@/lib/backup-roundtrip";
import { MAX_PARTS, copyInParts, isManifestEnvelope, manifestBound, openManifest, runStoredBound } from "@/lib/backup-parts";
import { BACKUP_LIST_PAGE_KEYS, backupStoreConfig, r2BackupStore } from "@/lib/backup-store";
import { timeLeft, withCutoff } from "@/lib/fetch-timeout";
import { redisPipeline } from "@/lib/redis";
import { LockBusyError, releaseLock, takeLock, type Held } from "@/lib/redis-lock";

/** The reviewed ceiling: one run's caps, the retention and storage ceiling, and when and from what it was reviewed. */
export type BackupCostReview = {
  maxRows: number;
  /** Every database command one run may send, its own marks included. */
  maxCommands: number;
  maxBytes: number;
  /** Days a copy is kept: after it writes, the run deletes every copy older than this. */
  retentionDays: number;
  /** The most the kept copies may weigh in all: the run writes only when its whole set fits under it. */
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
 * Commands a run sends besides the walk and the copy: the lock (SET NX EX), the day's count (SET NX with its expiry,
 * INCRBY), the last good copy read when room must be made (GET), one outcome (the last good copy, the count raised
 * past the day's limit, a failed deletion's note; or the failure), and the lock let go only if it is its own (EVAL,
 * and the GET and DEL inside it, which Upstash bills one by one; where scripts do not run, the same GET and DEL).
 */
export const BACKUP_RUN_COMMANDS = 10;
/**
 * The most a run's listing, deletions and copy may last, in ms (independent review of #2175): every request inside is
 * given up by then and none is sent after it (lib/fetch-timeout.ts, withCutoff), and the walk, each part and the
 * manifest are refused once it has passed. The outcome is written after it, outside it.
 */
export const BACKUP_RUN_CUTOFF_MS = 700_000;
/**
 * Days the owner's bucket lock on backups/ keeps an object from deletion (proposal, inbox C4-35; the owner sets the
 * lock on the bucket). The run never asks to delete an object younger than this and LOCK_CLOCK_ROOM_MS.
 */
export const BACKUP_BUCKET_LOCK_DAYS = 7;
/** Room for the bucket's clock against the run's: an object counts as locked for an hour past the lock. */
const LOCK_CLOCK_ROOM_MS = 3_600_000;
/** How far, in percent, a copy's keys or bytes may fall below the last good set's before the prune is held (inbox C4-36). */
export const BACKUP_SHRINK_LIMIT_PERCENT = 20;
/** The lock's life, in ms: past the admission's two requests (5 s each at most) and the cutoff, with room to spare. */
export const BACKUP_LOCK_MS = 900_000;
/**
 * The shortest retention a review may set: the bucket lock's days and two (review of 9 November 2026: Claude 2's
 * MEDIUM, Claude 6's LOW 1), so the prune never meets an object the lock still holds and the bucket never outgrows its
 * retention + 2 sets; at 3 days or more, the report also says no good copy has been verified for 48 hours
 * (backupStale) before the last one ages out of the retention.
 */
export const BACKUP_MIN_RETENTION_DAYS = BACKUP_BUCKET_LOCK_DAYS + 2;
/** Keys copied per request. */
const BATCH = 100;
const DAY_MS = 86_400_000;
const STALE_MS = 48 * 3_600_000;
const LAST_OK = "nl:backup:last-ok";
const LAST_FAIL = "nl:backup:last-fail";
const LOCK = "nl:backup:lock";
/** The owner's report when the last good copy was found gone from the bucket. */
const LOST_NOTE = "last good copy lost";
/**
 * Days the bucket's lifecycle rule must keep an object beyond the retention (Reviewer 1 on e81007570): the run keeps
 * the last good copy past the retention while new ones fail, and a rule as short as the retention would take it. The
 * rule is the owner's, on the bucket; the stored ceiling is the code's, so a longer rule costs nothing more.
 */
export const BACKUP_LIFECYCLE_EXTRA_DAYS = 30;
/** The bucket's lifecycle rule to set: the retention and BACKUP_LIFECYCLE_EXTRA_DAYS. */
export const backupLifecycleDays = (review: Pick<BackupCostReview, "retentionDays">) => review.retentionDays + BACKUP_LIFECYCLE_EXTRA_DAYS;
/** A copy's id, as the store names it: a random UUID. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The last failure's life: 8 days, or the retention and two days when longer. The last good copy's mark has no end. */
const outcomeSeconds = (review: BackupCostReview) => Math.max(8, review.retentionDays + 2) * 86_400;

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

/** Sets of a run's stored bound the review's ceiling must hold (inbox C4-53): the retention and two more. */
export const backupPeakSets = (retentionDays: number) => retentionDays + 2;
/** The most objects the bucket holds: retention + 2 sets of a run's objects (its parts and its manifest). */
export const backupKeptObjects = (review: BackupCostReview) => backupPeakSets(review.retentionDays) * (runLimits(review).maxParts + 1);
/** Listing pages one listing may read: every object the bucket can hold, 1,000 a page (S3's limit). */
export const backupListPages = (review: BackupCostReview) => Math.max(1, Math.ceil(backupKeptObjects(review) / BACKUP_LIST_PAGE_KEYS));

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
  // Room for retention + 2 sets at their stored bound (backupPeakSets): the run writes only below the ceiling.
  const kept = backupPeakSets(retentionDays) * objectBound(review);
  return Number.isSafeInteger(kept) && kept <= maxStoredBytes ? review : null;
}

/** True only for a review admitReview admits; callers that go on to use it take admitReview's copy instead. */
export function validReview(review: unknown): review is BackupCostReview {
  return admitReview(review) !== null;
}

/** How the prune after a verified copy ended. */
export type BackupPruneState = "done" | "prune_error" | "prune_pages" | "prune_cutoff" | "prune_locked" | "prune_shrunk" | "prune_unverified";

export type BackupRunResult =
  | { ok: true; id: string; keys: number; bytes: number; parts: number; pruned: number; prune: BackupPruneState; note?: "last_good_copy_lost" }
  | {
      ok: false;
      reason:
        | "off_review" | "off_store" | "off_key" | "busy" | "already_ran" | "mark_error"
        | "room_error" | "room_pages" | "room_cutoff" | "room_unverified" | "room_locked" | "room_shrunk"
        | "export_limits" | "export_budget" | "export_cutoff" | "export_scan_pages" | "export_too_many" | "export_too_big" | "export_too_many_parts" | "export_unreadable" | "export_error"
        | "verify";
    };

/** 32 bytes from a setting's base64; null for anything else. */
function keyFrom(raw: string | undefined): Uint8Array | null {
  const text = raw?.trim();
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const key = Buffer.from(text, "base64");
  return key.length === 32 ? new Uint8Array(key) : null;
}

export function backupKey(): Uint8Array | null {
  return keyFrom(process.env.BACKUP_ENCRYPTION_KEY);
}

/** Days after a rotation that the previous key still opens copies (inbox C4-36 item 3): the retention's 30, twice. */
export const BACKUP_KEY_PREVIOUS_DAYS = 60;

/**
 * The keys a run uses (inbox C4-36 item 3): the current key (BACKUP_ENCRYPTION_KEY) writes and reads; after a
 * rotation, the previous one (BACKUP_ENCRYPTION_KEY_PREVIOUS) is also read, from the rotation day
 * (BACKUP_ENCRYPTION_KEY_ROTATED_AT, YYYY-MM-DD, UTC) for BACKUP_KEY_PREVIOUS_DAYS days, never before that day, never
 * after, never when malformed or the same key. Null without a current key.
 */
export function backupKeyring(now: number = Date.now()): { current: Uint8Array; readers: Uint8Array[] } | null {
  const current = backupKey();
  if (!current) return null;
  const previous = keyFrom(process.env.BACKUP_ENCRYPTION_KEY_PREVIOUS);
  const day = (process.env.BACKUP_ENCRYPTION_KEY_ROTATED_AT ?? "").trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  const real = Number.isFinite(from) && dayOf(from) === day;
  const open = real && now >= from && now <= from + BACKUP_KEY_PREVIOUS_DAYS * DAY_MS;
  const same = previous !== null && Buffer.from(previous).equals(Buffer.from(current));
  return { current, readers: previous && open && !same ? [current, previous] : [current] };
}



export type BackupRunOptions = {
  now?: number;
  review?: BackupCostReview | null;
  store?: BackupBucket | null;
  key?: Uint8Array | null;
  /** The run's cutoff, in ms from when it starts listing; BACKUP_RUN_CUTOFF_MS unless a test shortens it. */
  cutoffMs?: number;
  /** Keys besides `key` that copies may be opened with (never written with): the keyring's previous key by default. */
  previousKeys?: Uint8Array[];
};

function defaultStore(): BackupBucket | null {
  const config = backupStoreConfig();
  return config ? r2BackupStore(config) : null;
}

/** The keys and bytes of the last good set a new copy is compared with before the prune (inbox C4-36 item 1). */
type BackupBase = { keys: number; bytes: number };
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * The last good copy as kept: its time, its manifest's id, the base, and since when the prune is held (heldSince, the
 * moment of the first held run; absent when it is not). A bare time (older format) names no manifest, a mark without
 * both counts has no base, and a heldSince that is there but not a moment makes the whole mark unreadable (rule 24:
 * an unknown hold is never "not held").
 */
function readLastOk(raw: unknown): { at: number; set: string | null; base: BackupBase | null; heldSince: number | null } | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "number") return Number.isFinite(parsed) ? { at: parsed, set: null, base: null, heldSince: null } : null;
    if (!parsed || typeof parsed !== "object") return null;
    const { at, set, base, heldSince } = parsed as { at?: unknown; set?: unknown; base?: unknown; heldSince?: unknown };
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if ("heldSince" in parsed && !isCount(heldSince)) return null;
    const { keys, bytes } = (base && typeof base === "object" ? base : {}) as { keys?: unknown; bytes?: unknown };
    return { at, set: typeof set === "string" ? set : null, base: isCount(keys) && isCount(bytes) ? { keys, bytes } : null, heldSince: isCount(heldSince) ? heldSince : null };
  } catch {
    return null;
  }
}

/** What the outcome writes as the new copy's mark: its base and hold, or "keep" to leave the mark as it is. */
type MarkPlan = { base: BackupBase | null; heldSince: number | null } | "keep";

/** The last good copy's mark, read at most once a run (one GET, inside BACKUP_RUN_COMMANDS) by whichever step asks first. */
type MarkReader = () => Promise<unknown>;

/** One run: off unless all three are there; otherwise a verified copy, or a failure that says which step. Never throws. */
export async function runBackup(options: BackupRunOptions = {}): Promise<BackupRunResult> {
  const now = options.now ?? Date.now();
  const review = admitReview("review" in options ? options.review : BACKUP_COST_REVIEW);
  if (!review) return { ok: false, reason: "off_review" };
  const store = "store" in options ? options.store : defaultStore();
  if (!store) return { ok: false, reason: "off_store" };
  const key = "key" in options ? options.key : backupKey();
  if (!key || key.length !== 32) return { ok: false, reason: "off_key" };
  // Read with the current key first, then the previous one while it may still open copies (backupKeyring).
  const extra = "previousKeys" in options ? (options.previousKeys ?? []) : (backupKeyring(now)?.readers.slice(1) ?? []);
  const readers = [key, ...extra.filter((k) => k instanceof Uint8Array && k.length === 32)];

  const keep = outcomeSeconds(review);
  // One run at a time, before anything else (inbox C4-53): a call that finds a run going is refused, and noted so a
  // run that did not happen shows in the owner's report.
  let lock: Held;
  try {
    lock = await takeLock(LOCK, Math.ceil(BACKUP_LOCK_MS / 1_000), 0);
  } catch (error) {
    if (!(error instanceof LockBusyError)) return { ok: false, reason: "mark_error" };
    await redisPipeline([["SET", LAST_FAIL, JSON.stringify({ at: now, reason: "busy" }), "EX", keep]]).catch(() => undefined);
    return { ok: false, reason: "busy" };
  }
  // Only this run's own lock: one that ran out and was taken by another run is left alone.
  const letGo = () => releaseLock(lock);

  // The day's count: kept two days, so the count of a run marked before a midnight that writes after it is still
  // there for the day after.
  const day = `nl:backup:ran:${dayOf(now)}`;
  try {
    // Read in its exact shape only (CX-123 rule 24, Codex G's MEDIUM): two replies, the SET's "OK" or null, and
    // the INCRBY's own integer. Anything else (true, [1], "01", a missing reply) is unknown and lets no run start.
    const reply: unknown = await redisPipeline([["SET", day, "0", "NX", "EX", 2 * 86_400], ["INCRBY", day, 1]]);
    const runs = Array.isArray(reply) && reply.length === 2 && (reply[0] === null || reply[0] === "OK") ? reply[1] : undefined;
    if (typeof runs !== "number" || !Number.isSafeInteger(runs) || runs < 1) return (await letGo(), { ok: false, reason: "mark_error" });
    if (runs > BACKUP_RUNS_PER_DAY) return (await letGo(), { ok: false, reason: "already_ran" });
  } catch {
    await letGo();
    return { ok: false, reason: "mark_error" };
  }

  const cutoff = Date.now() + Math.min(options.cutoffMs ?? BACKUP_RUN_CUTOFF_MS, BACKUP_RUN_CUTOFF_MS);
  // Set when the last good copy was found lost while making room: the owner's report says so.
  let lost = false;
  // The base and hold the outcome keeps with the new copy's mark, or the mark left as it is: until the prune's check
  // says which, the mark is left as it is.
  let mark = "keep" as MarkPlan;
  let markReply: Promise<unknown> | null = null;
  const readMark: MarkReader = () => (markReply ??= redisPipeline([["GET", LAST_OK]]));
  const result: BackupRunResult = await withCutoff(cutoff, async () => {
    const room = await makeRoom(review, store, readers, now, readMark);
    lost = room.lost;
    if (!room.ok) return { ok: false, reason: room.reason };
    const copied = await copy(review, store, key, now);
    // A failed day deletes nothing after it (Codex G on e95705e66): the last good copy stays, past the retention if
    // need be, until a new one is verified.
    if (!copied.ok) return copied;
    // After a verified write, as best it can: a failure is reported and never costs the copy just made. The copy just
    // made is the last verified one now, and it is younger than the retention.
    const pruned = await prune(review, store, readers, now, copied, readMark);
    mark = pruned.mark;
    return { ...copied, pruned: room.deleted + pruned.deleted, prune: pruned.state, ...(lost ? { note: "last_good_copy_lost" as const } : {}) };
  });
  try {
    await redisPipeline(
      result.ok
        ? [
            // Kept for good: it names the copy never deleted to make room, which may outlive any expiry while new copies
            // fail; its absence is then a loss, never "no copy yet" (lastVerified).
            // With the base the next copy is compared with (inbox C4-36): the earlier one when this copy shrank, none
            // when it could not be known, and since when the prune is held. A mark that could not be read is left as
            // it is (Claude 6's MEDIUM 2): one unknown read never drops a known base.
            ...(mark === "keep"
              ? []
              : [["SET", LAST_OK, JSON.stringify({ at: now, set: result.id, ...(mark.base ? { base: mark.base } : {}), ...(mark.heldSince !== null ? { heldSince: mark.heldSince } : {}) })]]),
            // Done: no new try today; the count goes past the day's limit.
            ["INCRBY", day, BACKUP_RUNS_PER_DAY],
            ...(result.prune !== "done"
              ? [["SET", LAST_FAIL, JSON.stringify({ at: now, reason: result.prune, ...(lost ? { note: LOST_NOTE } : {}) }), "EX", keep]]
              : lost
                ? [["SET", LAST_FAIL, JSON.stringify({ at: now, reason: "last_good_copy_lost", note: LOST_NOTE }), "EX", keep]]
                : []),
          ]
        : [["SET", LAST_FAIL, JSON.stringify({ at: now, reason: result.reason, ...(lost ? { note: LOST_NOTE } : {}) }), "EX", keep]],
    );
  } catch {
    // The copy stands as it is; a lost note only makes the report look older.
  }
  await letGo();
  return result;
}

/** Every object of the backup's own, read whole within backupListPages pages; null when the listing is longer. */
async function listAll(review: BackupCostReview, store: BackupBucket): Promise<BackupListedObject[] | null> {
  const all: BackupListedObject[] = [];
  let next: string | null = null;
  for (let page = 0; page < backupListPages(review); page += 1) {
    if (timeLeft() <= 0) throw new RangeError("cutoff");
    const answer = await store.list(next);
    if (!answer || !Array.isArray(answer.objects) || (answer.next !== null && typeof answer.next !== "string")) throw new Error("Invalid listing");
    for (const object of answer.objects) {
      if (!object || typeof object.id !== "string" || !Number.isSafeInteger(object.writtenAt) || !Number.isSafeInteger(object.bytes) || object.bytes < 0) throw new Error("Invalid listing");
      all.push(object);
    }
    if (answer.next === null) return all;
    next = answer.next;
  }
  return null;
}

/** The ids of the last verified copy that are still in the bucket: its manifest and every part it names. */
/** The last verified copy could not be known for sure: nothing is deleted to make room. */
class Unverified extends Error {}
/** The mark names a copy the bucket no longer lists (its lifecycle rule took it): the last good copy is lost. */
class LostLastGood extends Error {
  constructor(readonly heldSince: number | null) {
    super("last good copy lost");
  }
}

/**
 * The ids of the last verified copy: its manifest and every part it names, all of them listed. Fails closed (Codex G
 * on e95705e66): a database answer that is not exactly one, a mark that is not text or not the kept shape, an old mark
 * with a time and no manifest, no mark at all, a manifest the bucket does not list, or one it cannot read and open,
 * all throw Unverified, and makeRoom then deletes nothing. No mark with copies in the bucket is not taken as "never a
 * good copy": the mark is kept for good once written, so its absence is a loss, and the run never deletes to make
 * room without knowing what to keep; copies left that way go by the bucket's lifecycle rule.
 */
async function lastVerified(store: BackupBucket, key: Uint8Array[], listed: BackupListedObject[], readMark: MarkReader): Promise<{ keep: Set<string>; heldSince: number | null }> {
  const replies: unknown = await readMark();
  if (!Array.isArray(replies) || replies.length !== 1 || typeof replies[0] !== "string") throw new Unverified();
  const mark = readLastOk(replies[0]);
  const set = mark?.set;
  if (!mark || !set || !ID.test(set)) throw new Unverified();
  // Held (a shrunk or blind database): makeRoom keeps every object written before the hold, whatever the mark names.
  if (mark.heldSince !== null) return { keep: new Set(), heldSince: mark.heldSince };
  // Gone from the bucket (Reviewer 1 on e81007570): said as such; makeRoom then keeps every verified set still there.
  if (!listed.some((o) => o.id === set)) throw new LostLastGood(mark.heldSince);
  let manifest: ReturnType<typeof openManifest>;
  try {
    manifest = openManifest(await store.read(set, manifestBound(MAX_PARTS)), key);
  } catch {
    throw new Unverified();
  }
  return { keep: new Set([set, ...manifest.parts.map((part) => part.id)]), heldSince: mark.heldSince };
}

/**
 * Every verified set still in the bucket, when the last good copy is lost: each listed object small enough to be a
 * manifest is read and opened with the keyring, and every manifest that opens is kept with every part it names. An
 * object that cannot be read throws Unverified (nothing deleted on doubt), and so does one that begins as a manifest
 * but does not open (under a key the keyring lacks, or damaged: inbox C4-36 item 3), since the parts it names cannot
 * be known; one that does not begin as a manifest is not one. Reads at most backupKeptObjects objects (Class B, priced
 * in lib/backup-cost.ts).
 */
async function verifiedInBucket(store: BackupBucket, key: Uint8Array[], listed: BackupListedObject[]): Promise<Set<string>> {
  return (await setsInBucket(store, key, listed)).keep;
}

/**
 * verifiedInBucket's reads, with each verified set's keys and bytes as its run counted them (the manifest's rows; its
 * parts' sizes and the manifest's own), so a copy with no mark can be compared with them (Claude 6's N1).
 */
async function setsInBucket(store: BackupBucket, key: Uint8Array[], listed: BackupListedObject[]): Promise<{ keep: Set<string>; sets: BackupBase[] }> {
  const keep = new Set<string>();
  const sets: BackupBase[] = [];
  for (const object of listed) {
    if (object.bytes > manifestBound(MAX_PARTS)) continue;
    if (timeLeft() <= 0) throw new RangeError("cutoff");
    let bytes: Uint8Array;
    try {
      bytes = await store.read(object.id, manifestBound(MAX_PARTS));
    } catch {
      throw new Unverified();
    }
    try {
      const manifest = openManifest(bytes, key);
      keep.add(object.id);
      for (const part of manifest.parts) keep.add(part.id);
      sets.push({ keys: manifest.rows, bytes: manifest.parts.reduce((n, part) => n + part.bytes, 0) + bytes.byteLength });
    } catch {
      if (isManifestEnvelope(bytes)) throw new Unverified();
      // Not a manifest at all: a part, or a failed run's leftover.
    }
  }
  return { keep, sets };
}

/**
 * Before the write (step 1): room for one more set at its bound under the review's ceiling, in bytes and in objects,
 * made by deleting the oldest copies first and never the last verified one; or a reason, and nothing written. When
 * the last good copy is lost (the bucket's rule took it), room is made from objects of no verified set only, every
 * verified set still there is kept, and `lost` says so for the owner's report. While the prune is held (the mark's
 * heldSince: a shrunk or blind database, review of 9 November 2026), room is made only from the copies written since
 * the hold began (the newest too, being one of them), never from a set written before it; when those cannot make room
 * (the bucket lock still holds them), nothing is written (room_shrunk).
 * Nothing is deleted unless the objects it may delete are known to make room (Claude 6's LOW 2).
 */
async function makeRoom(
  review: BackupCostReview,
  store: BackupBucket,
  key: Uint8Array[],
  now: number,
  readMark: MarkReader,
): Promise<{ ok: true; deleted: number; lost: boolean } | { ok: false; reason: "room_error" | "room_pages" | "room_cutoff" | "room_unverified" | "room_locked" | "room_shrunk"; lost: boolean }> {
  const need = objectBound(review);
  const objects = runLimits(review).maxParts + 1;
  const most = backupKeptObjects(review);
  let lost = false;
  try {
    const listed = await listAll(review, store);
    if (!listed) return { ok: false, reason: "room_pages", lost };
    let bytes = listed.reduce((n, o) => n + o.bytes, 0);
    let count = listed.length;
    const fits = () => bytes + need <= review.maxStoredBytes && count + objects <= most;
    if (fits()) return { ok: true, deleted: 0, lost };
    let keep: Set<string>;
    let heldSince: number | null;
    try {
      ({ keep, heldSince } = await lastVerified(store, key, listed, readMark));
    } catch (error) {
      if (!(error instanceof LostLastGood)) throw error;
      lost = true;
      heldSince = error.heldSince;
      keep = await verifiedInBucket(store, key, listed);
    }
    // While the prune is held, every object written before the hold began is kept (a good, pre-shrink set), and room
    // is made only from the held copies, oldest first, the newest one too: each is a copy of the shrunk or blind
    // database, and every set from before is kept whole.
    const oldest = listed
      .filter((o) => !keep.has(o.id) && (heldSince === null || o.writtenAt >= heldSince))
      .sort((a, b) => a.writtenAt - b.writtenAt || (a.id < b.id ? -1 : 1));
    // Never asked for inside the bucket lock (inbox C4-35): such an object is left, and counted as the reason.
    const line = lockLine(now);
    const free = oldest.filter((o) => o.writtenAt <= line);
    // Room counted before the first delete: when every free object gone would still leave no room, none is asked for.
    let freeBytes = bytes;
    let freeCount = count;
    for (const object of free) {
      if (freeBytes + need <= review.maxStoredBytes && freeCount + objects <= most) break;
      freeBytes -= object.bytes;
      freeCount -= 1;
    }
    const reason = heldSince !== null ? "room_shrunk" : free.length < oldest.length ? "room_locked" : "room_error";
    if (!(freeBytes + need <= review.maxStoredBytes && freeCount + objects <= most)) return { ok: false, reason, lost };
    let deleted = 0;
    for (const object of free) {
      if (fits()) break;
      if (timeLeft() <= 0) return { ok: false, reason: "room_cutoff", lost };
      try {
        await store.delete(object.id);
      } catch (error) {
        if (error instanceof BackupObjectLockedError) return { ok: false, reason: "room_locked", lost };
        throw error;
      }
      bytes -= object.bytes;
      count -= 1;
      deleted += 1;
    }
    if (fits()) return { ok: true, deleted, lost };
    return { ok: false, reason, lost };
  } catch (error) {
    if (error instanceof Unverified) return { ok: false, reason: "room_unverified", lost };
    return { ok: false, reason: timeLeft() <= 0 ? "room_cutoff" : "room_error", lost };
  }
}

/** The newest moment an object may have been written and be asked for deletion: past the bucket lock and its hour. */
const lockLine = (now: number) => now - BACKUP_BUCKET_LOCK_DAYS * DAY_MS - LOCK_CLOCK_ROOM_MS;

/** True when `now` fell more than BACKUP_SHRINK_LIMIT_PERCENT below `was`. */
const shrank = (now: number, was: number) => now * 100 < was * (100 - BACKUP_SHRINK_LIMIT_PERCENT);

/**
 * The check before the prune (inbox C4-36 item 1), from the last good copy's mark read exactly (one reply, a text or
 * nothing): "ok" with the new copy as the base and no hold; "shrunk", keeping the earlier base, when its keys or bytes
 * fell more than the limit; "unverified", with no base, when the mark cannot be read or has no base; both held since
 * the mark's heldSince, or since `now` when it starts here. "unknown" when the reply itself could not be read (a
 * failed or misshapen answer): nothing is known, so the mark is left as it is (Claude 6's MEDIUM 2). "none" when there
 * is no mark at all, which the listing decides.
 */
async function shrinkCheck(
  copied: { keys: number; bytes: number },
  now: number,
  readMark: MarkReader,
): Promise<{ state: "ok" | "shrunk" | "unverified" | "unknown" | "none"; base: BackupBase | null; heldSince: number | null }> {
  const fresh = { keys: copied.keys, bytes: copied.bytes };
  let replies: unknown;
  try {
    replies = await readMark();
  } catch {
    return { state: "unknown", base: null, heldSince: null };
  }
  if (!Array.isArray(replies) || replies.length !== 1 || (replies[0] !== null && typeof replies[0] !== "string")) return { state: "unknown", base: null, heldSince: null };
  if (replies[0] === null) return { state: "none", base: fresh, heldSince: null };
  const kept = readLastOk(replies[0]);
  const heldSince = kept?.heldSince ?? now;
  const was = kept?.base;
  if (!was) return { state: "unverified", base: null, heldSince };
  return shrank(fresh.keys, was.keys) || shrank(fresh.bytes, was.bytes) ? { state: "shrunk", base: was, heldSince } : { state: "ok", base: fresh, heldSince: null };
}

/**
 * After the write (step 2), as best it can: deletes every object of the backup's own written more than retentionDays
 * days before `now`, never one inside the bucket lock, and nothing when the new copy shrank or the last good set
 * cannot be known (shrinkCheck). Deletes are one by one (DeleteObject, free on R2). Also gives the mark the outcome
 * writes: the base and hold, or "keep" when the mark could not be read (or, with no mark, the listing or a read of the
 * bucket failed), so the next run decides again with nothing lost.
 */
async function prune(
  review: BackupCostReview,
  store: BackupBucket,
  key: Uint8Array[],
  now: number,
  copied: { id: string; keys: number; bytes: number; parts: number },
  readMark: MarkReader,
): Promise<{ deleted: number; state: BackupPruneState; mark: MarkPlan }> {
  const line = now - review.retentionDays * DAY_MS;
  const locked = lockLine(now);
  const check = await shrinkCheck(copied, now, readMark);
  if (check.state === "unknown") return { deleted: 0, state: "prune_unverified", mark: "keep" };
  if (check.state === "shrunk") return { deleted: 0, state: "prune_shrunk", mark: { base: check.base, heldSince: check.heldSince } };
  if (check.state === "unverified") return { deleted: 0, state: "prune_unverified", mark: { base: null, heldSince: check.heldSince } };
  // A listing that fails leaves "none" undecided: the mark is not written, so the next run decides again.
  let mark: MarkPlan = check.state === "none" ? "keep" : { base: check.base, heldSince: null };
  let deleted = 0;
  try {
    const listed = await listAll(review, store);
    if (!listed) return { deleted, state: "prune_pages", mark };
    if (check.state === "none") {
      // No mark: the copy is compared with the largest verified set the bucket holds, its keys and its bytes each
      // (Claude 6's N1, 9 November 2026), by the same 20% rule as against a mark's base. Fallen further (the marks
      // went with a wiped database): the prune is held from now on, with that largest set as the base, so the hold
      // ends once the database is back to its size and never stays for good. Not fallen (a first day's failed try,
      // a prune or an outcome write that failed once): this copy is the base. A failed try's leftover (no set opens)
      // is no copy. A bucket read that fails throws Unverified: nothing deleted and the mark left unwritten, so the
      // next run decides again. These reads replace step 1's: with no mark it read none (lastVerified).
      if (listed.length > copied.parts + 1) {
        const { sets } = await setsInBucket(store, key, listed.filter((o) => o.id !== copied.id));
        if (sets.length > 0) {
          const largest = { keys: Math.max(...sets.map((set) => set.keys)), bytes: Math.max(...sets.map((set) => set.bytes)) };
          if (shrank(copied.keys, largest.keys) || shrank(copied.bytes, largest.bytes)) return { deleted, state: "prune_shrunk", mark: { base: largest, heldSince: now } };
        }
      }
      mark = { base: check.base, heldSince: null };
    }
    for (const object of listed) {
      if (object.writtenAt >= line || object.writtenAt > locked) continue;
      if (timeLeft() <= 0) return { deleted, state: "prune_cutoff", mark };
      try {
        await store.delete(object.id);
      } catch (error) {
        if (error instanceof BackupObjectLockedError) return { deleted, state: "prune_locked", mark };
        throw error;
      }
      deleted += 1;
    }
    return { deleted, state: "done", mark };
  } catch (error) {
    if (error instanceof Unverified) return { deleted, state: "prune_unverified", mark };
    return { deleted, state: timeLeft() <= 0 ? "prune_cutoff" : "prune_error", mark };
  }
}

async function copy(review: BackupCostReview, store: BackupObjectStore, key: Uint8Array, now: number): Promise<Exclude<BackupRunResult, { ok: true }> | { ok: true; id: string; keys: number; bytes: number; parts: number }> {
  // The copy in parts (lib/backup-parts.ts): every part verified as written, the set verified by its manifest last.
  let done: Awaited<ReturnType<typeof copyInParts>>;
  try {
    done = await copyInParts({ maxRows: review.maxRows, maxCommands: review.maxCommands - BACKUP_RUN_COMMANDS, ...runLimits(review), batch: BATCH, now }, key, store);
  } catch {
    return { ok: false, reason: "export_error" };
  }
  if (done.ok) return { ok: true, id: done.id, keys: done.keys, bytes: done.bytes, parts: done.parts };
  // Sealing, a write or a read-back failed: every earlier set is left as it was.
  if (done.reason === "verify") return { ok: false, reason: "verify" };
  return { ok: false, reason: `export_${done.reason}` };
}

/** True when no copy has been verified in the last 48 hours (none kept counts as none). */
export async function backupStale(now: number = Date.now()): Promise<boolean> {
  const [last] = await redisPipeline([["GET", LAST_OK]]);
  const kept = readLastOk(last);
  return !(kept && now - kept.at <= STALE_MS);
}

/** The latest failure kept, if any. */
export async function backupLastFailure(): Promise<{ at: number; reason: string; note?: string } | null> {
  const [raw] = await redisPipeline([["GET", LAST_FAIL]]);
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { at: unknown; reason: unknown; note?: unknown };
    if (typeof parsed.at !== "number" || typeof parsed.reason !== "string") return null;
    return typeof parsed.note === "string" ? { at: parsed.at, reason: parsed.reason, note: parsed.note } : { at: parsed.at, reason: parsed.reason };
  } catch {
    return null;
  }
}
