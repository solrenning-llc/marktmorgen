/**
 * A buyer's EPUB handed over with their invisible mark, through the same path
 * a stamped PDF takes (630 [HN6] item 30, unit 2; added 3 November 2026):
 * the product's switch, one copy per sale and file kept beside the original
 * and reused, the reason a book is handed over unmarked noted for the studio,
 * and the copies deleted with the file they were made from.
 *
 * The file store is the one that charges nothing for a download
 * (lib/vault.ts), stood in for by a small S3 of the test's own; the books are
 * synthetic, made here. What no test here holds is a real reading app: that
 * the mark stays hidden in Apple Books, Kindle's converter and the others is
 * for a real book on real devices.
 */
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { stampEpub } from "@/lib/epub-stamp";
import { stampLine } from "@/lib/pdf-stamp-line";
import { copyFolder, dropStamped, epubProblem, stampProblems, stampedCopy, wantsStamp } from "@/lib/pdf-stamp";
import { MAX_STAMP_BYTES, type ProductFile, isEpub, isPdf, isStampable } from "@/lib/product-file";
import { done, is, part } from "./check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "sold-files";
const ORIGIN = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const FOLDER = "0123456789abcdef0123456789abcdef";

const objects = new Map<string, { bytes: Uint8Array; type: string }>();
let puts = 0;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin !== ORIGIN || !url.pathname.startsWith(`/${BUCKET}`)) return new Response(null, { status: 404 });
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const key = url.pathname.slice(BUCKET.length + 2);
  if (!key) {
    const prefix = url.searchParams.get("prefix") ?? "";
    const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    return xml(`<ListBucketResult><IsTruncated>false</IsTruncated>${all.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.bytes.byteLength}</Size></Contents>`).join("")}</ListBucketResult>`);
  }
  if (method === "PUT") {
    puts += 1;
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(init?.body as ArrayBuffer);
    objects.set(key, { bytes: new Uint8Array(body), type: headers["content-type"] ?? headers["Content-Type"] ?? "" });
    return new Response(null, { status: 200, headers: { ETag: `"${md5(body)}"` } });
  }
  if (method === "DELETE") {
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  const found = objects.get(key);
  if (!found) return method === "HEAD" ? new Response(null, { status: 404 }) : xml("<Error><Code>NoSuchKey</Code></Error>", 404);
  const about = { "content-length": String(found.bytes.byteLength), "content-type": found.type };
  if (method === "HEAD") return new Response(null, { status: 200, headers: about });
  if (method === "POST" && url.searchParams.has("delete")) {
    const keys = [...new TextDecoder().decode(init?.body as Uint8Array).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    for (const k of keys) objects.delete(k);
    return xml(`<DeleteResult>${keys.map((k) => `<Deleted><Key>${k}</Key></Deleted>`).join("")}</DeleteResult>`);
  }
  return new Response(found.bytes as BodyInit, { status: 200, headers: about });
}) as typeof fetch;

for (const [name, value] of [
  ["R2_ACCOUNT_ID", ACCOUNT],
  ["R2_ACCESS_KEY_ID", "a-stand-in-access-key-id"],
  ["R2_SECRET_ACCESS_KEY", "a-stand-in-secret-access-key-for-tests-only"],
  ["R2_BUCKET", BUCKET],
]) process.env[name] = value;

/** A ZIP of stored (uncompressed) entries, which is all an EPUB needs to be. */
function zip(files: { name: string; text: string; deflate?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const plain = Buffer.from(f.text, "utf8");
    const data = f.deflate ? deflateRawSync(plain) : plain;
    const name = Buffer.from(f.name, "utf8");
    const method = f.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(plain), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc32(plain), 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(plain.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(head, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const OPF = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">book</dc:identifier><dc:title>A Guide</dc:title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
const PAGE = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><p>Chapter one.</p></body></html>`;
const book = (extra: { name: string; text: string }[] = []) =>
  zip([{ name: "mimetype", text: "application/epub+zip" }, { name: "META-INF/container.xml", text: CONTAINER }, ...extra, { name: "OEBPS/content.opf", text: OPF, deflate: true }, { name: "OEBPS/chapter.xhtml", text: PAGE, deflate: true }]);

let n = 0;
function put(name: string, bytes: Uint8Array, contentType = "application/epub+zip"): ProductFile {
  n += 1;
  const pathname = `vault/${FOLDER}/${String(n).padStart(10, "0")}/${name}`;
  objects.set(pathname, { bytes, type: contentType });
  return { pathname, name, bytes: bytes.byteLength, contentType, addedAt: `2026-11-03T12:00:0${n}.000Z` };
}

