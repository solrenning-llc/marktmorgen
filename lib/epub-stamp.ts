/**
 * An invisible mark of the buyer inside the EPUB they bought (630 [HN6],
 * item 30, unit 1; added 3 November 2026): the same line a stamped PDF
 * carries (lib/pdf-stamp-line.ts, "Sold to … · order … · for personal use"),
 * put where a reader does not show it and a copy still carries it: as a
 * comment in the metadata of the book's package document (its OPF file),
 * valid in EPUB 2 and 3 with no prefix to declare, and as a comment at the
 * top of every content page. Like the PDF's line, it does not
 * stop anyone from sharing; it makes a copy say whose it was. Serving the
 * stamped copy from the download, the studio's switch and its words are the
 * next unit (lib/pdf-stamp.ts keeps one copy per sale and file; an EPUB
 * copy is kept the same way).
 *
 * An EPUB is a ZIP file. It is read and written here with Node's own zlib
 * (deflate and crc32), no library added:
 *
 *   - Every entry that does not change is copied byte for byte, compressed
 *     as it was; only the package document and the content pages are
 *     opened, marked and compressed again. "mimetype" stays first and
 *     stored, as the EPUB standard requires.
 *   - Refused, with the reason, and the file handed over as it was uploaded
 *     (as lib/pdf-stamp.ts does with a PDF it cannot write to): over
 *     MAX_EPUB_BYTES; not a ZIP, or not an EPUB (no mimetype
 *     "application/epub+zip", no container, no package document); ZIP64 or
 *     split; an entry encrypted, or a page or the package listed in
 *     META-INF/encryption.xml (a book under DRM); a page or the package
 *     larger than MAX_PART_BYTES opened; anything that does not read back as
 *     what it says (sizes, CRC).
 *   - The line is written as XML text: &, <, > and quotes escaped, and "--"
 *     never written inside a comment, so no address can break the book.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/** The largest EPUB stamped, as for a PDF (lib/product-file.ts MAX_STAMP_BYTES is 50 MB). */
export const MAX_EPUB_BYTES = 50 * 1024 * 1024;
/** The largest package document or content page opened, once inflated. */
export const MAX_PART_BYTES = 8 * 1024 * 1024;
/** The most entries an EPUB may hold to be stamped. */
export const MAX_ENTRIES = 10_000;

export type EpubProblem = "too_big" | "not_epub" | "zip64" | "encrypted" | "part_too_big" | "unreadable";
export type EpubStamp = { ok: true; bytes: Uint8Array; pages: number } | { ok: false; why: EpubProblem };

type Entry = {
  name: string;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  localOffset: number;
  extra: Uint8Array;
  comment: Uint8Array;
  external: number;
  internal: number;
  versionMade: number;
  versionNeeded: number;
};

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;

class Unreadable extends Error {}

function readEntries(buf: Buffer): Entry[] {
  // The end record is in the last 64 KB and 22 bytes (its comment is at most 65,535 bytes).
  const from = Math.max(0, buf.length - 65_557);
  let end = -1;
  for (let i = buf.length - 22; i >= from; i -= 1) if (buf.readUInt32LE(i) === END) { end = i; break; }
  if (end < 0) throw new Unreadable("not_zip");
  if (end >= 20 && buf.readUInt32LE(end - 20) === ZIP64_END_LOCATOR) throw new Error("zip64");
  const disk = buf.readUInt16LE(end + 4);
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const offset = buf.readUInt32LE(end + 16);
  if (disk !== 0 || buf.readUInt16LE(end + 6) !== 0) throw new Error("zip64");
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("zip64");
  if (count > MAX_ENTRIES || offset + size > end) throw new Unreadable("directory");
  const entries: Entry[] = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > end || buf.readUInt32LE(at) !== CENTRAL) throw new Unreadable("central");
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const entry: Entry = {
      versionMade: buf.readUInt16LE(at + 4),
      versionNeeded: buf.readUInt16LE(at + 6),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      time: buf.readUInt16LE(at + 12),
      date: buf.readUInt16LE(at + 14),
      crc: buf.readUInt32LE(at + 16),
      compressed: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      internal: buf.readUInt16LE(at + 36),
      external: buf.readUInt32LE(at + 38),
      localOffset: buf.readUInt32LE(at + 42),
      name: buf.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      extra: new Uint8Array(buf.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)),
      comment: new Uint8Array(buf.subarray(at + 46 + nameLength + extraLength, at + 46 + nameLength + extraLength + commentLength)),
    };
    if (entry.compressed === 0xffffffff || entry.size === 0xffffffff || entry.localOffset === 0xffffffff) throw new Error("zip64");
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Where an entry's data starts, read from its own local header. */
function dataStart(buf: Buffer, entry: Entry): number {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw new Unreadable("local");
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  if (start + entry.compressed > buf.length) throw new Unreadable("data");
  return start;
}

