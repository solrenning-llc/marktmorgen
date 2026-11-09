/**
 * The first pages of a product's PDF, readable by anyone before buying.
 *
 * Measured before it was built (7 October 2026): Gumroad lets a creator show
 * a preview of a file, Amazon's "Look inside" made it the expected way to buy
 * a book, and Payhip and Etsy sellers attach sample pages by hand. Stan has
 * nothing of the kind. Someone deciding whether forty recipes are worth $27
 * decides faster with three of them in front of them.
 *
 * What it is:
 *
 *   - A separate file, cut from the original with pdf-lib: its first N pages
 *     (1 to 10, the creator's choice), and nothing else of it. The original
 *     never leaves the private store this way, and no page past N is in the
 *     copy to be found.
 *   - Made once per original and number of pages, kept beside the stamped
 *     copies (lib/pdf-stamp.ts, copyFolder), so it is deleted with the
 *     original, and its record kept in Redis.
 *   - Counted as a free download (lib/serve-file.ts, paid: false), so it
 *     pauses with the store's other free downloads if a link to it runs away;
 *     nothing anybody bought is ever affected.
 *   - Only for a PDF up to MAX_STAMP_BYTES that pdf-lib can read. Anything
 *     else simply has no preview, and the studio says why.
 *   - A PDF pdf-lib cannot open (an owner password, damage) is read and
 *     parsed once: it is noted "unreadable" in the stamp's own note
 *     (lib/pdf-stamp.ts, problemKey), which takes no data room and which the
 *     studio shows, and is not read again for any visitor while the note is
 *     kept. A failure takes nothing from the store's data room (R30).
 *
 *   nl:preview:<sha(pathname|addedAt|pages)>   the preview's ProductFile, JSON
 */
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { readFileWhole, writeFileWhole } from "@/lib/file-store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { MAX_STAMP_BYTES, type ProductFile, isPdf } from "@/lib/product-file";
import { copyFolder, problemKey } from "@/lib/pdf-stamp";
import { type DataStore, dataUsed, keepFor } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";

/** The most pages a preview may hold. */
export const MAX_PREVIEW_PAGES = 10;
/** Kept as long as a product page is, in effect: a year, made again if lost. */
const PREVIEW_SECONDS = 400 * 24 * 60 * 60;
/**
 * What a preview's record takes in the store's data room for the year it is
 * kept (lib/store-data.ts): the copy's name and place, under its key. Taken
 * once the copy is cut and before it is written, so a PDF that cannot be cut
 * takes nothing; a store whose room is full shows no preview it has not made
 * yet (without reading the file), and every one it has.
 */
export const PREVIEW_RECORD_BYTES = 1_024;
/** The room's own field for the month a record expires in (lib/store-data.ts, TAKE_DATA). */
const MONTH_FIELD_BYTES = 64;
/** As long as lib/pdf-stamp.ts keeps its note about a file that could not be stamped. */
const UNREADABLE_SECONDS = 60 * 24 * 60 * 60;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const previewKey = (file: Pick<ProductFile, "pathname" | "addedAt">, pages: number) => `nl:preview:${sha(`${file.pathname}|${file.addedAt}|${pages}`).slice(0, 40)}`;

/** Whether this file can have a preview at all. */
export function previewable(file: ProductFile | null): file is ProductFile {
  return Boolean(file && isPdf(file) && file.bytes <= MAX_STAMP_BYTES);
}

/** The first `pages` pages of a PDF, as a PDF of their own. Throws on a file pdf-lib cannot read. */
export async function firstPages(bytes: Uint8Array, pages: number): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = await PDFDocument.create();
  const count = Math.min(Math.max(1, pages), MAX_PREVIEW_PAGES, source.getPageCount());
  const copied = await out.copyPages(source, Array.from({ length: count }, (_, i) => i));
  for (const page of copied) out.addPage(page);
  const title = source.getTitle();
  out.setTitle(`${title || "Preview"} (first ${count} ${count === 1 ? "page" : "pages"})`);
  return out.save();
}

/**
 * The preview of this file at this many pages: kept, or made now. Null when
 * the file cannot have one. Never throws.
 *
 * Every Redis reply is read in its exact shape (rule 24): anything else is
 * unknown and means no preview right now, with no file read and no room taken.
 */
export async function previewCopy(file: ProductFile, pages: number, store: DataStore): Promise<ProductFile | null> {
  if (!previewable(file) || pages < 1) return null;
  const key = previewKey(file, pages);
  try {
    if (isRedisConfigured()) {
      const replies = repliesFor(await redisPipeline([["GET", key], ["GET", problemKey(file.pathname)]]), 2);
      if (!replies) throw new UnknownReplyError("a preview's record and note");
      const [kept, noted] = replies;
      if (kept !== null && typeof kept !== "string") throw new UnknownReplyError("a preview's record");
      if (noted !== null && typeof noted !== "string") throw new UnknownReplyError("a file's stamp note");
      if (typeof kept === "string") {
        try {
          return JSON.parse(kept) as ProductFile;
        } catch {}
      }
      // A PDF pdf-lib could not open is refused again by the same bytes: it is
      // not read and parsed again for every visitor. The note is per path, and
      // a new file is a new path. Only "unreadable" is trusted: a size note is
      // written for a failed read too, and the others are an EPUB's.
      if (noted === "unreadable") return null;
      // A store whose room is full makes no new preview: the file is not read
      // for one that could not be kept. Unknown is refused the same way.
      const room = await dataUsed(store);
      if (!room || room.used + PREVIEW_RECORD_BYTES + MONTH_FIELD_BYTES > contentRoomFor(store)) return null;
    }
    const original = await readFileWhole(file.pathname, MAX_STAMP_BYTES);
    if (!original) return null;
    let bytes: Uint8Array;
    try {
      bytes = await firstPages(original, pages);
    } catch (error) {
      // What it answers decides nothing: there is no preview either way.
      if (isRedisConfigured()) await redisPipeline([["SET", problemKey(file.pathname), "unreadable", "EX", UNREADABLE_SECONDS]]).catch(() => {});
      throw error;
    }
    // Room for its record only once there is a preview to keep: a failure takes none.
    if (isRedisConfigured() && !(await keepFor(store, PREVIEW_RECORD_BYTES, PREVIEW_SECONDS))) return null;
    const base = file.name.replace(/\.pdf$/i, "") || "preview";
    const name = `${base} (preview).pdf`;
    const pathname = `${copyFolder(file)}preview-${pages}-${sha(file.addedAt).slice(0, 12)}.pdf`;
    await writeFileWhole(pathname, bytes, "application/pdf");
    const copy: ProductFile = { pathname, name, bytes: bytes.byteLength, contentType: "application/pdf", addedAt: new Date().toISOString() };
    if (isRedisConfigured()) {
      const saved = repliesFor(await redisPipeline([["SET", key, JSON.stringify(copy), "EX", PREVIEW_SECONDS]]), 1);
      if (!saved || saved[0] !== "OK") throw new UnknownReplyError("keeping a preview's record");
    }
    return copy;
  } catch (error) {
    console.error("making a preview of a PDF failed", error);
    return null;
  }
}
