/**
 * 273 [BK1], files part 3: the explicit deletion records the backup Worker
 * removes a file's copy by (docs/backup-costs-2026-11-08.md, 5.1 item 2), and
 * the page of the backup files route that hands them over
 * (app/api/backup/files/route.ts, `?page=deletions`).
 *
 * Written by lib/file-store.ts `deleteFile`, the one door every deletion of a
 * store's sold files, lesson files, hand-ins and stamped copies goes through,
 * only AFTER the provider said the file is gone: a record for a file still
 * there would remove the copy of a live file 30 days later. A record holds the
 * object's key, the time and the reason. The key is not about a person, but it
 * can point to one: a student's hand-in is kept under a one-way fingerprint of
 * their address (lib/learn.ts emailKey), and a sold file's key carries the
 * creator's original file name. Its only purpose is to delete the backup's
 * copy of a file deleted here, a privacy erasure's files included: the
 * database keeps it at most BACKUP_DELETION_RECORD_DAYS days after its day's
 * last write, and the backup bucket at most BACKUP_FILES_RECORD_FILE_DAYS
 * (workers/backup-files/src/run.ts); lib/person-data.ts says so to the
 * creator, and the privacy page must before its review is filled.
 *
 * Never in the way of the deletion: a record that cannot be kept (the
 * database is down, a reply does not read exactly, the store's month ceiling
 * is reached) is logged as missed, with the count and never the key, and the
 * deletion goes on. The Worker then sees the file only as missing from its
 * listings and removes its copy as an orphan, after 90 days of complete
 * listings: the safe side for the data, and later than a record would.
 *
 * Off while the route is off (no route secret, or no review of its cost,
 * lib/backup-files-review.ts, null on main), and off while the records have no
 * review of their own (BACKUP_DELETION_RECORDS_REVIEW, null on main): the
 * route on never turns on these writes, which a plan's worst month must price
 * first. Off, there is no command and nothing kept, and the deletions page
 * answers 503, never an empty page. A file deleted while it is off has no
 * record; the orphan end covers it.
 *
 *   nl:backup:del:<YYYY-MM-DD>              list   the day's records, oldest first, as JSON; each write sets
 *                                                  its expiry BACKUP_DELETION_RECORD_DAYS days on
 *   nl:backup:delcount:<folder>:<YYYY-MM>   count  one store's records in a UTC month, kept 35 days
 *
 * Cost, worst month per store (MR; the route stays off, so nothing is spent
 * today): at most BACKUP_DELETION_RECORDS_PER_MONTH records, each one RPUSH
 * entry of at most RECORD_BYTES_MOST bytes kept at most 15 days, with 4
 * commands a deleteFile call for each store it names (SET NX EX and INCRBY
 * to count, RPUSH and EXPIRE to keep) and 2 once the ceiling is reached; the
 * route reads each record once (one LRANGE a day). The calls past the
 * ceiling are bounded only by the deletions a store can make, which is the
 * open item of objects a store can write (section 5b), so the per-store line
 * stays unknown, never zero, until it is priced and the owner reviews it.
 *
 * Reading (rule 24): a day's list is read only while it is surely kept (at
 * least an hour before the earliest it could expire); a resume point older
 * than that is "expired" (a 409), never an empty page. An item that is not
 * exactly a record, or an LRANGE that is not a list, throws: the route
 * answers 503, never a page with a record left out.
 */
import { BACKUP_DELETION_REASONS, BACKUP_FILES_HELD_OBJECTS, BACKUP_FILES_PAGE_BYTES, BACKUP_FILES_PAGE_ENTRIES, type BackupDeletionPage, type BackupDeletionReason, type BackupFilesSource, parseDeletionPage } from "@/lib/backup-files-contract";
import { BACKUP_DELETION_RECORDS_REVIEW, BACKUP_FILES_ROUTE_REVIEW } from "@/lib/backup-files-review";
import { admitFilesReview, backupFilesRouteSecret } from "@/lib/backup-files-source";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

/** Days a day's list of records is kept after its last write: the Worker reads every day, and a resume point older is a 409. */
export const BACKUP_DELETION_RECORD_DAYS = 14;
/**
 * Records one store may have written in a UTC month: its two listed sources (R2 and Blob) emptied once, each at
 * the most a complete listing holds (BACKUP_FILES_HELD_OBJECTS). Past it a deletion is still done, with no record.
 */
export const BACKUP_DELETION_RECORDS_PER_MONTH = 2 * BACKUP_FILES_HELD_OBJECTS;
/** How long one store's month count is kept: longer than any month, so it is never read as zero within it. */
export const BACKUP_DELETION_COUNT_SECONDS = 35 * 86_400;
/** A day's list is read as finished this long after the day ends, so a record written at 23:59 is never passed over. */
export const BACKUP_DELETION_CLOSE_MS = 15 * 60_000;
/** The most one record weighs as kept: a key of at most KEY_BYTES_MOST and its other fields. A record that would weigh more is never written. */
export const RECORD_BYTES_MOST = 1_200;
/** The longest key recorded, in UTF-8 bytes (R2's own bound): a longer one has no record and goes as an orphan. */
const KEY_BYTES_MOST = 1024;

