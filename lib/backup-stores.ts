/**
 * 273 [BK1], files part 3: the stores page of the backup files route
 * (app/api/backup/files/route.ts, `?page=stores`): every store, by the folder
 * its files are kept in, with R, the room of its plan in bytes, from which the
 * Worker takes its per-store ceilings (5R held, 4R copied in 32 days;
 * docs/backup-costs-2026-11-08.md, 5b).
 *
 * R is read from the plan code the way the store's data room is
 * (lib/store-data-rules.ts dataRoomFor): by the tier on the store's record,
 * "creator" when the record has none, as every allowance reads it. It is the
 * paid tier's figure whatever the store's standing (a trial, an unpaid
 * renewal or an ended plan never holds more than its tier's paid room, and a
 * store keeps what it holds after its plan ends): plan storage
 * (PAID_STORAGE_BYTES), its students' room (TASK_ROOM_BYTES) and its
 * community pictures (COMMUNITY_PICTURES at PICTURE_BYTES each). Never a
 * smaller R: a tier the code does not know, a record that is not a store's, or
 * a reply that does not read exactly fails the page (rule 24), and the Worker
 * alarms and copies nothing that day rather than copy with a wrong ceiling.
 *
 * The only way to walk every store is a SCAN of the keyspace for
 * nl:store:owner:* (lib/store.ts storesAfter), so a page is a few SCAN steps
 * and one GET for each store found: at most BACKUP_STORES_SCANS_PER_PAGE
 * SCANs of BACKUP_STORES_SCAN_COUNT keys and at most
 * BACKUP_STORES_READS_PER_PAGE GETs, each store's record (at most
 * MAX_STORE_BYTES) read once a day; its worst page is priced by
 * backupStoresPageWorstMicroUsd and counted against the review's own
 * maxStoresPagesPerDay, never the listings' figure. The walk goes over the
 * whole keyspace, so the pages a day grow with every key of every store, not
 * only with the stores: the Worker reads at most its BACKUP_FILES_INDEX_PAGES
 * pages a day and alarms past them (stores_unavailable), which bounds the
 * walk at about 800,000 keys until an index of the stores replaces the SCAN. A SCAN can name a key twice; the page names each
 * folder once, and the Worker reads a store named on two pages once, at the
 * larger R.
 */
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { type BackupStoreRoom, type BackupStoresPage, parseStoresPage } from "@/lib/backup-files-contract";
import { COMMUNITY_PICTURES, PICTURE_BYTES } from "@/lib/community-picture-rules";
import { type Tier, parseTier } from "@/lib/plan";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, scanPage } from "@/lib/redis-reply";
import { UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS } from "@/lib/spend-cost-table";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { MAX_STORE_BYTES, STORE_ID_PATTERN, storeFolder } from "@/lib/store";

/** Keys one SCAN step looks at (a hint to Redis, which may answer a few more); one command whatever it finds. */
export const BACKUP_STORES_SCAN_COUNT = 200;
/** SCAN steps one page takes at the most: 8,000 keys of the keyspace a call. */
export const BACKUP_STORES_SCANS_PER_PAGE = 40;
/**
 * Once a page has found this many stores it stops scanning. Each is one GET of a record of at most MAX_STORE_BYTES
 * (lib/store.ts), so a page reads at most this plus one step's finds of them, in rounds of GET_BATCH.
 */
export const BACKUP_STORES_FOUND_PER_PAGE = 50;
/** Records read in one round: at most 10 MB a reply, and all a page holds at once. */
const GET_BATCH = 10;
/**
 * The most records one page reads: the scan stops once BACKUP_STORES_FOUND_PER_PAGE are found, and its last step
 * may add one step's COUNT more. A SCAN that names more (COUNT is a hint) fails the page rather than read past it.
 */
export const BACKUP_STORES_READS_PER_PAGE = BACKUP_STORES_FOUND_PER_PAGE + BACKUP_STORES_SCAN_COUNT;
/** Database commands of the worst stores page: every SCAN step and one GET for each record it may read. */
export const BACKUP_STORES_PAGE_COMMANDS = BACKUP_STORES_SCANS_PER_PAGE + BACKUP_STORES_READS_PER_PAGE;
/** Bytes the worst stores page reads: each record at MAX_STORE_BYTES, the most a store record may weigh. */
export const BACKUP_STORES_PAGE_BYTES = BACKUP_STORES_READS_PER_PAGE * MAX_STORE_BYTES;

/**
 * What the worst stores page costs, in micro-dollars, rounded up: its commands and its bytes at Upstash's paid
 * prices (lib/spend-cost-table.ts), never a free quota. A company cost of the backup: the review's
 * maxStoresPagesPerDay pages a day at most (lib/backup-files-review.ts), so at most 31 times that a month.
 */
