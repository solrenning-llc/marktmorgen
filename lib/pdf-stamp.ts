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
 */
import { createHash } from "node:crypto";
import { stampLine } from "@/lib/pdf-stamp-line";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { deleteFile, listFiles, readFileWhole, writeFileWhole } from "@/lib/file-store";
import { VAULT_PREFIX, isVaultPath, keyName } from "@/lib/vault-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_STAMP_BYTES, type ProductFile, isEpub, isStampable } from "@/lib/product-file";
import { type EpubProblem, stampEpub } from "@/lib/epub-stamp";
import { folderFromPathname } from "@/lib/delivery";
import { type DataStore, keepFor } from "@/lib/store-data";

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
 * Why a file is handed over unstamped: too big; one the stamp cannot write
 * into (a PDF locked with a password or damaged, an EPUB damaged or built in a
 * way the mark does not read); or, for an EPUB only, one carrying a digital
 * signature a mark would break, or one under encryption (DRM).
 */
export type StampProblem = "too_big" | "unreadable" | "signed" | "encrypted";
const PROBLEMS: readonly StampProblem[] = ["too_big", "unreadable", "signed", "encrypted"];

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
 * The buyer's stamped copy of a PDF or an EPUB, made on the first download of a sale and
 * reused after. Null means hand over the original: stamping does not apply,
 * or it could not be done, and the reason is kept for the creator to see.
 * Never throws: a buyer who paid gets a file either way.
 */
export async function stampedCopy(
  file: ProductFile,
  sale: { reference: string; email: string; paidAt: number },
  store: DataStore,
): Promise<ProductFile | null> {
  if (!isStampable(file) || !sale.reference || !sale.email) return null;
  if (file.bytes > MAX_STAMP_BYTES) {
    await noteProblem(file.pathname, "too_big");
    return null;
  }
  try {
    const key = copyKey(sale.reference, file);
    const epub = isEpub(file);
    if (isRedisConfigured()) {
      const [cached, noted] = await redisPipeline([["GET", key], ["GET", problemKey(file.pathname)]]);
      if (typeof cached === "string") {
        try {
          return JSON.parse(cached) as ProductFile;
        } catch {}
      }
      // An EPUB refused for what it is (signed, encrypted, unreadable) is
      // refused again by the same bytes: it is handed over as uploaded without
      // being read and opened on every download. The note is per path, and a
      // new file is a new path. A size note is not trusted this way, since a
      // failed read is noted as one too.
      if (epub && (noted === "signed" || noted === "encrypted" || noted === "unreadable")) return null;
    }
    const original = await readWhole(file.pathname, MAX_STAMP_BYTES);
    if (!original) {
      await noteProblem(file.pathname, "too_big");
      return null;
    }
    const line = stampLine(sale.email, sale.reference, new Date((sale.paidAt || Date.now() / 1000) * 1000));
    let stamped: Uint8Array;
    if (epub) {
      const result = stampEpub(original, line);
      if (!result.ok) {
        await noteProblem(file.pathname, epubProblem(result.why));
        return null;
      }
      stamped = result.bytes;
    } else {
      try {
        stamped = await stampPdf(original, line);
      } catch (error) {
        console.error("a PDF could not be stamped; handing over the original", error);
        await noteProblem(file.pathname, "unreadable");
        return null;
      }
    }
    const contentType = epub ? "application/epub+zip" : "application/pdf";
    // In the store that charges nothing to send, a path is plain characters
    // only (lib/vault-rules.ts); the name the buyer saves it under is kept
    // beside the path, as it is for the original.
    const last = isVaultPath(file.pathname) ? keyName(file.name) : file.name;
    const pathname = `${copyFolder(file)}${sha(`${sale.reference}|${file.addedAt}`).slice(0, 24)}/${last}`;
    await writeFileWhole(pathname, stamped, contentType);
    const copy: ProductFile = {
      pathname,
      name: file.name,
      bytes: stamped.byteLength,
      contentType,
      addedAt: new Date().toISOString(),
    };
    // Its record is kept only while the store's data room has space for it
    // (lib/store-data.ts): without it the buyer still gets this copy, and the
    // next download stamps another.
    if (isRedisConfigured() && (await keepFor(store, COPY_RECORD_BYTES, COPY_RECORD_SECONDS))) {
      await redisPipeline([["SET", key, JSON.stringify(copy), "EX", COPY_RECORD_SECONDS]]);
    }
    // Copies left over by a removal the file store failed are tried again here too, a few at a time; the buyer's
    // copy is already made, and a failure leaves them on the list for the next try. This file's own folder is kept
    // for a later try: emptying it now would delete the copy handed over below.
    await retryStampDrops(RETRY_PER_CALL, copyFolder(file)).catch((error: unknown) => console.error("stamped copies left from before could not be deleted yet; they stay on the list", error));
    return copy;
  } catch (error) {
    console.error("stamping a file failed; handing over the original", error);
    return null;
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