function inflate(buf: Buffer, entry: Entry): Buffer {
  if (entry.size > MAX_PART_BYTES) throw new Error("part_too_big");
  const raw = buf.subarray(dataStart(buf, entry), dataStart(buf, entry) + entry.compressed);
  let out: Buffer;
  if (entry.method === 0) out = Buffer.from(raw);
  else if (entry.method === 8) out = inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES + 1 });
  else throw new Unreadable("method");
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new Unreadable("crc");
  return out;
}

const xmlText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Inside a comment "--" may not appear, nor may it end with "-". */
const commentText = (text: string) => xmlText(text).replace(/-{2,}/g, (dashes) => dashes.split("").join(" ")).replace(/-$/, "- ");

const attribute = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);

/** The resolved path of `href` from a file at `base`. */
function resolve(base: string, href: string): string {
  const parts = base.split("/").slice(0, -1);
  for (const piece of decodeURI(href.split("#")[0]).split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

/** The EPUB with the buyer's line in its package document and on every content page, or why not. */
export function stampEpub(file: Uint8Array, line: string): EpubStamp {
  if (file.length > MAX_EPUB_BYTES) return { ok: false, why: "too_big" };
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  try {
    const entries = readEntries(buf);
    const named = new Map(entries.map((e) => [e.name, e]));
    const mimetype = named.get("mimetype");
    if (!mimetype || inflate(buf, mimetype).toString("utf8").trim() !== "application/epub+zip") return { ok: false, why: "not_epub" };
    const container = named.get("META-INF/container.xml");
    if (!container) return { ok: false, why: "not_epub" };
    const rootTag = /<rootfile\b[^>]*>/i.exec(inflate(buf, container).toString("utf8"))?.[0] ?? "";
    const opfPath = attribute(rootTag, "full-path")?.slice(2).find(Boolean) ?? "";
    const opf = named.get(opfPath);
    if (!opf) return { ok: false, why: "not_epub" };
    const opfText = inflate(buf, opf).toString("utf8");
    // The content pages: the manifest's XHTML items.
    const pages = new Set<string>();
    for (const item of opfText.match(/<item\b[^>]*>/gi) ?? []) {
      const type = attribute(item, "media-type")?.slice(2).find(Boolean) ?? "";
      const href = attribute(item, "href")?.slice(2).find(Boolean) ?? "";
      if (href && /^application\/xhtml\+xml$/i.test(type)) pages.add(resolve(opfPath, href));
    }
    // A book under DRM lists what is encrypted; one of what would be marked, or any entry flagged as encrypted, is refused.
    const encryption = named.get("META-INF/encryption.xml");
    const encrypted = new Set<string>();
    if (encryption) for (const ref of inflate(buf, encryption).toString("utf8").match(/<(?:\w+:)?CipherReference\b[^>]*>/gi) ?? []) {
      const uri = attribute(ref, "URI")?.slice(2).find(Boolean);
      if (uri) encrypted.add(resolve("", uri));
    }
    if (entries.some((e) => (e.flags & 1) === 1) || encrypted.has(opfPath) || [...pages].some((p) => encrypted.has(p))) return { ok: false, why: "encrypted" };

    const changed = new Map<string, Buffer>();
    const meta = `<!-- ${commentText(line)} -->`;
    const marked = opfText.replace(/<\/metadata\s*>/i, `${meta}</metadata>`);
    if (marked === opfText) return { ok: false, why: "not_epub" };
    changed.set(opfPath, Buffer.from(marked, "utf8"));
    let count = 0;
    for (const page of pages) {
      const entry = named.get(page);
      if (!entry) continue;
      const text = inflate(buf, entry).toString("utf8");
      // After the XML declaration, if there is one, so the page stays well-formed.
      const declaration = /^﻿?<\?xml[^>]*\?>/.exec(text)?.[0] ?? "";
      changed.set(page, Buffer.from(`${declaration}<!-- ${commentText(line)} -->${text.slice(declaration.length)}`, "utf8"));
      count += 1;
    }

    // Written again: "mimetype" first and stored, every other entry in its order, the unchanged ones copied as they were.
    const order = [mimetype, ...entries.filter((e) => e !== mimetype)];
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of order) {
      const name = Buffer.from(entry.name, "utf8");
      const fresh = changed.get(entry.name);
      const data = fresh ? deflateRawSync(fresh) : buf.subarray(dataStart(buf, entry), dataStart(buf, entry) + entry.compressed);
      const method = fresh ? 8 : entry.method;
      const crc = fresh ? crc32(fresh) : entry.crc;
      const size = fresh ? fresh.length : entry.size;
      // Sizes are always in the header: no trailing data descriptor (flag 3), and names stay UTF-8 (flag 11) as they were read.
      const flags = (entry.flags & ~0x0008) | 0x0800;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL, 0);
      local.writeUInt16LE(entry.versionNeeded, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(entry.time, 10);
      local.writeUInt16LE(entry.date, 12);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const head = Buffer.alloc(46);
      head.writeUInt32LE(CENTRAL, 0);
      head.writeUInt16LE(entry.versionMade, 4);
      head.writeUInt16LE(entry.versionNeeded, 6);
      head.writeUInt16LE(flags, 8);
      head.writeUInt16LE(method, 10);
      head.writeUInt16LE(entry.time, 12);
      head.writeUInt16LE(entry.date, 14);
      head.writeUInt32LE(crc >>> 0, 16);
      head.writeUInt32LE(data.length, 20);
      head.writeUInt32LE(size, 24);
      head.writeUInt16LE(name.length, 28);
      head.writeUInt16LE(entry.extra.length, 30);
      head.writeUInt16LE(entry.comment.length, 32);
      head.writeUInt16LE(0, 34);
      head.writeUInt16LE(entry.internal, 36);
      head.writeUInt32LE(entry.external >>> 0, 38);
      head.writeUInt32LE(offset, 42);
      parts.push(local, name, Buffer.from(data));
      central.push(head, name, Buffer.from(entry.extra), Buffer.from(entry.comment));
      offset += local.length + name.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(order.length, 8);
    end.writeUInt16LE(order.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    const out = Buffer.concat([...parts, directory, end]);
    if (out.length > 0xffffffff) return { ok: false, why: "zip64" };
    return { ok: true, bytes: new Uint8Array(out), pages: count };
  } catch (error) {
    if (error instanceof Error && error.message === "zip64") return { ok: false, why: "zip64" };
    if (error instanceof Error && error.message === "part_too_big") return { ok: false, why: "part_too_big" };
    if (error instanceof Unreadable && error.message === "not_zip") return { ok: false, why: "not_epub" };
    return { ok: false, why: "unreadable" };
  }
}