export function backupStoresPageWorstMicroUsd(): number {
  return Math.ceil((BACKUP_STORES_PAGE_COMMANDS * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6 + (BACKUP_STORES_PAGE_BYTES * UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e9);
}

/** R for a store of this tier, in bytes: what its plan lets it keep in the folders the backup copies, and its community's pictures. */
export function backupRoomBytes(tier: Tier): number {
  return PAID_STORAGE_BYTES[tier] + TASK_ROOM_BYTES[tier] + COMMUNITY_PICTURES[tier] * PICTURE_BYTES;
}

const OWNER_KEY = /^nl:store:owner:[0-9a-f]{40}$/;

export function encodeStoresCursor(scan: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: "stores", c: scan }), "utf8").toString("base64url");
}

/** The SCAN cursor a stores cursor carries, or null for anything this page did not make. */
export function decodeStoresCursor(text: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, k, c, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || v !== 1 || k !== "stores" || typeof c !== "string" || !/^(0|[1-9][0-9]{0,30})$/.test(c)) return null;
  return c;
}

/** One store record, read exactly as the site reads the folder its files go to (storeFolder(storeRef(store))). */
async function roomOf(raw: string): Promise<BackupStoreRoom> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a store record");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnknownReplyError("a store record");
  const record = value as Record<string, unknown>;
  // lib/store.ts parseStore: a record without its handle, name or address is not a store the site can read.
  if (typeof record.email !== "string" || !record.email || typeof record.handle !== "string" || !record.handle || typeof record.name !== "string" || !record.name) {
    throw new UnknownReplyError("a store record");
  }
  const tier = record.tier === undefined ? "creator" : parseTier(record.tier);
  if (tier === null) throw new UnknownReplyError("a store's plan");
  const sid = typeof record.sid === "string" && STORE_ID_PATTERN.test(record.sid) ? record.sid : "";
  const ref = record.extra === true && sid !== "" ? `#${sid}` : record.email;
  return { store: await storeFolder(ref), roomBytes: backupRoomBytes(tier) };
}

/**
 * One page of the stores to copy, from `cursor` (null: the start of the walk). Throws on anything that does not
 * read exactly, and on a SCAN that names more records than a page reads (BACKUP_STORES_READS_PER_PAGE).
 *
 * The records are read in rounds of GET_BATCH and each round is read as it arrives, so a page holds at most one
 * round's replies (10 MB) at once. Past `stopAt` between rounds, the page answers the stores read so far,
 * "cutoff", with a cursor back at the SCAN step whose records were not all read: the next call reads that step
 * again (SCAN's cursor is where the walk was, not what it found), so no store is lost, and one named twice is
 * read once by the Worker, at the larger R.
 */
export async function backupStoresPage(cursor: string | null, options: { now?: () => number; stopAt: number }): Promise<BackupStoresPage> {
  const now = options.now ?? Date.now;
  let scan = cursor ?? "0";
  const seen = new Set<string>();
  const steps: { from: string; keys: string[] }[] = [];
  let found = 0;
  let stoppedByTime = false;
  do {
    if (now() >= options.stopAt) {
      stoppedByTime = true;
      break;
    }
    const page = scanPage(await redisPipeline([["SCAN", scan, "MATCH", "nl:store:owner:*", "COUNT", BACKUP_STORES_SCAN_COUNT]]));
    if (!page) throw new UnknownReplyError("a SCAN of the stores");
    const keys = page.items.filter((key) => OWNER_KEY.test(key) && !seen.has(key));
    for (const key of keys) seen.add(key);
    found += keys.length;
    // Never more records than the page is priced at: a step that names more fails the page, before any is read.
    if (found > BACKUP_STORES_READS_PER_PAGE) throw new UnknownReplyError("a SCAN that names more stores than a page reads");
    steps.push({ from: scan, keys });
    scan = page.next;
  } while (scan !== "0" && steps.length < BACKUP_STORES_SCANS_PER_PAGE && found < BACKUP_STORES_FOUND_PER_PAGE);

  const rooms = new Map<string, number>();
  let resumeAt: string | null = null;
  reading: for (const step of steps) {
    for (let at = 0; at < step.keys.length; at += GET_BATCH) {
      if (now() >= options.stopAt) {
        resumeAt = step.from;
        break reading;
      }
      const batch = step.keys.slice(at, at + GET_BATCH);
      const replies = repliesFor(await redisPipeline(batch.map((key) => ["GET", key])), batch.length);
      if (!replies) throw new UnknownReplyError("the store records");
      for (const reply of replies) {
        // Gone between the SCAN and the GET: a store deleted, not one to copy.
        if (reply === null) continue;
        if (typeof reply !== "string") throw new UnknownReplyError("a store record");
        const room = await roomOf(reply);
        rooms.set(room.store, Math.max(rooms.get(room.store) ?? 0, room.roomBytes));
      }
    }
  }
  const stores = [...rooms].map(([store, roomBytes]) => ({ store, roomBytes }));
  if (resumeAt !== null) {
    return parseStoresPage({ version: 1, kind: "stores", stores, cursor: encodeStoresCursor(resumeAt), complete: false, reason: "cutoff" });
  }
  const done = scan === "0" && !stoppedByTime;
  return parseStoresPage({
    version: 1,
    kind: "stores",
    stores,
    cursor: done ? null : encodeStoresCursor(scan),
    complete: done,
    reason: done ? "done" : stoppedByTime ? "cutoff" : "more",
  });
}
