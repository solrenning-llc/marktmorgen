/**
 * A buyer's EPUB, marked on download (630 [HN6](30), unit 2; added 3 November
 * 2026): the product's one marking switch (components/pdf-stamp-toggle.tsx)
 * now covers an EPUB too, and lib/pdf-stamp.ts serves the copy that
 * lib/epub-stamp.ts writes. Checked with the real code, a stubbed Redis and
 * the private file store (lib/vault.ts) answered here in memory:
 *
 *   - the switch applies to a PDF and an EPUB, never to anything else, and
 *     never when it is off;
 *   - the first download makes the marked copy, an EPUB with the buyer's
 *     line, beside the original, which is not touched; the next download of
 *     the same sale is that copy, written once;
 *   - a book under DRM, one in a form the mark does not read, a damaged one
 *     and one over the limit are handed over as uploaded, each with its own
 *     reason for the studio;
 *   - a PDF is still stamped as before;
 *   - deleting the original reaches its copies' folder for an EPUB too;
 *   - the studio, the questions and the privacy policy say what happens.
 */
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { copyFolder, dropStamped, epubProblem, stampProblems, stampedCopy, wantsStamp } from "@/lib/pdf-stamp";
import { MAX_STAMP_BYTES, type ProductFile, isEpub, isMarkable } from "@/lib/product-file";
import { stampLine } from "@/lib/pdf-stamp-line";
import { STAMP_WORDS, stampBeginnerQuestions } from "@/lib/pdf-stamp-faq";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.R2_ACCESS_KEY_ID = "1234567890123456";
process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
process.env.R2_BUCKET = "test-files";

/** The private file store, in memory: path to bytes and type, and every request it was asked. */
const kept = new Map<string, { bytes: Uint8Array; type: string }>();
const asked: { method: string; path: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith("r2.cloudflarestorage.com")) throw new Error(`unexpected request to ${url.hostname}`);
  const method = init?.method ?? "GET";
  const path = decodeURIComponent(url.pathname.replace(/^\/test-files\//, ""));
  asked.push({ method, path: url.searchParams.get("prefix") ?? path });
  if (method === "PUT") {
    const body = init?.body as Uint8Array;
    kept.set(path, { bytes: new Uint8Array(body), type: new Headers(init?.headers).get("content-type") ?? "" });
    return new Response(null, { status: 200 });
  }
  if (method === "GET" && url.searchParams.has("list-type")) return new Response("<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>");
  if (method === "GET") {
    const found = kept.get(path);
    return found ? new Response(Buffer.from(found.bytes), { status: 200, headers: { "content-length": String(found.bytes.byteLength), "content-type": found.type } }) : new Response(null, { status: 404 });
  }
  return new Response(null, { status: 204 });
}) as typeof fetch;

type File = { name: string; text: string; store?: boolean; descriptor?: boolean; flags?: number; raw?: Buffer; nameBytes?: Buffer };

