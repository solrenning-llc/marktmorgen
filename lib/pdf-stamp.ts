/**
 * Stamping a buyer's email onto every page of the PDF they bought.
 *
 * A creator selling an ebook or a workbook can switch this on per product.
 * When a buyer downloads it, each page carries one quiet line along the bottom
 * — "Sold to maya@example.com on Sep 26, 2026 · order …E54F2A" — so a copy that
 * turns up on a file-sharing site says whose it was. It does not stop anyone
 * from sharing, and the studio says that in as many words; what it does is
 * make a buyer think twice, which is what creators ask it for.
 *
 * It is done with pdf-lib, a small library written in plain JavaScript, so
 * nothing has to be installed on the server and nothing is sent anywhere
 * else: the file goes from the private store into this function's memory,
 * gets its line, and goes back to the private store.
 *
 * The stamped copy is made once per sale and kept, beside the original, at a
 * path derived from the sale and the file; every later download of the same
 * sale is served from it, so a buyer downloading three times costs one stamp.
 * A new file on the product means new copies, and the old ones are deleted
 * when the file they were made from is.
 *
 * Two kinds of PDF are handed over as they were uploaded, and the creator is
 * told in the studio rather than the buyer being refused a file they paid for:
 * one over MAX_STAMP_BYTES (50 MB), and one pdf-lib cannot write to —
 * password-protected, or damaged.
 *
 * An EPUB on the same product gets the same line, as an invisible mark inside
 * the book (lib/epub-stamp.ts; 630 [HN6] item 30, unit 2), through the same
 * switch, the same copy per sale and the same notes to the creator. An EPUB
 * the mark cannot go into without breaking it (signed, encrypted, damaged or
 * built in a way it does not read) is handed over as uploaded, and the
 * studio says which and why.
 *
 * A copy is kept only within the storage the store's plan stands at
 * (writeWithinStorage). A store without room for one more still never hands
 * its buyer the file unstamped, which would undo what the creator switched
 * on: the copy is stamped on the fly for that download and sent without being
 * kept (stampedDelivery, "fly"), and when even that cannot be done now, the
 * buyer is asked to try again ("retry"), never handed the original. The
 * studio says the storage ran out (the "storage" note).
 */
import { createHash } from "node:crypto";
import { stampLine } from "@/lib/pdf-stamp-line";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { deleteFile, headFile, listFiles, readFileWhole, writeFileWhole } from "@/lib/file-store";
import { VAULT_PREFIX, isVaultPath, keyName } from "@/lib/vault-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_STAMP_BYTES, type ProductFile, isEpub, isStampable } from "@/lib/product-file";
import { type EpubProblem, stampEpub } from "@/lib/epub-stamp";
import { folderFromPathname } from "@/lib/delivery";
import { type DataStore, keepFor } from "@/lib/store-data";
import { standingOf } from "@/lib/plan-standing";
import { storageBrakeFor, storageUsed } from "@/lib/storage-quota";
import { releaseStorage, reserveStorage } from "@/lib/storage-reservations";
import { type CopyMeter, FLY_MAX_BYTES, NO_ROOM_NOTE_SECONDS, STORAGE_MEASURE_UNITS, flyHoldUnits, flyUnits } from "@/lib/stamp-cost-rules";
import type { LanguageCode } from "@/lib/store-language";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Kept for about as long as anyone re-downloads a purchase. */
const COPY_RECORD_SECONDS = 400 * 24 * 60 * 60;
/** What a stamped copy's record takes in the store's data room for the time it is kept. */
export const COPY_RECORD_BYTES = 768;
/** How long a note about a PDF that could not be stamped stays in the studio. */
const PROBLEM_SECONDS = 60 * 24 * 60 * 60;

export const copyKey = (reference: string, file: Pick<ProductFile, "pathname" | "addedAt">) => `nl:stamp:copy:${sha(`${reference}|${file.pathname}|${file.addedAt}`).slice(0, 40)}`;
export const problemKey = (pathname: string) => `nl:stamp:problem:${sha(pathname).slice(0, 40)}`;
/**
 * A store found without room for a new copy (writeWithinStorage), for NO_ROOM_NOTE_SECONDS: no copy and no preview
 * of any of its files measures its storage again until it runs out (lib/stamp-cost-rules.ts).
 */
export const noRoomKey = (folder: string) => `nl:stamp:noroom:${folder}`;

