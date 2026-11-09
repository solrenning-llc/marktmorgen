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
 * SCANs of BACKUP_STORES_SCAN_COUNT keys and one GET a store, each store's
 * record (at most MAX_STORE_BYTES) read once a day. The walk goes over the
 * whole keyspace, so the pages a day grow with every key of every store, not
 * only with the stores: the Worker reads at most its BACKUP_FILES_INDEX_PAGES
 * pages a day and alarms past them (stores_unavailable), which bounds the
 * walk at about 800,000 keys until an index of the stores replaces the SCAN. A SCAN can name a key twice; the page names each
 * folder once, and the Worker reads a store named on two pages once, at the
 * larger R.
 */
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { BACKUP_FILES_PAGE_ENTRIES, type BackupStoreRoom, type BackupStoresPage, parseStoresPage } from "@/lib/backup-files-contract";
import { COMMUNITY_PICTURES, PICTURE_BYTES } from "@/lib/community-picture-rules";
import { type Tier, parseTier } from "@/lib/plan";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, scanPage } from "@/lib/redis-reply";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { STORE_ID_PATTERN, storeFolder } from "@/lib/store";

/** Keys one SCAN step looks at (a hint to Redis, which may answer a few more); one command whatever it finds. */
export const BACKUP_STORES_SCAN_COUNT = 200;
/** SCAN steps one page takes at the most: 8,000 keys of the keyspace a call. */
export const BACKUP_STORES_SCANS_PER_PAGE = 40;
/**
 * Once a page has found this many stores it stops scanning. Each is one GET of a record of at most MAX_STORE_BYTES
 * (lib/store.ts), so a page reads at most this plus one step's finds of them, in rounds of GET_BATCH.
 */
export const BACKUP_STORES_FOUND_PER_PAGE = 50;
/** Records read in one round: at most 10 MB a reply. */
const GET_BATCH = 10;

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

/** One page of the stores to copy, from `cursor` (null: the start of the walk). Throws on anything that does not read exactly. */
export async function backupStoresPage(cursor: string | null, options: { now?: () => number; stopAt: number }): Promise<BackupStoresPage> {
  const now = options.now ?? Date.now;
  let scan = cursor ?? "0";
  const keys = new Set<string>();
  let steps = 0;
  let stoppedByTime = false;
  do {
    if (now() >= options.stopAt) {
      stoppedByTime = true;
      break;
    }
    const page = scanPage(await redisPipeline([["SCAN", scan, "MATCH", "nl:store:owner:*", "COUNT", BACKUP_STORES_SCAN_COUNT]]));
    if (!page) throw new UnknownReplyError("a SCAN of the stores");
    for (const key of page.items) if (OWNER_KEY.test(key)) keys.add(key);
    scan = page.next;
    steps += 1;
  } while (scan !== "0" && steps < BACKUP_STORES_SCANS_PER_PAGE && keys.size < BACKUP_STORES_FOUND_PER_PAGE);
  if (keys.size > BACKUP_FILES_PAGE_ENTRIES) throw new UnknownReplyError("a SCAN that names more stores than a page holds");

  const rooms = new Map<string, number>();
  const list = [...keys];
  if (list.length) {
    const replies: unknown[] = [];
    for (let at = 0; at < list.length; at += GET_BATCH) {
      const batch = list.slice(at, at + GET_BATCH);
      const read = repliesFor(await redisPipeline(batch.map((key) => ["GET", key])), batch.length);
      if (!read) throw new UnknownReplyError("the store records");
      replies.push(...read);
    }
    for (const reply of replies) {
      // Gone between the SCAN and the GET: a store deleted, not one to copy.
      if (reply === null) continue;
      if (typeof reply !== "string") throw new UnknownReplyError("a store record");
      const room = await roomOf(reply);
      rooms.set(room.store, Math.max(rooms.get(room.store) ?? 0, room.roomBytes));
    }
  }
  const stores = [...rooms].map(([store, roomBytes]) => ({ store, roomBytes }));
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