const DAY_MS = 86_400_000;
/** A day's list is read only while it has at least this long before it could expire. */
const KEPT_MARGIN_MS = 3_600_000;
/** Records written in one round, at the most. */
const RECORDS_PER_WRITE = 500;
/** Room in a page's 1 MB for its own fields and its cursor. */
const PAGE_HEAD_BYTES = 8_192;
/** Days one call reads at the most: every day still kept, so one call can go from the oldest to today. */
const DAYS_PER_PAGE = BACKUP_DELETION_RECORD_DAYS + 2;

const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const dayList = (day: number) => `nl:backup:del:${isoDay(day)}`;
const countKey = (folder: string, now: number) => `nl:backup:delcount:${folder}:${new Date(now).toISOString().slice(0, 7)}`;

/** The records' own review read from its own data fields (never a getter), or null: none, no record is kept. */
export function admitRecordsReview(raw: unknown): { reviewedAt: string; source: string } | null {
  if (!raw || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const read = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const reviewedAt = read("reviewedAt");
  const source = read("source");
  if (typeof reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) || typeof source !== "string" || source.trim().length < 3) return null;
  return { reviewedAt, source };
}

/** Whether records are kept: only while the backup files route itself could answer (its secret and its review) and the records have their own review. */
export function deletionRecordsOn(): boolean {
  return backupFilesRouteSecret() !== null && admitFilesReview(BACKUP_FILES_ROUTE_REVIEW) !== null && admitRecordsReview(BACKUP_DELETION_RECORDS_REVIEW) !== null;
}

const BLOB_HOST = /\.blob\.vercel-storage\.com$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

type Backed = { source: BackupFilesSource; key: string; folder: string };

/** A key the backup copies, "too_long" for one it copies but whose record would pass KEY_BYTES_MOST, or null for one it does not. */
function backedUp(pathOrUrl: string): Backed | "too_long" | null {
  let key = pathOrUrl;
  if (/^https:\/\//.test(pathOrUrl)) {
    // Blob's del takes an address too: what the listing names is its pathname.
    try {
      const url = new URL(pathOrUrl);
      if (!BLOB_HOST.test(url.hostname)) return null;
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return null;
    }
  }
  if (CONTROL.test(key)) return null;
  const m = /^(vault|stores)\/([0-9a-f]{32})\/./.exec(key);
  if (!m) return null;
  // Bounded in UTF-8 bytes, as kept, never in characters: 1,024 characters can weigh 3 KB.
  if (Buffer.byteLength(key, "utf8") > KEY_BYTES_MOST) return "too_long";
  return { source: m[1] === "vault" ? "r2" : "blob", key, folder: m[2] };
}

/** The source and store folder of a key the backup copies and can record, or null for one it does not (a picture, another folder, a key past KEY_BYTES_MOST). */
export function backedUpKey(pathOrUrl: string): Backed | null {
  const found = backedUp(pathOrUrl);
  return found === "too_long" ? null : found;
}

export type RecordOutcome = { kept: number; missed: number };

/**
 * Keeps one record for each of these deleted files the backup copies, recorded `now`. Call it only once the
 * provider said they are gone. Never throws and never waits on anything but the database: a record not kept is
 * counted as missed and logged, never the key.
 */
export async function recordDeletions(pathnames: readonly string[], reason: BackupDeletionReason, now = Date.now()): Promise<RecordOutcome> {
  const outcome: RecordOutcome = { kept: 0, missed: 0 };
  // Off: no command, nothing kept, nothing missed.
  if (!deletionRecordsOn()) return outcome;
  if (!(BACKUP_DELETION_REASONS as readonly string[]).includes(reason)) {
    console.error("backup files: a deletion record was not kept, its reason is not the contract's", { missed: pathnames.length });
    return { kept: 0, missed: pathnames.length };
  }
  const found: Backed[] = [];
  let tooLong = 0;
  for (const path of pathnames) {
    const one = typeof path === "string" ? backedUp(path) : null;
    // A key the backup copies but longer than a record may hold has no record: it is missed, and goes as an orphan.
    if (one === "too_long") tooLong += 1;
    else if (one) found.push(one);
  }
  outcome.missed += tooLong;
  const byFolder = new Map<string, Map<string, string>>();
  for (const { folder, key, source } of found) {
    const item = JSON.stringify({ source, key, recordedAt: now, reason });
    // Never past RECORD_BYTES_MOST, whatever the key's escapes: such a record is not written, and is counted as missed.
    if (Buffer.byteLength(item, "utf8") > RECORD_BYTES_MOST) {
      outcome.missed += 1;
      continue;
    }
    const items = byFolder.get(folder) ?? new Map<string, string>();
    items.set(key, item);
    byFolder.set(folder, items);
  }
  for (const [folder, items] of byFolder) {
    const all = [...items.values()];
    for (let at = 0; at < all.length; at += RECORDS_PER_WRITE) {
      const part = all.slice(at, at + RECORDS_PER_WRITE);
      if ((await keepRecords(folder, part, now)) === "kept") outcome.kept += part.length;
      else outcome.missed += part.length;
    }
  }
  if (outcome.missed) console.error("backup files: a deletion record was not kept", { missed: outcome.missed, kept: outcome.kept });
  return outcome;
}

