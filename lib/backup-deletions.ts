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
 * object's key, the time and the reason, nothing about the person.
 *
 * Never in the way of the deletion: a record that cannot be kept (the
 * database is down, a reply does not read exactly, the store's month ceiling
 * is reached) is logged as missed, with the count and never the key, and the
 * deletion goes on. The Worker then sees the file only as missing from its
 * listings and removes its copy as an orphan, after 90 days of complete
 * listings: the safe side for the data, and later than a record would.
 *
 * Off while the route is off (no route secret, or no review of its cost,
 * lib/backup-files-review.ts, null on main): no command, nothing kept. A file
 * deleted while it is off has no record; the orphan end covers it.
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
import { BACKUP_FILES_ROUTE_REVIEW } from "@/lib/backup-files-review";
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
/** The most one record weighs as kept: the contract's longest key (1,024) and its other fields. */
export const RECORD_BYTES_MOST = 1_200;

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

/** Whether records are kept: only while the backup files route itself could answer (its secret and its review). */
export function deletionRecordsOn(): boolean {
  return backupFilesRouteSecret() !== null && admitFilesReview(BACKUP_FILES_ROUTE_REVIEW) !== null;
}

const BLOB_HOST = /\.blob\.vercel-storage\.com$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The source and store folder of a key the backup copies, or null for one it does not (a picture, another folder). */
export function backedUpKey(pathOrUrl: string): { source: BackupFilesSource; key: string; folder: string } | null {
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
  if (key.length > 1024 || CONTROL.test(key)) return null;
  const m = /^(vault|stores)\/([0-9a-f]{32})\/./.exec(key);
  if (!m) return null;
  return { source: m[1] === "vault" ? "r2" : "blob", key, folder: m[2] };
}

export type RecordOutcome = { kept: number; missed: number };

/**
 * Keeps one record for each of these deleted files the backup copies, recorded `now`. Call it only once the
 * provider said they are gone. Never throws and never waits on anything but the database: a record not kept is
 * counted as missed and logged, never the key.
 */
export async function recordDeletions(pathnames: readonly string[], reason: BackupDeletionReason, now = Date.now()): Promise<RecordOutcome> {
  const outcome: RecordOutcome = { kept: 0, missed: 0 };
  if (!(BACKUP_DELETION_REASONS as readonly string[]).includes(reason)) return outcome;
  const byFolder = new Map<string, Map<string, BackupFilesSource>>();
  for (const path of pathnames) {
    const found = typeof path === "string" ? backedUpKey(path) : null;
    if (!found) continue;
    const keys = byFolder.get(found.folder) ?? new Map<string, BackupFilesSource>();
    keys.set(found.key, found.source);
    byFolder.set(found.folder, keys);
  }
  if (byFolder.size === 0 || !deletionRecordsOn()) return outcome;
  for (const [folder, keys] of byFolder) {
    const all = [...keys];
    for (let at = 0; at < all.length; at += RECORDS_PER_WRITE) {
      const part = all.slice(at, at + RECORDS_PER_WRITE);
      if ((await keepRecords(folder, part, reason, now)) === "kept") outcome.kept += part.length;
      else outcome.missed += part.length;
    }
  }
  if (outcome.missed) console.error("backup files: a deletion record was not kept", { missed: outcome.missed, kept: outcome.kept });
  return outcome;
}

async function keepRecords(folder: string, part: [string, BackupFilesSource][], reason: BackupDeletionReason, now: number): Promise<"kept" | "missed"> {
  if (!isRedisConfigured()) return "missed";
  try {
    const count = countKey(folder, now);
    // Counted before it is kept: past the store's month ceiling nothing is written (MR, a ceiling before the spend).
    const counted = repliesFor(await redisPipeline([["SET", count, "0", "NX", "EX", BACKUP_DELETION_COUNT_SECONDS], ["INCRBY", count, part.length]]), 2);
    const total = counted && (counted[0] === null || counted[0] === "OK") ? countOf(counted[1]) : null;
    if (total === null || total < part.length) return "missed";
    if (total > BACKUP_DELETION_RECORDS_PER_MONTH) return "missed";
    const list = dayList(Math.floor(now / DAY_MS));
    const items = part.map(([key, source]) => JSON.stringify({ source, key, recordedAt: now, reason }));
    const pushed = repliesFor(await redisPipeline([["RPUSH", list, ...items], ["EXPIRE", list, BACKUP_DELETION_RECORD_DAYS * 86_400]]), 2);
    const length = pushed ? countOf(pushed[0]) : null;
    return length !== null && length >= part.length && pushed?.[1] === 1 ? "kept" : "missed";
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
