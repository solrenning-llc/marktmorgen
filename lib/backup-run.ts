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
 * no run happens. Nothing schedules it: vercel.json is untouched (owner
 * prerequisite 6 of docs/backup.md), and no route calls it.
 */
import { BACKUP_MAX_BYTES } from "@/lib/backup-export";
import type { BackupBucket, BackupListedObject, BackupObjectStore } from "@/lib/backup-roundtrip";
import { MAX_PARTS, copyInParts, manifestBound, openManifest, runStoredBound } from "@/lib/backup-parts";
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
export const BACKUP_RUN_CUTOFF_MS = 800_000;
/** The lock's life, in ms: past the admission's two requests (5 s each at most) and the cutoff, with room to spare. */
export const BACKUP_LOCK_MS = 900_000;
/**
 * The shortest retention a review may set: at 3 days, the report says no good copy has been verified for 48 hours
 * (backupStale) before the last one ages out of the retention.
 */
export const BACKUP_MIN_RETENTION_DAYS = 3;
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

export type BackupRunResult =
  | { ok: true; id: string; keys: number; bytes: number; parts: number; pruned: number; prune: "done" | "prune_error" | "prune_pages" | "prune_cutoff" }
  | {
      ok: false;
      reason:
        | "off_review" | "off_store" | "off_key" | "busy" | "already_ran" | "mark_error"
        | "room_error" | "room_pages" | "room_cutoff" | "room_unverified"
        | "export_limits" | "export_budget" | "export_cutoff" | "export_scan_pages" | "export_too_many" | "export_too_big" | "export_too_many_parts" | "export_unreadable" | "export_error"
        | "verify";
    };

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
  /** The run's cutoff, in ms from when it starts listing; BACKUP_RUN_CUTOFF_MS unless a test shortens it. */
  cutoffMs?: number;
};

function defaultStore(): BackupBucket | null {
  const config = backupStoreConfig();
  return config ? r2BackupStore(config) : null;
}