/**
 * Why a file is handed over unstamped: too big; one the stamp cannot write
 * into (a PDF locked with a password or damaged, an EPUB damaged or built in a
 * way the mark does not read); or, for an EPUB only, one carrying a digital
 * signature a mark would break, or one under encryption (DRM). "storage" is
 * not a file handed over unstamped: its store had no room to keep one more
 * copy (writeWithinStorage), so the copy was stamped on the fly and not kept.
 */
export type StampProblem = "too_big" | "unreadable" | "signed" | "encrypted" | "storage";
const PROBLEMS: readonly StampProblem[] = ["too_big", "unreadable", "signed", "encrypted", "storage"];

/** An EPUB's reason, in the creator's terms: only the four the studio explains. */
export function epubProblem(why: EpubProblem): StampProblem {
  return why === "too_big" || why === "signed" || why === "encrypted" ? why : "unreadable";
}

/** The line printed on every page (lib/pdf-stamp-line.ts, which pages that only show it read without the PDF library). */
export { stampLine };

/**
 * The standard PDF font writes only the Latin-1 letters, so anything else in
 * an address — rare, but legal — is shown as "?" rather than breaking the
 * stamp. The buyer's own copy is still unmistakably theirs.
 */
function writable(text: string): string {
  return [...text].map((ch) => (/[ -~ -ÿ…]/.test(ch) ? ch : "?")).join("");
}

/**
 * Puts the line along the bottom of every page, however the page is turned: a
 * page stored sideways and shown upright gets the line along what the reader
 * sees as its foot, reading left to right. Pure: bytes in, bytes out.
 */
export async function stampPdf(bytes: Uint8Array, line: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = writable(line);
  const margin = 14;
  for (const page of doc.getPages()) {
    const box = page.getCropBox();
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const across = angle === 90 || angle === 270 ? box.height : box.width;
    const size = Math.max(4, Math.min(7.5, ((across - margin * 2) / font.widthOfTextAtSize(text, 1)) * 0.98));
    const inset = margin;
    const lift = margin - size * 0.2;
    const at =
      angle === 90
        ? { x: box.x + box.width - lift, y: box.y + inset, rotate: 90 }
        : angle === 180
          ? { x: box.x + box.width - inset, y: box.y + box.height - lift, rotate: 180 }
          : angle === 270
            ? { x: box.x + lift, y: box.y + box.height - inset, rotate: 270 }
            : { x: box.x + inset, y: box.y + lift, rotate: 0 };
    page.drawText(text, {
      x: at.x,
      y: at.y,
      size,
      font,
      rotate: degrees(at.rotate),
      color: rgb(0.38, 0.38, 0.42),
      opacity: 0.85,
    });
  }
  return doc.save();
}

/** Whether a product's file is one that stamping applies to at all: a PDF or an EPUB. */
export function wantsStamp(stamp: boolean, file: ProductFile): boolean {
  return stamp && isStampable(file);
}

async function noteProblem(pathname: string, problem: StampProblem): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline([["SET", problemKey(pathname), problem, "EX", PROBLEM_SECONDS]]).catch(() => {});
}

/** What writeWithinStorage did: kept the copy, found no room, could not pay for the measurement, or failed to write. */
export type KeepOutcome = "kept" | "no_room" | "not_measured" | "failed";

/** Writes over a copy already in place that is at least as big: the store's storage does not grow. */
async function writeOver(pathname: string, bytes: Uint8Array, contentType: string): Promise<KeepOutcome> {
  try {
    await writeFileWhole(pathname, bytes, contentType);
    return "kept";
  } catch (error) {
    console.error("a copy could not be written to the file store", error);
    return "failed";
  }
}

/** Whether the store holding `original` was found without room lately (noRoomKey). Unknown reads as no note. */
export async function roomNotedOut(original: Pick<ProductFile, "pathname">): Promise<boolean> {
  const folder = folderFromPathname(original.pathname);
  if (!folder || !isRedisConfigured()) return false;
  try {
    const [noted] = await redisPipeline([["GET", noRoomKey(folder)]]);
    return noted !== null && noted !== undefined;
  } catch {
    return false;
  }
}