function zip(files: File[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const plain = f.raw ?? Buffer.from(f.text, "utf8");
    const data = f.store ? plain : deflateRawSync(plain);
    const name = f.nameBytes ?? Buffer.from(f.name, "utf8");
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

const text = (bytes: Uint8Array, name: string): string => {
  const buf = Buffer.from(bytes);
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i += 1) {
    const n = buf.subarray(at + 46, at + 46 + buf.readUInt16LE(at + 28)).toString("utf8");
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + buf.readUInt32LE(at + 20));
    if (n === name) return (buf.readUInt16LE(at + 10) === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return "";
};

const OWNER = "owner@example.com";
const BUYER = "maya@example.com";
const sale = { reference: "cs_test_a1b2c3E54F2A", email: BUYER, paidAt: Date.UTC(2026, 10, 3) / 1000 };
const put = (path: string, bytes: Uint8Array, type: string): ProductFile => {
  kept.set(path, { bytes, type });
  return { pathname: path, name: path.split("/").pop() ?? "", bytes: bytes.byteLength, contentType: type, addedAt: "2026-11-03T12:00:00.000Z" };
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "breadhouse", "Bread House", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_EpubServe001", subscriptionId: "sub_EpubServe001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const folder = `vault/${store.statsId}/products`;

  part("What the switch applies to");
  const epub = put(`${folder}/bread.epub`, book(), "application/epub+zip");
  const zipFile: ProductFile = { pathname: `${folder}/extras.zip`, name: "extras.zip", bytes: 10, contentType: "application/zip", addedAt: "2026-11-03T12:00:00.000Z" };
  is("an EPUB by its type, or by its name when no type was measured", [isEpub(epub), isEpub({ name: "b.EPUB", contentType: "" }), isEpub({ name: "b.epub", contentType: "application/zip" })], [true, true, false]);
  is("a PDF and an EPUB, nothing else", [isMarkable({ name: "w.pdf", contentType: "application/pdf" }), isMarkable(epub), isMarkable(zipFile)], [true, true, false]);
  is("only while the product's switch is on", [wantsStamp(true, epub), wantsStamp(false, epub), wantsStamp(true, zipFile)], [true, false, false]);

  part("The first download makes the marked copy");
  const line = stampLine(BUYER, sale.reference, new Date(sale.paidAt * 1000));
  const copy = await stampedCopy(epub, sale, store);
  is("a copy, an EPUB under the same name, in the original's own folder of copies", [copy?.contentType, copy?.name, copy?.pathname.startsWith(copyFolder(epub)), copy?.pathname.endsWith("/bread.epub")], ["application/epub+zip", "bread.epub", true, true]);
  const written = kept.get(copy?.pathname ?? "");
  is("written to the private store as an EPUB, its size as written", [written?.type, written?.bytes.byteLength === copy?.bytes], ["application/epub+zip", true]);
  is("with the buyer's line inside the book: the package and every page", [text(written?.bytes ?? new Uint8Array(), "OEBPS/content.opf").includes(`<!-- ${line} -->`), text(written?.bytes ?? new Uint8Array(), "OEBPS/text/ch1.xhtml").includes(`<!-- ${line} -->`)], [true, true]);
  is("still an EPUB: mimetype first, stored, exactly", [text(written?.bytes ?? new Uint8Array(), "mimetype")], ["application/epub+zip"]);
  is("the original is not touched", Buffer.from(kept.get(epub.pathname)!.bytes).equals(Buffer.from(book())), true);

  part("The next download of the same sale is that copy");
  const puts = asked.filter((a) => a.method === "PUT").length;
  const again = await stampedCopy(epub, sale, store);
  is("the same copy, written once", [again?.pathname, asked.filter((a) => a.method === "PUT").length], [copy?.pathname, puts]);
  const other = await stampedCopy(epub, { ...sale, reference: "cs_test_z9y8x7AA11BB", email: "lee@example.com" }, store);
  is("another sale gets a copy of its own, with its own line", [other?.pathname !== copy?.pathname, text(kept.get(other?.pathname ?? "")?.bytes ?? new Uint8Array(), "OEBPS/text/ch1.xhtml").includes("lee@example.com")], [true, true]);

  part("Handed over as uploaded, with the reason");
  const drm = put(`${folder}/locked.epub`, book([{ name: "META-INF/encryption.xml", text: `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="OEBPS/text/ch1.xhtml"/></CipherData></EncryptedData></encryption>` }]), "application/epub+zip");
  const broken = put(`${folder}/broken.epub`, new Uint8Array(Buffer.from("this is not a zip at all")), "application/epub+zip");
  const huge: ProductFile = { ...epub, pathname: `${folder}/huge.epub`, name: "huge.epub", bytes: MAX_STAMP_BYTES + 1 };
  is("a book under DRM, a damaged one, one over the limit: no copy", [await stampedCopy(drm, sale, store), await stampedCopy(broken, sale, store), await stampedCopy(huge, sale, store)], [null, null, null]);
  const problems = await stampProblems([epub, drm, broken, huge, zipFile]);
  is("each with its reason for the studio, and none for the book that was marked", [problems.get(drm.pathname), problems.get(broken.pathname), problems.get(huge.pathname), problems.has(epub.pathname), problems.has(zipFile.pathname)], ["protected", "unreadable", "too_big", false, false]);
  is("the EPUB's own refusals in the studio's few reasons", (["too_big", "encrypted", "signed", "zip64", "part_too_big", "encoding", "not_epub", "unreadable"] as const).map(epubProblem), ["too_big", "protected", "protected", "unsupported", "unsupported", "unsupported", "unreadable", "unreadable"]);

  part("A PDF is still stamped as before");
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([300, 400]);
  const pdf = put(`${folder}/workbook.pdf`, await pdfDoc.save(), "application/pdf");
  const pdfCopy = await stampedCopy(pdf, sale, store);
  is("a PDF copy, written as a PDF", [pdfCopy?.contentType, kept.get(pdfCopy?.pathname ?? "")?.type], ["application/pdf", "application/pdf"]);

  part("Deleting the original reaches its copies");
  asked.length = 0;
  await dropStamped(epub);
  await dropStamped(zipFile);
  is("the EPUB's folder of copies is listed to delete them; a ZIP has none", [asked.some((a) => a.path === copyFolder(epub)), asked.some((a) => a.path === copyFolder(zipFile))], [true, false]);

  part("What the creator and the buyer are told");
  const toggle = readFileSync("components/pdf-stamp-toggle.tsx", "utf8").replace(/\s+/g, " ");
  is("the switch's words name both, from one place", [STAMP_WORDS.box, toggle.includes("{STAMP_WORDS.box}")], ["Mark each buyer's PDF or EPUB with their email", true]);
  is("it says where an EPUB's line is, and what is handed over as uploaded", [toggle.includes("An EPUB gets the same line written inside the book, where reading apps do not show it but the file the buyer downloads carries it."), toggle.includes("an EPUB with copy protection (DRM) is handed over as you uploaded it")], [true, true]);
  is("each EPUB reason has its own words", [toggle.includes('problem.reason === "protected"'), toggle.includes('problem.reason === "unsupported"')], [true, true]);
  is("the questions say it", stampBeginnerQuestions(false)[0].a.includes("An EPUB on the same product gets the same line written inside the book"), true);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("and so does the privacy policy", privacy.includes("an EPUB a buyer downloads carries the same line written inside the book, where reading apps do not show it"), true);
  is("the studio is told which problem files are EPUBs", readFileSync("app/api/store/stamp/route.ts", "utf8").includes("epub: isEpub(file)"), true);

  done();
}

void main();