/** The last good copy as kept: its time and its manifest's id; a bare time (older format) names no manifest. */
function readLastOk(raw: unknown): { at: number; set: string | null } | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "number") return Number.isFinite(parsed) ? { at: parsed, set: null } : null;
    if (!parsed || typeof parsed !== "object") return null;
    const { at, set } = parsed as { at?: unknown; set?: unknown };
    return typeof at === "number" && Number.isFinite(at) ? { at, set: typeof set === "string" ? set : null } : null;
  } catch {
    return null;
  }
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
  const result: BackupRunResult = await withCutoff(cutoff, async () => {
    const room = await makeRoom(review, store, key);
    lost = room.lost;
    if (!room.ok) return { ok: false, reason: room.reason };
    const copied = await copy(review, store, key, now);
    // A failed day deletes nothing after it (Codex G on e95705e66): the last good copy stays, past the retention if
    // need be, until a new one is verified.
    if (!copied.ok) return copied;
    // After a verified write, as best it can: a failure is reported and never costs the copy just made. The copy just
    // made is the last verified one now, and it is younger than the retention.
    const pruned = await prune(review, store, now);
    return { ...copied, pruned: room.deleted + pruned.deleted, prune: pruned.state };
  });
  try {
    await redisPipeline(
      result.ok
        ? [
            // Kept for good: it names the copy never deleted to make room, which may outlive any expiry while new copies
            // fail; its absence is then a loss, never "no copy yet" (lastVerified).
            ["SET", LAST_OK, JSON.stringify({ at: now, set: result.id })],
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
class LostLastGood extends Error {}

/**
 * The ids of the last verified copy: its manifest and every part it names, all of them listed. Fails closed (Codex G
 * on e95705e66): a database answer that is not exactly one, a mark that is not text or not the kept shape, an old mark
 * with a time and no manifest, no mark at all, a manifest the bucket does not list, or one it cannot read and open,
 * all throw Unverified, and makeRoom then deletes nothing. No mark with copies in the bucket is not taken as "never a
 * good copy": the mark is kept for good once written, so its absence is a loss, and the run never deletes to make
 * room without knowing what to keep; copies left that way go by the bucket's lifecycle rule.
 */
async function lastVerified(store: BackupBucket, key: Uint8Array, listed: BackupListedObject[]): Promise<Set<string>> {
  const replies: unknown = await redisPipeline([["GET", LAST_OK]]);
  if (!Array.isArray(replies) || replies.length !== 1 || typeof replies[0] !== "string") throw new Unverified();
  const set = readLastOk(replies[0])?.set;
  if (!set || !ID.test(set)) throw new Unverified();
  // Gone from the bucket (Reviewer 1 on e81007570): said as such; makeRoom then keeps every verified set still there.
  if (!listed.some((o) => o.id === set)) throw new LostLastGood();
  let manifest: ReturnType<typeof openManifest>;
  try {
    manifest = openManifest(await store.read(set, manifestBound(MAX_PARTS)), key);
  } catch {
    throw new Unverified();
  }
  return new Set([set, ...manifest.parts.map((part) => part.id)]);
}

/**
 * Every verified set still in the bucket, when the last good copy is lost: each listed object small enough to be a
 * manifest is read and opened, and every manifest that opens is kept with every part it names. An object that cannot
 * be read throws Unverified (nothing deleted on doubt); one that reads but does not open as a manifest is not one.
 * Reads at most backupKeptObjects objects (Class B, priced in lib/backup-cost.ts).
 */
async function verifiedInBucket(store: BackupBucket, key: Uint8Array, listed: BackupListedObject[]): Promise<Set<string>> {
  const keep = new Set<string>();
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
    } catch {
      // Not a manifest that opens with this key: a part, or a failed run's leftover.
    }
  }
  return keep;
}

/**
 * Before the write (step 1): room for one more set at its bound under the review's ceiling, in bytes and in objects,
 * made by deleting the oldest copies first and never the last verified one; or a reason, and nothing written. When
 * the last good copy is lost (the bucket's rule took it), room is made from objects of no verified set only, every
 * verified set still there is kept, and `lost` says so for the owner's report.
 */
async function makeRoom(
  review: BackupCostReview,
  store: BackupBucket,
  key: Uint8Array,
): Promise<{ ok: true; deleted: number; lost: boolean } | { ok: false; reason: "room_error" | "room_pages" | "room_cutoff" | "room_unverified"; lost: boolean }> {
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
    try {
      keep = await lastVerified(store, key, listed);
    } catch (error) {
      if (!(error instanceof LostLastGood)) throw error;
      lost = true;
      keep = await verifiedInBucket(store, key, listed);
    }
    const oldest = listed.filter((o) => !keep.has(o.id)).sort((a, b) => a.writtenAt - b.writtenAt || (a.id < b.id ? -1 : 1));
    let deleted = 0;
    for (const object of oldest) {
      if (fits()) break;
      if (timeLeft() <= 0) return { ok: false, reason: "room_cutoff", lost };
      await store.delete(object.id);
      bytes -= object.bytes;
      count -= 1;
      deleted += 1;
    }
    return fits() ? { ok: true, deleted, lost } : { ok: false, reason: "room_error", lost };
  } catch (error) {
    if (error instanceof Unverified) return { ok: false, reason: "room_unverified", lost };
    return { ok: false, reason: timeLeft() <= 0 ? "room_cutoff" : "room_error", lost };
  }
}

/**
 * After the write (step 2), as best it can: deletes every object of the backup's own written more than retentionDays
 * days before `now`. Deletes are one by one (DeleteObject, free on R2).
 */
async function prune(review: BackupCostReview, store: BackupBucket, now: number): Promise<{ deleted: number; state: "done" | "prune_error" | "prune_pages" | "prune_cutoff" }> {
  const line = now - review.retentionDays * DAY_MS;
  let deleted = 0;
  try {
    const listed = await listAll(review, store);
    for (const object of listed ?? []) {
      if (object.writtenAt >= line) continue;
      if (timeLeft() <= 0) return { deleted, state: "prune_cutoff" };
      await store.delete(object.id);
      deleted += 1;
    }
    return { deleted, state: listed ? "done" : "prune_pages" };
  } catch {
    return { deleted, state: timeLeft() <= 0 ? "prune_cutoff" : "prune_error" };
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