const store = { sid: "epub-stamp-download", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
const sale = { reference: "cs_test_a1B2c3D4e5F6", email: "maya@example.com", paidAt: Date.UTC(2026, 10, 3) / 1000 };

async function main() {
  part("Which files the switch covers");
  const pdf: ProductFile = { pathname: "x", name: "Guide.pdf", bytes: 1, contentType: "application/pdf", addedAt: "" };
  const epub: ProductFile = { pathname: "y", name: "Guide.epub", bytes: 1, contentType: "application/epub+zip", addedAt: "" };
  const zipped: ProductFile = { pathname: "z", name: "Pack.zip", bytes: 1, contentType: "application/zip", addedAt: "" };
  is("an EPUB is an EPUB by its measured type, or by its name when no type was measured", [isEpub(epub), isEpub({ name: "Book.EPUB", contentType: "" }), isEpub({ name: "Book.epub", contentType: "application/zip" }), isEpub(pdf)], [true, true, false, false]);
  is("stamping covers a PDF and an EPUB, nothing else", [isStampable(pdf), isStampable(epub), isStampable(zipped)], [true, true, false]);
  is("with the switch on, a PDF and an EPUB are stamped; off, neither; a ZIP never", [wantsStamp(true, pdf), wantsStamp(true, epub), wantsStamp(false, epub), wantsStamp(true, zipped)], [true, true, false, false]);
  is("the largest EPUB stamped is the largest PDF's", MAX_STAMP_BYTES, 50 * 1024 * 1024);

  part("The buyer's copy");
  const original = book();
  const file = put("A-Guide.epub", original);
  const copy = await stampedCopy(file, sale, store);
  const line = stampLine(sale.email, sale.reference, new Date(sale.paidAt * 1000));
  const expected = stampEpub(original, line);
  is("a copy is made", copy !== null && expected.ok, true);
  is("kept as an EPUB, under the creator's name for it, in the folder of copies beside the original", [copy?.contentType, copy?.name, copy?.pathname.startsWith(copyFolder(file)), copy?.pathname.endsWith("/A-Guide.epub")], ["application/epub+zip", "A-Guide.epub", true, true]);
  const kept = objects.get(copy?.pathname ?? "");
  is("what is kept is the book with the buyer's line, its type stored with it", [kept?.type, kept && expected.ok ? md5(kept.bytes) === md5(expected.bytes) : false, copy?.bytes === kept?.bytes.byteLength], ["application/epub+zip", true, true]);
  is("the original is left as it was uploaded", md5(objects.get(file.pathname)!.bytes), md5(original));
  const written = puts;
  const again = await stampedCopy(file, sale, store);
  is("a second download of the same sale gets the same copy, with nothing stamped or written again", [again?.pathname, puts], [copy?.pathname, written]);
  const other = await stampedCopy(file, { ...sale, reference: "cs_test_z9Y8x7W6v5U4", email: "sam@example.com" }, store);
  is("another sale gets a copy of its own", [Boolean(other), other?.pathname !== copy?.pathname], [true, true]);
  is("no copy without an order or an address to mark", [await stampedCopy(file, { ...sale, reference: "" }, store), await stampedCopy(file, { ...sale, email: "" }, store)], [null, null]);
  is("and a file that is neither PDF nor EPUB is never touched", await stampedCopy({ ...file, name: "Pack.zip", contentType: "application/zip" }, sale, store), null);

  part("A book handed over unmarked, and the reason kept for the studio");
  const signed = put("Signed.epub", book([{ name: "META-INF/signatures.xml", text: "<signatures/>" }]));
  const locked = put("Locked.epub", book([{ name: "META-INF/encryption.xml", text: `<encryption><EncryptedData><CipherData><CipherReference URI="OEBPS/chapter.xhtml"/></CipherData></EncryptedData></encryption>` }]));
  const broken = put("Broken.epub", new TextEncoder().encode("not a zip at all"));
  const huge: ProductFile = { ...put("Huge.epub", original), bytes: MAX_STAMP_BYTES + 1 };
  is("each is handed over as uploaded", [await stampedCopy(signed, sale, store), await stampedCopy(locked, sale, store), await stampedCopy(broken, sale, store), await stampedCopy(huge, sale, store)], [null, null, null, null]);
  const notes = await stampProblems([file, signed, locked, broken, huge]);
  is("and the studio is told which, and why", [notes.get(file.pathname), notes.get(signed.pathname), notes.get(locked.pathname), notes.get(broken.pathname), notes.get(huge.pathname)], [undefined, "signed", "encrypted", "unreadable", "too_big"]);
  is("an EPUB's other reasons read as one the studio explains", [epubProblem("not_epub"), epubProblem("zip64"), epubProblem("part_too_big"), epubProblem("encoding"), epubProblem("unreadable"), epubProblem("too_big")], ["unreadable", "unreadable", "unreadable", "unreadable", "unreadable", "too_big"]);

  part("Deleting the file deletes its copies");
  await dropStamped(file);
  is("no copy of the deleted file is left", [...objects.keys()].filter((k) => k.startsWith(copyFolder(file))), []);
  is("the other files' originals stay", objects.has(signed.pathname), true);
  is("a PDF is still a PDF to the same switch", isPdf(pdf) && wantsStamp(true, pdf), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