/**
 * Writes a copy made from `original` (a buyer's stamped copy, or a PDF's preview, lib/pdf-preview.ts) into the
 * store's own folder only within the storage its plan stands at (lib/storage-quota.ts storageBrakeFor): its bytes
 * are reserved first against what the store holds, measured from the file stores themselves, plus what other
 * uploads have reserved (lib/storage-reservations.ts), so a copy is a cost inside the plan's storage line, never
 * past it (owner rule MR: a ceiling before every spend).
 *
 * The measurement lists the store's files, which costs: STORAGE_MEASURE_UNITS of the store's public requests are
 * taken first (`meter`, lib/stamp-cost-rules.ts), and without them nothing is listed ("not_measured"). A store
 * without room, or whose storage cannot be measured or reserved, writes nothing ("no_room") and is noted so for
 * NO_ROOM_NOTE_SECONDS (noRoomKey), so neither its copies nor its previews list it again meanwhile. A write that
 * throws is "failed". Only "kept" put a file in the store's folder.
 *
 * The reservation goes once the write has answered, whether it wrote or threw: a copy that did land is then held
 * by the store's own listing, which is what every later reservation measures, so nothing is counted as room.
 */
export async function writeWithinStorage(
  original: Pick<ProductFile, "pathname">,
  pathname: string,
  bytes: Uint8Array,
  contentType: string,
  store: DataStore,
  meter: CopyMeter,
): Promise<KeepOutcome> {
  const folder = folderFromPathname(original.pathname);
  if (!folder || folderFromPathname(pathname) !== folder || bytes.byteLength <= 0) return "failed";
  if (!(await meter.take(STORAGE_MEASURE_UNITS).catch(() => false))) return "not_measured";
  const brake = storageBrakeFor(standingOf(store), store.tier);
  // Both callers write to a path fixed by the sale or the page count, over whatever is there. A copy already in place
  // (its record lost, expired or never written) is in the listing the reservation measures, so writing over it grows
  // the store only by what is past its size, read exactly from the file store; not there, or not read, the whole
  // copy is reserved, as for a new file.
  const inPlace = await headFile(pathname).then(
    (found) => (found.pathname === pathname && Number.isSafeInteger(found.size) && found.size > 0 ? found.size : 0),
    () => 0,
  );
  const growth = bytes.byteLength - inPlace;
  if (growth <= 0) return writeOver(pathname, bytes, contentType);
  let reservation: Awaited<ReturnType<typeof reserveStorage>>;
  try {
    reservation = await reserveStorage(folder, growth, brake, async () => {
      const held = await storageUsed(folder, brake);
      if (held.available !== true) throw new Error("storage_unknown");
      return held.bytes;
    });
  } catch (error) {
    console.error("no room confirmed in the store's storage for a new copy; none is kept", error);
    if (isRedisConfigured()) await redisPipeline([["SET", noRoomKey(folder), "1", "EX", NO_ROOM_NOTE_SECONDS]]).catch(() => {});
    return "no_room";
  }
  try {
    await writeFileWhole(pathname, bytes, contentType);
    return "kept";
  } catch (error) {
    console.error("a copy could not be written to the file store", error);
    return "failed";
  } finally {
    await releaseStorage(folder, reservation.id).catch((error: unknown) => console.error("a copy's storage reservation was kept", error));
  }
}

/** What went wrong stamping each of these files lately, for the studio. */
export async function stampProblems(files: ProductFile[]): Promise<Map<string, StampProblem>> {
  const found = new Map<string, StampProblem>();
  for (const file of files) {
    if (isStampable(file) && file.bytes > MAX_STAMP_BYTES) found.set(file.pathname, "too_big");
  }
  const rest = files.filter((file) => !found.has(file.pathname) && isStampable(file));
  if (rest.length === 0 || !isRedisConfigured()) return found;
  const rows = await redisPipeline(rest.map((file) => ["GET", problemKey(file.pathname)]));
  rows.forEach((raw, i) => {
    const problem = PROBLEMS.find((p) => p === raw);
    if (problem) found.set(rest[i].pathname, problem);
  });
  return found;
}

/** Reads a private file whole, refusing to hold more than `limit` bytes. */
async function readWhole(pathname: string, limit: number): Promise<Uint8Array | null> {
  return readFileWhole(pathname, limit);
}

/**
 * Where a file's stamped copies live: one folder per original, one per sale.
 * Its preview (lib/pdf-preview.ts) is kept in the same folder, so deleting
 * the original deletes both (dropStamped).
 */
export function copyFolder(file: Pick<ProductFile, "pathname">): string {
  const folder = folderFromPathname(file.pathname) ?? "unknown";
  // A copy is kept in the store its original is in, so handing it to the
  // buyer costs what handing over the original would.
  const root = isVaultPath(file.pathname) ? VAULT_PREFIX : "stores";
  return `${root}/${folder}/stamped/${sha(file.pathname).slice(0, 24)}/`;
}