async function keepRecords(folder: string, items: string[], now: number): Promise<"kept" | "missed"> {
  if (!isRedisConfigured()) return "missed";
  try {
    const count = countKey(folder, now);
    // Counted before it is kept: past the store's month ceiling nothing is written (MR, a ceiling before the spend).
    const counted = repliesFor(await redisPipeline([["SET", count, "0", "NX", "EX", BACKUP_DELETION_COUNT_SECONDS], ["INCRBY", count, items.length]]), 2);
    const total = counted && (counted[0] === null || counted[0] === "OK") ? countOf(counted[1]) : null;
    if (total === null || total < items.length) return "missed";
    if (total > BACKUP_DELETION_RECORDS_PER_MONTH) return "missed";
    const list = dayList(Math.floor(now / DAY_MS));
    const pushed = repliesFor(await redisPipeline([["RPUSH", list, ...items], ["EXPIRE", list, BACKUP_DELETION_RECORD_DAYS * 86_400]]), 2);
    const length = pushed ? countOf(pushed[0]) : null;
    return length !== null && length >= items.length && pushed?.[1] === 1 ? "kept" : "missed";
  } catch {
    return "missed";
  }
}

// --------------------------------------------------------------------- page

type Cursor = { d: number; i: number };

/** The first day whose list is surely still kept at `now`: written lists live at least until their day's start plus the kept days. */
export function firstKeptDay(now: number): number {
  return Math.floor((now + KEPT_MARGIN_MS - BACKUP_DELETION_RECORD_DAYS * DAY_MS) / DAY_MS) + 1;
}

export function encodeDeletionsCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ v: 1, k: "del", d: cursor.d, i: cursor.i }), "utf8").toString("base64url");
}

/** A cursor this page made, or null. A day still to come is not one. */
export function decodeDeletionsCursor(text: string, now: number): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, k, d, i, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || v !== 1 || k !== "del") return null;
  if (typeof d !== "number" || !Number.isSafeInteger(d) || d < 0 || d > Math.floor(now / DAY_MS)) return null;
  if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 0 || i > 100_000_000) return null;
  return { d, i };
}

/** Whether a resume point is older than the records still surely kept: answered 409, never as an empty page. */
export const deletionsCursorExpired = (cursor: Cursor, now: number) => cursor.d < firstKeptDay(now);

/**
 * One page of deletion records from `cursor` (null: the oldest day still kept), at most 1,000 and 1 MB, one
 * LRANGE a day, from that day to the last one finished or today. Throws on anything that does not read exactly.
 */
export async function deletionsPage(cursor: Cursor | null, options: { now?: () => number; stopAt: number }): Promise<BackupDeletionPage> {
  const now = options.now ?? Date.now;
  let at: Cursor = cursor ?? { d: firstKeptDay(now()), i: 0 };
  const records: unknown[] = [];
  let bytes = PAGE_HEAD_BYTES;
  const answer = (reason: BackupDeletionPage["reason"]) =>
    parseDeletionPage({ version: 1, kind: "deletions", records, cursor: encodeDeletionsCursor(at), complete: reason === "done", reason });
  for (let n = 0; n < DAYS_PER_PAGE; n++) {
    if (now() >= options.stopAt) return answer("cutoff");
    const room = BACKUP_FILES_PAGE_ENTRIES - records.length;
    const replies = repliesFor(await redisPipeline([["LRANGE", dayList(at.d), at.i, at.i + room - 1]]), 1);
    const items = replies ? stringList(replies[0]) : null;
    if (!items || items.length > room) throw new UnknownReplyError("a day's deletion records");
    let taken = 0;
    for (const item of items) {
      const weight = Buffer.byteLength(item, "utf8") + 1;
      if (bytes + weight > BACKUP_FILES_PAGE_BYTES) break;
      let record: unknown;
      try {
        record = JSON.parse(item);
      } catch {
        throw new UnknownReplyError("a deletion record");
      }
      records.push(record);
      bytes += weight;
      taken += 1;
    }
    at = { d: at.d, i: at.i + taken };
    if (taken < items.length || records.length >= BACKUP_FILES_PAGE_ENTRIES) return answer("more");
    // This day's list is read to its end. Go on to the next only once no record can still be written to it.
    if (now() < (at.d + 1) * DAY_MS + BACKUP_DELETION_CLOSE_MS) return answer("done");
    at = { d: at.d + 1, i: 0 };
  }
  return answer("more");
}
