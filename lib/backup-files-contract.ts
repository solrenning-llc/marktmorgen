/**
 * 273 [BK1], files part 1: the exact JSON the backup Worker reads from the
 * site's listing route (app/api/backup/files/route.ts), and the strict
 * parsers it reuses (docs/backup-costs-2026-11-08.md, section 5.1, C4-38).
 *
 * The Worker lives in a separate Cloudflare account that holds no production
 * credential: it calls the route with the route's own secret, gets a page of
 * a store's objects with a read URL for each that lasts minutes, and
 * downloads straight from the origin, so the bytes never pass through Vercel.
 *
 * A files page:
 *
 *   { version: 1, kind: "files", source, store, entries, cursor, complete, reason }
 *   entries: [{ source, key, etag, size, url, expiresAt }]   at most 1,000, 1 MB in all
 *
 * `complete` is true only when the provider said there is nothing after this
 * page (reason "done", no cursor). Otherwise the page is incomplete: "more"
 * (the provider has another page), "cutoff" (the route's time ran out),
 * "page_bytes" (the 1 MB cap), each with a cursor to go on from; or
 * "over_bound" (the store holds more than its pages can list, so its listing
 * can never complete, and no cursor). An incomplete page never holds a
 * deletion: deletion records come on their own page (kind "deletions"), from
 * the records the site keeps, never from what a listing misses.
 *
 * A stores page (kind "stores") names each store to copy with R, the room of
 * its plan in bytes (docs/backup-costs-2026-11-08.md, 5b: plan storage, the
 * students' room and the community pictures), from which the Worker takes
 * its per-store ceilings (5R held, 4R copied in 32 days). The route does not
 * answer it yet (503 "stores_unavailable"), so the Worker copies nothing.
 *
 * Rule 24: anything else (an extra or missing field, a wrong type, an entry
 * of another source or folder) throws BackupFilesContractError. Unknown is
 * never an empty or complete page.
 */

export const BACKUP_FILES_CONTRACT_VERSION = 1;

/** The sources a store's files are kept in: production R2 (lib/vault.ts), Vercel Blob (lib/blob.ts), Bunny Stream (lib/stream.ts). */
export const BACKUP_FILES_SOURCES = ["r2", "blob", "bunny"] as const;
export type BackupFilesSource = (typeof BACKUP_FILES_SOURCES)[number];

/** Entries a page holds at the most: the providers' own page (Blob `list`, R2 ListObjectsV2 max-keys). */
export const BACKUP_FILES_PAGE_ENTRIES = 1000;
/** Bytes a page's JSON may weigh at the most. */
export const BACKUP_FILES_PAGE_BYTES = 1_000_000;
/** Provider pages one complete listing of one source of one store may take (section 5b: 10 pages a day a source a store). */
export const BACKUP_FILES_PAGES_PER_STORE = 10;
/**
 * Objects one store may hold in one source and still be listed complete
 * (item 8): its pages times their entries. A store past it is answered
 * "over_bound", never complete, so the Worker alarms and applies no orphan end.
 */
export const BACKUP_FILES_HELD_OBJECTS = BACKUP_FILES_PAGES_PER_STORE * BACKUP_FILES_PAGE_ENTRIES;
/**
 * Objects the Worker may copy for one store in a month, all sources together:
 * the 10,000 its R2 operations are priced at (section 5b). The Worker's own
 * ceiling before each copy (past it the copy falls behind and alarms, nothing
 * is claimed copied); never more than one complete listing holds.
 */
export const BACKUP_FILES_OBJECTS_PER_MONTH = 10_000;
/** How long a signed read URL lasts: 15 minutes (R2 allows 1 s to 7 days, Blob at most 7 days). */
export const BACKUP_FILES_URL_SECONDS = 900;

export const BACKUP_FILES_REASONS = ["done", "more", "cutoff", "page_bytes", "over_bound"] as const;
export type BackupFilesReason = (typeof BACKUP_FILES_REASONS)[number];
export const BACKUP_DELETION_REASONS = ["creator_deleted", "store_closed", "privacy_request"] as const;
export type BackupDeletionReason = (typeof BACKUP_DELETION_REASONS)[number];

export type BackupFilesEntry = { source: BackupFilesSource; key: string; etag: string; size: number; url: string; expiresAt: number };
export type BackupFilesPage = {
  version: 1;
  kind: "files";
  source: BackupFilesSource;
  store: string;
  entries: BackupFilesEntry[];
  cursor: string | null;
  complete: boolean;
  reason: BackupFilesReason;
};
export type BackupDeletionRecord = { source: BackupFilesSource; key: string; recordedAt: number; reason: BackupDeletionReason };
export type BackupDeletionPage = {
  version: 1;
  kind: "deletions";
  records: BackupDeletionRecord[];
  cursor: string | null;
  complete: boolean;
  reason: "done" | "more" | "cutoff";
};