/**
 * What a buyer's download hands over for a file the product stamps:
 *
 *   - "kept": the buyer's stamped copy, kept in the store's folder and reused by every later download of the sale;
 *   - "original": stamping does not apply to this file (not a PDF or an EPUB, no order or address to mark, over
 *     MAX_STAMP_BYTES, or a file the mark cannot go into), and the studio says why;
 *   - "fly": the store had no room to keep one more copy (writeWithinStorage), so this copy was stamped for this
 *     download and is sent without being kept: its bytes, never written anywhere;
 *   - "retry": a copy had to be stamped on the fly and could not be now (the store's requests used, the file not
 *     read, a copy past FLY_MAX_BYTES): the buyer is asked to try again. Never the original in its place.
 */
export type StampedDelivery =
  | { kind: "kept"; copy: ProductFile }
  | { kind: "original" }
  | { kind: "fly"; bytes: Uint8Array; name: string; contentType: string }
  | { kind: "retry" };

const ORIGINAL: StampedDelivery = { kind: "original" };
const RETRY: StampedDelivery = { kind: "retry" };

type Sale = { reference: string; email: string; paidAt: number };
type Stamped = { ok: true; bytes: Uint8Array; contentType: string } | { ok: false; problem: StampProblem };

/** The file's bytes with the buyer's line in them, or why the mark cannot go in. Throws only on what is not the file's fault. */
async function stampBytes(file: ProductFile, original: Uint8Array, sale: Sale, store: { language?: LanguageCode }): Promise<Stamped> {
  // In the store's language, with the date its way (lib/buyer-words/stamp.ts).
  const line = stampLine(sale.email, sale.reference, new Date((sale.paidAt || Date.now() / 1000) * 1000), store.language);
  if (isEpub(file)) {
    const result = stampEpub(original, line);
    return result.ok ? { ok: true, bytes: result.bytes, contentType: "application/epub+zip" } : { ok: false, problem: epubProblem(result.why) };
  }
  try {
    return { ok: true, bytes: await stampPdf(original, line), contentType: "application/pdf" };
  } catch (error) {
    console.error("a PDF could not be stamped", error);
    return { ok: false, problem: "unreadable" };
  }
}

/**
 * A copy already stamped, sent on without being kept: the public requests its sending is counted as
 * (lib/stamp-cost-rules.ts flyUnits: the held function and its bytes) are taken first, and without them, or for a
 * copy past FLY_MAX_BYTES, the buyer is asked to try again.
 */
async function sendUnkept(file: ProductFile, stamped: { bytes: Uint8Array; contentType: string }, meter: CopyMeter): Promise<StampedDelivery> {
  if (stamped.bytes.byteLength > FLY_MAX_BYTES) return RETRY;
  if (!(await meter.take(flyUnits(0, stamped.bytes.byteLength)).catch(() => false))) return RETRY;
  return { kind: "fly", bytes: stamped.bytes, name: file.name, contentType: stamped.contentType };
}

/**
 * Stamps a copy for this download only, for a store noted without room: the hold at its worst is taken before the
 * original is read (flyHoldUnits), and once the work is done what it did not need is given back, or what it needed
 * past the hold taken. Any failure on the way asks the buyer to try again; the original is never handed over here,
 * since this file was stamped before and stamping applies to it.
 */
async function stampOnTheFly(file: ProductFile, sale: Sale, store: { language?: LanguageCode }, meter: CopyMeter): Promise<StampedDelivery> {
  const held = flyHoldUnits(file.bytes);
  if (!(await meter.take(held).catch(() => false))) return RETRY;
  const started = Date.now();
  let stamped: Stamped | null = null;
  try {
    const original = await readWhole(file.pathname, MAX_STAMP_BYTES);
    if (original) stamped = await stampBytes(file, original, sale, store);
  } catch (error) {
    console.error("a copy could not be stamped on the fly", error);
  }
  const sent = stamped?.ok && stamped.bytes.byteLength <= FLY_MAX_BYTES ? stamped.bytes.byteLength : 0;
  const used = flyUnits(Math.max(0, Date.now() - started), file.bytes + sent);
  if (Number.isNaN(used)) return RETRY;
  if (used < held) await meter.give(held - used).catch(() => {});
  // A file refused for what it is (unreadable, password-protected, signed, encrypted) is refused again by the same
  // bytes: handed over as uploaded, with the problem noted for the creator, as a store with room does (Codex X5's
  // MEDIUM on #3899). Only what may work later (the store's requests, a read, the size sent) asks to try again.
  if (stamped && !stamped.ok) {
    await noteProblem(file.pathname, stamped.problem);
    return ORIGINAL;
  }
  if (!stamped?.ok || sent === 0) return RETRY;
  if (used > held && !(await meter.take(used - held).catch(() => false))) return RETRY;
  return { kind: "fly", bytes: stamped.bytes, name: file.name, contentType: stamped.contentType };
}

