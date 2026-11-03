/**
 * An invisible mark of the buyer inside the EPUB they bought (630 [HN6],
 * item 30, unit 1; added 3 November 2026), on synthetic books made here with
 * a small ZIP writer of the test's own.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { MAX_EPUB_BYTES, stampEpub } from "@/lib/epub-stamp";
import { stampLine } from "@/lib/pdf-stamp-line";
import { done, is, part } from "./check";

type File = { name: string; text: string; store?: boolean; descriptor?: boolean; flags?: number };

function zip(files: File[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const plain = Buffer.from(f.text, "utf8");
    const data = f.store ? plain : deflateRawSync(plain);
    const name = Buffer.from(f.name, "utf8");
    const flags = (f.flags ?? 0) | (f.descriptor ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(f.store ? 0 : 8, 8);
    // With a data descriptor the local header's sizes are zero, as many tools write them.
    local.writeUInt32LE(f.descriptor ? 0 : crc32(plain), 14); local.writeUInt32LE(f.descriptor ? 0 : data.length, 18); local.writeUInt32LE(f.descriptor ? 0 : plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    const after = f.descriptor ? (() => { const d = Buffer.alloc(16); d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc32(plain), 4); d.writeUInt32LE(data.length, 8); d.writeUInt32LE(plain.length, 12); return d; })() : Buffer.alloc(0);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(flags, 8); head.writeUInt16LE(f.store ? 0 : 8, 10);
    head.writeUInt32LE(crc32(plain), 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(plain.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, data, after);
    central.push(head, name);
    offset += local.length + name.length + data.length + after.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

/** Every entry of a ZIP, read back the plain way (central directory, then each local header). */
function unzip(bytes: Uint8Array): { names: string[]; text: (name: string) => string; methods: Record<string, number> } {
  const buf = Buffer.from(bytes);
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  const names: string[] = [];
  const methods: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(at + 10); const compressed = buf.readUInt32LE(at + 20); const crc = buf.readUInt32LE(at + 16);
    const nameLength = buf.readUInt16LE(at + 28); const extra = buf.readUInt16LE(at + 30); const comment = buf.readUInt16LE(at + 32); const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    const plain = method === 8 ? inflateRawSync(raw) : raw;
    if (crc32(plain) !== crc) throw new Error(`crc of ${name}`);
    out.set(name, plain.toString("utf8")); names.push(name); methods[name] = method;
    at += 46 + nameLength + extra + comment;
  }
  return { names, text: (name) => out.get(name) ?? "", methods };
}

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const OPF = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Bread</dc:title></metadata><manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/><item id="cover" href="cover.jpg" media-type="image/jpeg"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
const PAGE = (n: number) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch ${n}</title></head><body><p>Knead ${n}.</p></body></html>`;
const book = (more: File[] = [], opf = OPF) => zip([
  { name: "mimetype", text: "application/epub+zip", store: true },
  { name: "META-INF/container.xml", text: CONTAINER },
  { name: "OEBPS/content.opf", text: opf },
  { name: "OEBPS/text/ch1.xhtml", text: PAGE(1) },
  { name: "OEBPS/text/ch 2.xhtml", text: PAGE(2), descriptor: true },
  { name: "OEBPS/style.css", text: "p{margin:0}" },
  { name: "OEBPS/cover.jpg", text: "ÿØbinary", store: true },
  ...more,
]);
const line = stampLine("maya@example.com", "cs_test_a1b2c3E54F2A", new Date(Date.UTC(2026, 10, 3)));

part("Marked where a reader does not show it");
const done1 = stampEpub(book(), line);
if (!done1.ok) throw new Error(`not stamped: ${done1.why}`);
const read = unzip(done1.bytes);
is("every content page and the package document carry the line, as a comment", [read.text("OEBPS/text/ch1.xhtml").includes(`<!-- ${line} -->`), read.text("OEBPS/text/ch 2.xhtml").includes(`<!-- ${line} -->`), read.text("OEBPS/content.opf").includes(`<!-- ${line} --></metadata>`), done1.pages], [true, true, true, 2]);
is("after the XML declaration, so each page stays well-formed", read.text("OEBPS/text/ch1.xhtml").startsWith(`<?xml version="1.0" encoding="UTF-8"?><!-- ${line} --><html`), true);
is("and what a reader shows is unchanged", read.text("OEBPS/text/ch1.xhtml").endsWith(PAGE(1).slice(PAGE(1).indexOf("<html"))), true);

part("Still an EPUB, everything else as it was");
const original = unzip(book());
is("mimetype first and stored", [read.names[0], read.methods.mimetype, read.text("mimetype")], ["mimetype", 0, "application/epub+zip"]);
is("every entry kept, in its order, each reading back with its own CRC", read.names, original.names);
is("the unchanged ones byte for byte", ["META-INF/container.xml", "OEBPS/style.css", "OEBPS/cover.jpg"].map((n) => read.text(n) === original.text(n) && read.methods[n] === original.methods[n]), [true, true, true]);
is("stamped twice for two buyers, each copy says only its own buyer", (() => { const other = stampEpub(book(), stampLine("ben@example.com", "cs_test_zz", new Date(0))); return other.ok && !unzip(other.bytes).text("OEBPS/text/ch1.xhtml").includes("maya@example.com"); })(), true);

part("Nothing in an address can break the book");
const tricky = stampEpub(book(), "Sold to a--b<x>&\"y\"@example.com -");
is("escaped as XML text, with no \"--\" inside a comment and none at its end", tricky.ok ? [unzip(tricky.bytes).text("OEBPS/text/ch1.xhtml").includes("<!-- Sold to a- -b&lt;x&gt;&amp;&quot;y&quot;@example.com -  -->"), /<!--(?:(?!-->)[\s\S])*--(?!>)/.test(unzip(tricky.bytes).text("OEBPS/content.opf"))] : tricky, [true, false]);

part("Refused, and handed over as uploaded");
is("not a ZIP, or not an EPUB", [stampEpub(new Uint8Array([1, 2, 3]), line), stampEpub(zip([{ name: "mimetype", text: "application/zip", store: true }]), line), stampEpub(zip([{ name: "mimetype", text: "application/epub+zip", store: true }]), line)].map((r) => (r.ok ? "ok" : r.why)), ["not_epub", "not_epub", "not_epub"]);
const drm = book([{ name: "META-INF/encryption.xml", text: `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>` }]);
const fonts = book([{ name: "META-INF/encryption.xml", text: `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/font.otf"/></enc:CipherData></enc:EncryptedData></encryption>` }]);
is("a book under DRM: a page encrypted, or any entry flagged as encrypted", [stampEpub(drm, line), stampEpub(book([{ name: "OEBPS/secret.bin", text: "x", flags: 1 }]), line)].map((r) => (r.ok ? "ok" : r.why)), ["encrypted", "encrypted"]);
is("an obfuscated font alone is no reason to refuse", stampEpub(fonts, line).ok, true);
const bad = Buffer.from(book()); const at = bad.indexOf(Buffer.from("OEBPS/text/ch1.xhtml")) + 25; bad[at] ^= 0xff;
is("a part that does not read back as it says is unreadable", stampEpub(new Uint8Array(bad), line).ok, false);
const z64 = Buffer.from(book()); const endAt = z64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); z64.writeUInt16LE(0xffff, endAt + 10);
is("ZIP64 is refused", (() => { const r = stampEpub(new Uint8Array(z64), line); return r.ok ? "ok" : r.why; })(), "zip64");
is("over the size limit, refused before it is read", (() => { const r = stampEpub(new Uint8Array(MAX_EPUB_BYTES + 1), line); return r.ok ? "ok" : r.why; })(), "too_big");

done();
