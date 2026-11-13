/**
 * 273 [BK1], files part 1: the exact JSON the backup Worker reads from the
 * site's listing route (lib/backup-files-contract.ts), and the strict parsers
 * the Worker reuses. Synthetic pages only.
 *
 * What fails here (rule 24: unknown is never success, zero or absent):
 *   - any unknown shape read as a page: an extra or a missing field, a wrong
 *     type, an entry of another source or outside the store's folder, a
 *     duplicate key, a size that is not a whole count, a plain-http URL;
 *   - a page that says it is complete while it carries a cursor, or that is
 *     incomplete with nothing to go on from (other than over_bound);
 *   - more than 1,000 entries or 1 MB in a page;
 *   - a deletion record with a reason or a date the contract does not know,
 *     or deletion records mixed into a files page;
 *   - the bounds of item 8 drifting from the route's own pages.
 */
import {
  BACKUP_FILES_HELD_OBJECTS,
  BACKUP_FILES_OBJECTS_PER_MONTH,
  BACKUP_FILES_PAGE_BYTES,
  BACKUP_FILES_PAGE_ENTRIES,
  BACKUP_FILES_PAGES_PER_STORE,
  BACKUP_FILES_URL_SECONDS,
  BackupFilesContractError,
  parseDeletionPage,
  parseFilesPage,
  sourcePrefix,
} from "@/lib/backup-files-contract";
import { done, is, part } from "./check";