/**
 * The buyer's stamped copy of a PDF or an EPUB, made on the first download of a sale and kept for the later ones
 * (StampedDelivery says what each answer is). `meter` takes the store's public requests before what a copy spends
 * beyond the download itself: measuring the store's storage, and a copy stamped on the fly (lib/stamp-cost-rules.ts).
 * Never throws.
 */
export async function stampedDelivery(
  file: ProductFile,
  sale: Sale,
  store: DataStore & { language?: LanguageCode },
  meter: CopyMeter,
): Promise<StampedDelivery> {
  if (!isStampable(file) || !sale.reference || !sale.email) return ORIGINAL;
  if (file.bytes > MAX_STAMP_BYTES) {
    await noteProblem(file.pathname, "too_big");
    return ORIGINAL;
  }
  const key = copyKey(sale.reference, file);
  let stamped: { bytes: Uint8Array; contentType: string } | null = null;
  let storageNoted = false;
  try {
    const epub = isEpub(file);
    if (isRedisConfigured()) {
      const [cached, noted] = await redisPipeline([["GET", key], ["GET", problemKey(file.pathname)]]);
      if (typeof cached === "string") {
        try {
          return { kind: "kept", copy: JSON.parse(cached) as ProductFile };
        } catch {}
      }
      // An EPUB refused for what it is (signed, encrypted, unreadable) is
      // refused again by the same bytes: it is handed over as uploaded without
      // being read and opened on every download. The note is per path, and a
      // new file is a new path. A size note is not trusted this way, since a
      // failed read is noted as one too.
      if (epub && (noted === "signed" || noted === "encrypted" || noted === "unreadable")) return ORIGINAL;
      storageNoted = noted === "storage";
    }
    // A store found without room a moment ago is not listed again on every download: the copy is stamped on the
    // fly, below, outside this block, so nothing that goes wrong there can hand over the original.
    if (!(await roomNotedOut(file))) {
      const original = await readWhole(file.pathname, MAX_STAMP_BYTES);
      if (!original) {
        await noteProblem(file.pathname, "too_big");
        return ORIGINAL;
      }
      const result = await stampBytes(file, original, sale, store);
      if (!result.ok) {
        await noteProblem(file.pathname, result.problem);
        return ORIGINAL;
      }
      stamped = result;
    }
  } catch (error) {
    console.error("stamping a file failed; handing over the original", error);
    return ORIGINAL;
  }
  if (!stamped) return stampOnTheFly(file, sale, store, meter).catch(() => RETRY);
  // From here the copy is stamped: whatever happens, the buyer gets it or is asked to try again, never the original.
  try {
    // In the store that charges nothing to send, a path is plain characters
    // only (lib/vault-rules.ts); the name the buyer saves it under is kept
    // beside the path, as it is for the original.
    const last = isVaultPath(file.pathname) ? keyName(file.name) : file.name;
    const pathname = `${copyFolder(file)}${sha(`${sale.reference}|${file.addedAt}`).slice(0, 24)}/${last}`;
    const kept = await writeWithinStorage(file, pathname, stamped.bytes, stamped.contentType, store, meter);
    if (kept !== "kept") {
      // The studio is told only what is true: no room was confirmed. A write that failed, or a measurement the store's
      // requests could not pay for, is not the storage running out.
      // Kept as long as the studio's other notes, so the creator sees it, until a copy of this file is kept again.
      if (kept === "no_room") await noteProblem(file.pathname, "storage");
      return await sendUnkept(file, stamped, meter);
    }
    const copy: ProductFile = {
      pathname,
      name: file.name,
      bytes: stamped.bytes.byteLength,
      contentType: stamped.contentType,
      addedAt: new Date().toISOString(),
    };
    // Its record is kept only while the store's data room has space for it
    // (lib/store-data.ts): without it the buyer still gets this copy, and the
    // next download stamps another.
    try {
      if (isRedisConfigured() && (await keepFor(store, COPY_RECORD_BYTES, COPY_RECORD_SECONDS))) {
        await redisPipeline([["SET", key, JSON.stringify(copy), "EX", COPY_RECORD_SECONDS]]);
      }
    } catch (error) {
      console.error("a stamped copy's record could not be kept; the next download stamps another", error);
    }
    // The storage has room again: the studio no longer says it ran out for this file.
    if (storageNoted) await redisPipeline([["DEL", problemKey(file.pathname)]]).catch(() => {});
    // Copies left over by a removal the file store failed are tried again here too, a few at a time; the buyer's
    // copy is already made, and a failure leaves them on the list for the next try. This file's own folder is kept
    // for a later try: emptying it now would delete the copy handed over below.
    await retryStampDrops(RETRY_PER_CALL, copyFolder(file)).catch((error: unknown) => console.error("stamped copies left from before could not be deleted yet; they stay on the list", error));
    return { kind: "kept", copy };
  } catch (error) {
    console.error("keeping a stamped copy failed; it is sent without being kept", error);
    return sendUnkept(file, stamped, meter).catch(() => RETRY);
  }
}