export type BackupStoreRoom = { store: string; roomBytes: number };
export type BackupStoresPage = {
  version: 1;
  kind: "stores";
  stores: BackupStoreRoom[];
  cursor: string | null;
  complete: boolean;
  reason: "done" | "more" | "cutoff";
};

export class BackupFilesContractError extends Error {
  constructor(message: string) {
    super(`backup files contract: ${message}`);
    this.name = "BackupFilesContractError";
  }
}

const STORE_PATTERN = /^[0-9a-f]{32}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/;
/** An ETag as the providers send it: printable, no spaces; R2's and Blob's come with or without quotes. */
const ETAG_PATTERN = /^[\x21-\x7e]{1,256}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The folder a store's objects are kept under in a source; null for one whose listing is not built (bunny). */
export function sourcePrefix(source: BackupFilesSource, store: string): string | null {
  if (source === "r2") return `vault/${store}/`;
  if (source === "blob") return `stores/${store}/`;
  return null;
}

const fail = (message: string): never => {
  throw new BackupFilesContractError(message);
};

function exactObject(raw: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) fail(`${what} is not an object`);
  const value = raw as Record<string, unknown>;
  const own = Object.keys(value);
  if (own.length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) fail(`${what} has fields ${own.join(",")}, not ${fields.join(",")}`);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) fail(`${what}.${field} is not a plain value`);
  }
  return value;
}

const wholeTime = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail(`${what} is not a positive whole time in ms`);

function keyOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || CONTROL.test(value)) fail(`${what} is not an object key`);
  return value as string;
}

function textOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fail("the answer is not JSON");
  }
}

function sizeCheck(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > BACKUP_FILES_PAGE_BYTES) fail("the page weighs more than 1 MB");
}

function pageEnd(value: Record<string, unknown>, reasons: readonly string[]): { cursor: string | null; complete: boolean; reason: string } {
  const { cursor, complete, reason } = value;
  if (typeof complete !== "boolean") fail("complete is not a boolean");
  if (typeof reason !== "string" || !reasons.includes(reason)) fail("reason is not one the contract knows");
  if (cursor !== null && (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor))) fail("cursor is neither null nor base64url");
  if (complete !== (reason === "done")) fail("complete is true exactly when the reason is done");
  if (reason === "done" || reason === "over_bound") {
    if (cursor !== null) fail(`a ${reason as string} page carries no cursor`);
  } else if (cursor === null) fail("an incomplete page needs a cursor to go on from");
  return { cursor: cursor as string | null, complete: complete as boolean, reason: reason as string };
}

const PAGE_FIELDS = ["version", "kind", "source", "store", "entries", "cursor", "complete", "reason"] as const;
const ENTRY_FIELDS = ["source", "key", "etag", "size", "url", "expiresAt"] as const;

/** A files page, exactly, from its JSON text or its parsed value; throws BackupFilesContractError on anything else. */
export function parseFilesPage(raw: unknown): BackupFilesPage {
  const parsed = textOf(raw);
  const value = exactObject(parsed, PAGE_FIELDS, "page");
  if (value.version !== BACKUP_FILES_CONTRACT_VERSION) fail("version is not 1");
  if (value.kind !== "files") fail("kind is not files");
  const source = value.source;
  if (typeof source !== "string" || !(BACKUP_FILES_SOURCES as readonly string[]).includes(source)) fail("source is not one the contract knows");
  const store = value.store;
  if (typeof store !== "string" || !STORE_PATTERN.test(store)) fail("store is not a folder");
  const prefix = sourcePrefix(source as BackupFilesSource, store as string);
  if (prefix === null) fail(`no listing of ${source as string} is built`);
  if (!Array.isArray(value.entries)) fail("entries is not a list");
  const list = value.entries as unknown[];
  if (list.length > BACKUP_FILES_PAGE_ENTRIES) fail("more than 1,000 entries");
  sizeCheck(parsed);
  const seen = new Set<string>();
  const entries: BackupFilesEntry[] = list.map((item, i) => {
    const entry = exactObject(item, ENTRY_FIELDS, `entries[${i}]`);
    if (entry.source !== source) fail(`entries[${i}] is of another source`);
    const key = keyOf(entry.key, `entries[${i}].key`);
    if (!key.startsWith(prefix as string) || key.length === (prefix as string).length) fail(`entries[${i}].key is outside the store's folder`);
    if (seen.has(key)) fail(`entries[${i}].key is listed twice`);
    seen.add(key);
    if (typeof entry.etag !== "string" || !ETAG_PATTERN.test(entry.etag)) fail(`entries[${i}].etag is not an etag`);
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) fail(`entries[${i}].size is not a count of bytes`);
    let url: URL | null = null;
    try {
      url = typeof entry.url === "string" && entry.url.length <= 8192 ? new URL(entry.url) : null;
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password) fail(`entries[${i}].url is not a plain https URL`);
    return { source: source as BackupFilesSource, key, etag: entry.etag as string, size: entry.size as number, url: entry.url as string, expiresAt: wholeTime(entry.expiresAt, `entries[${i}].expiresAt`) };
  });
  const end = pageEnd(value, BACKUP_FILES_REASONS);
  return { version: 1, kind: "files", source: source as BackupFilesSource, store: store as string, entries, cursor: end.cursor, complete: end.complete, reason: end.reason as BackupFilesReason };
}