const STORE = "0123456789abcdef0123456789abcdef";
const entry = (n: number, over: Record<string, unknown> = {}) => ({
  source: "blob",
  key: `stores/${STORE}/f${n}.pdf`,
  etag: `"etag${n}"`,
  size: 1000 + n,
  url: `https://store.private.blob.vercel-storage.com/stores/${STORE}/f${n}.pdf?sig=${n}`,
  expiresAt: 1_800_000_000_000,
  ...over,
});
const page = (over: Record<string, unknown> = {}) => ({
  version: 1,
  kind: "files",
  source: "blob",
  store: STORE,
  entries: [entry(1), entry(2)],
  cursor: null,
  complete: true,
  reason: "done",
  ...over,
});
const without = (value: Record<string, unknown>, field: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
const refused = (raw: unknown): boolean => {
  try {
    parseFilesPage(raw);
    return false;
  } catch (error) {
    return error instanceof BackupFilesContractError;
  }
};
const recordRefused = (raw: unknown): boolean => {
  try {
    parseDeletionPage(raw);
    return false;
  } catch (error) {
    return error instanceof BackupFilesContractError;
  }
};

part("the bounds of item 8, matched to the route's pages");
is("a page holds at most 1,000 entries and 1 MB", [BACKUP_FILES_PAGE_ENTRIES, BACKUP_FILES_PAGE_BYTES], [1000, 1_000_000]);
is("a complete listing of one source of one store is at most 10 pages", BACKUP_FILES_PAGES_PER_STORE, 10);
is("so a store can hold at most pages × entries objects a source and still list complete", BACKUP_FILES_HELD_OBJECTS, BACKUP_FILES_PAGES_PER_STORE * BACKUP_FILES_PAGE_ENTRIES);
is("the objects copied for one store a month are the 10,000 priced (docs/backup-costs-2026-11-08.md, 5b), never more than one complete listing", [BACKUP_FILES_OBJECTS_PER_MONTH, BACKUP_FILES_OBJECTS_PER_MONTH <= BACKUP_FILES_HELD_OBJECTS], [10_000, true]);
is("a signed URL lasts 15 minutes", BACKUP_FILES_URL_SECONDS, 900);
is("each source's folder", [sourcePrefix("r2", STORE), sourcePrefix("blob", STORE), sourcePrefix("bunny", STORE)], [`vault/${STORE}/`, `stores/${STORE}/`, null]);

part("a good page reads as itself, from an object or from its text");
const good = page();
is("the object", parseFilesPage(good), good);
is("the text", parseFilesPage(JSON.stringify(good)), good);
is("an incomplete page with a cursor", parseFilesPage(page({ complete: false, reason: "more", cursor: "abc_DEF-1" })).cursor, "abc_DEF-1");
is("a page cut off with nothing signed yet is incomplete, never empty-and-complete", parseFilesPage(page({ entries: [], complete: false, reason: "cutoff", cursor: "x" })).complete, false);
is("over the bound: incomplete for good, no cursor", parseFilesPage(page({ complete: false, reason: "over_bound", cursor: null })).reason, "over_bound");
is("an empty, complete listing of a folder that is confirmed empty", parseFilesPage(page({ entries: [] })).entries.length, 0);

part("every unknown shape throws");
is("not an object", [refused(null), refused([]), refused("not json"), refused(7)], [true, true, true, true]);
is("an extra field", refused({ ...good, note: "x" }), true);
is("a missing field", refused(without(good, "reason")), true);
is("another version or kind", [refused(page({ version: 2 })), refused(page({ kind: "deletions" }))], [true, true]);
is("an unknown source, or bunny (not built)", [refused(page({ source: "s3" })), refused(page({ source: "bunny", entries: [] }))], [true, true]);
is("a store that is not a folder", refused(page({ store: "../x" })), true);
is("complete with a cursor", refused(page({ cursor: "x" })), true);
is("complete with another reason", refused(page({ reason: "more" })), true);
is("incomplete with nothing to go on from", refused(page({ complete: false, reason: "more", cursor: null })), true);
is("incomplete and called done", refused(page({ complete: false, reason: "done", cursor: "x" })), true);
is("over_bound with a cursor", refused(page({ complete: false, reason: "over_bound", cursor: "x" })), true);
is("an unknown reason", refused(page({ complete: false, reason: "partial", cursor: "x" })), true);
is("a cursor with characters outside base64url", refused(page({ complete: false, reason: "more", cursor: "a b" })), true);
is("a complete flag that is not a boolean", refused(page({ complete: "true" })), true);
is("entries that are not a list", refused(page({ entries: {} })), true);
is("more than 1,000 entries", refused(page({ entries: Array.from({ length: 1001 }, (_, i) => entry(i)) })), true);
is("more than 1 MB", refused(page({ entries: [entry(1, { key: `stores/${STORE}/${"a".repeat(1000)}`, url: `https://x.example/${"b".repeat(1_000_000)}` })] })), true);

part("every unknown entry throws");
is("an extra or a missing field", [refused(page({ entries: [{ ...entry(1), mode: "x" }] })), refused(page({ entries: [without(entry(1), "etag")] }))], [true, true]);
is("an entry of another source", refused(page({ entries: [entry(1, { source: "r2" })] })), true);
is("a key outside the store's folder", refused(page({ entries: [entry(1, { key: "stores/ffffffffffffffffffffffffffffffff/a.pdf" })] })), true);
is("a key with a control character, or empty after the folder", [refused(page({ entries: [entry(1, { key: `stores/${STORE}/a\nb` })] })), refused(page({ entries: [entry(1, { key: `stores/${STORE}/` })] }))], [true, true]);
is("the same key twice", refused(page({ entries: [entry(1), entry(1)] })), true);
is("an empty or spaced etag", [refused(page({ entries: [entry(1, { etag: "" })] })), refused(page({ entries: [entry(1, { etag: "a b" })] }))], [true, true]);
is("a size that is negative, fractional, a string or unsafe", [-1, 1.5, "10", 2 ** 53].map((size) => refused(page({ entries: [entry(1, { size })] }))), [true, true, true, true]);
is("a plain-http, credentialed or unparsable URL", ["http://x.example/a", "https://u:p@x.example/a", "not a url"].map((url) => refused(page({ entries: [entry(1, { url })] }))), [true, true, true]);
is("an expiry that is not a positive whole time", [0, -5, 1.5, "1"].map((expiresAt) => refused(page({ entries: [entry(1, { expiresAt })] }))), [true, true, true, true]);

part("deletion records, on their own page");
const record = { source: "r2", key: `vault/${STORE}/owner/abc/f.pdf`, recordedAt: 1_800_000_000_000, reason: "creator_deleted" };
// A complete page of records carries the point the next read resumes from: records are read once, never again each day.
const deletions = { version: 1, kind: "deletions", records: [record], cursor: "resume-here", complete: true, reason: "done" };
is("a good page of records", parseDeletionPage(deletions), deletions);
is("every reason the contract knows", ["creator_deleted", "store_closed", "privacy_request", "site_cleanup"].map((reason) => recordRefused({ ...deletions, records: [{ ...record, reason }] })), [false, false, false, false]);
is("an unknown reason, date or extra field", [recordRefused({ ...deletions, records: [{ ...record, reason: "other" }] }), recordRefused({ ...deletions, records: [{ ...record, recordedAt: "2026-11-08" }] }), recordRefused({ ...deletions, records: [{ ...record, person: "a@b.c" }] })], [true, true, true]);
is("a files page is never read as records, nor records as files", [recordRefused(good), refused(deletions)], [true, true]);
is("complete without a resume point, or incomplete without a cursor", [recordRefused({ ...deletions, cursor: null }), recordRefused({ ...deletions, cursor: null, complete: false, reason: "more" })], [true, true]);
is("incomplete with a cursor reads", recordRefused({ ...deletions, complete: false, reason: "more" }), false);

done();