/**
 * Folders of stamped copies whose deletion failed, each tried again until its copies are gone: every copy carries
 * a buyer's email and counts in the store's paid storage, so a failed deletion is never counted as done.
 */
export const DROP_QUEUE = "nl:stamp:drop";
/** How many such folders one removal or one new copy tries again: a few calls to the file store at most. */
const RETRY_PER_CALL = 2;
/** What copyFolder makes, and so the only thing read from the list that is ever listed and deleted. */
const COPY_FOLDER = new RegExp(`^(?:${VAULT_PREFIX}|stores)/[^/]+/stamped/[0-9a-f]{24}/$`);

/** Deletes every file in a folder of stamped copies. Throws when the folder cannot be listed whole or a file not deleted. */
async function deleteFolder(folder: string): Promise<void> {
  const copies = await listFiles(folder);
  for (let i = 0; i < copies.length; i += 1000) await deleteFile(copies.slice(i, i + 1000));
}

/** Puts a folder down to be tried again. False when that could not be confirmed (rule 24: SADD answers 0 or 1). */
async function noteDrop(folder: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  try {
    const replies = repliesFor(await redisPipeline([["SADD", DROP_QUEUE, folder]]), 1);
    const added = replies ? countOf(replies[0]) : null;
    return added === 0 || added === 1;
  } catch {
    return false;
  }
}

/**
 * Tries again up to `limit` folders a deletion left behind, and answers how many were emptied. A folder leaves the
 * list only after every copy in it is confirmed deleted; the first that fails stops the try and stays. A list read
 * in any shape but an exact list of text throws (UnknownReplyError), and nothing is deleted on it.
 */
export async function retryStampDrops(limit: number, keep?: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const replies = repliesFor(await redisPipeline([["SRANDMEMBER", DROP_QUEUE, limit]]), 1);
  const folders = replies ? stringList(replies[0]) : null;
  if (!folders || folders.length > limit) throw new UnknownReplyError("the stamped copies to delete");
  let emptied = 0;
  for (const folder of folders) {
    // `keep` is the folder of a copy being handed over right now: it stays on the list for a later try, so a new
    // copy is never deleted by its own call (Codex M on #3312).
    if (!COPY_FOLDER.test(folder) || folder === keep) continue;
    await deleteFolder(folder);
    const gone = repliesFor(await redisPipeline([["SREM", DROP_QUEUE, folder]]), 1);
    const count = gone ? countOf(gone[0]) : null;
    if (count === null || count > 1) throw new UnknownReplyError("a folder of deleted copies taken off the list");
    emptied += 1;
  }
  return emptied;
}

/**
 * Deletes every stamped copy made from a file, once the file itself is gone. It never fails the removal that
 * called it (the file is already off the product): a folder the file store could not list whole or empty is put
 * down in DROP_QUEUE and tried again by the next removal or new copy, and the log says so when even that cannot be.
 */
export async function dropStamped(file: Pick<ProductFile, "pathname" | "name" | "contentType">): Promise<void> {
  if (!isStampable(file)) return;
  await retryStampDrops(RETRY_PER_CALL).catch((error: unknown) => console.error("stamped copies left from before could not be deleted yet; they stay on the list", error));
  const folder = copyFolder(file);
  try {
    await deleteFolder(folder);
  } catch (error) {
    if (await noteDrop(folder)) console.error("could not delete stamped copies; put down to be tried again", error);
    else console.error(`could not delete stamped copies in ${folder}, and nothing will try again: the list could not be written`, error);
  }
}