const DELETION_FIELDS = ["version", "kind", "records", "cursor", "complete", "reason"] as const;
const RECORD_FIELDS = ["source", "key", "recordedAt", "reason"] as const;

/** A page of deletion records, exactly; throws BackupFilesContractError on anything else. Nothing about the person is in a record. */
export function parseDeletionPage(raw: unknown): BackupDeletionPage {
  const parsed = textOf(raw);
  const value = exactObject(parsed, DELETION_FIELDS, "deletion page");
  if (value.version !== BACKUP_FILES_CONTRACT_VERSION) fail("version is not 1");
  if (value.kind !== "deletions") fail("kind is not deletions");
  if (!Array.isArray(value.records)) fail("records is not a list");
  const list = value.records as unknown[];
  if (list.length > BACKUP_FILES_PAGE_ENTRIES) fail("more than 1,000 records");
  sizeCheck(parsed);
  const records: BackupDeletionRecord[] = list.map((item, i) => {
    const record = exactObject(item, RECORD_FIELDS, `records[${i}]`);
    if (typeof record.source !== "string" || !(BACKUP_FILES_SOURCES as readonly string[]).includes(record.source)) fail(`records[${i}].source is not one the contract knows`);
    if (typeof record.reason !== "string" || !(BACKUP_DELETION_REASONS as readonly string[]).includes(record.reason)) fail(`records[${i}].reason is not one the contract knows`);
    return { source: record.source as BackupFilesSource, key: keyOf(record.key, `records[${i}].key`), recordedAt: wholeTime(record.recordedAt, `records[${i}].recordedAt`), reason: record.reason as BackupDeletionReason };
  });
  const end = pageEnd(value, ["done", "more", "cutoff"]);
  return { version: 1, kind: "deletions", records, cursor: end.cursor, complete: end.complete, reason: end.reason as BackupDeletionPage["reason"] };
}

const STORES_FIELDS = ["version", "kind", "stores", "cursor", "complete", "reason"] as const;
const STORE_ROOM_FIELDS = ["store", "roomBytes"] as const;

/** A page of the stores to copy, each with the room R of its plan in bytes, exactly; throws BackupFilesContractError on anything else. */
export function parseStoresPage(raw: unknown): BackupStoresPage {
  const parsed = textOf(raw);
  const value = exactObject(parsed, STORES_FIELDS, "stores page");
  if (value.version !== BACKUP_FILES_CONTRACT_VERSION) fail("version is not 1");
  if (value.kind !== "stores") fail("kind is not stores");
  if (!Array.isArray(value.stores)) fail("stores is not a list");
  const list = value.stores as unknown[];
  if (list.length > BACKUP_FILES_PAGE_ENTRIES) fail("more than 1,000 stores");
  sizeCheck(parsed);
  const seen = new Set<string>();
  const stores: BackupStoreRoom[] = list.map((item, i) => {
    const room = exactObject(item, STORE_ROOM_FIELDS, `stores[${i}]`);
    if (typeof room.store !== "string" || !STORE_PATTERN.test(room.store)) fail(`stores[${i}].store is not a folder`);
    if (seen.has(room.store as string)) fail(`stores[${i}].store is listed twice`);
    seen.add(room.store as string);
    if (typeof room.roomBytes !== "number" || !Number.isSafeInteger(room.roomBytes) || room.roomBytes <= 0) fail(`stores[${i}].roomBytes is not a positive count of bytes`);
    return { store: room.store as string, roomBytes: room.roomBytes as number };
  });
  const end = pageEnd(value, ["done", "more", "cutoff"]);
  return { version: 1, kind: "stores", stores, cursor: end.cursor, complete: end.complete, reason: end.reason as BackupStoresPage["reason"] };
}
