/**
 * R30 (uploads, parsing a creator's PDF for strangers): GET /api/store/preview
 * (app/api/store/preview/route.ts) makes the first pages of a product's PDF for any visitor, through
 * previewCopy (lib/pdf-preview.ts). For a PDF pdf-lib cannot open (one with an owner password, which
 * many sold ebooks carry, or a damaged one), it used to take PREVIEW_RECORD_BYTES of the store's data
 * room for 400 days BEFORE reading the file, give nothing back when the preview failed and note nothing,
 * so every visitor request read the whole PDF again (up to MAX_STAMP_BYTES, 50 MB), parsed it again and
 * took another kilobyte of the store's data room, until the room was full.
 *
 * Held here:
 *   - a PDF pdf-lib cannot open is read and parsed once, takes nothing from the data room, and is noted
 *     as "unreadable" in lib/pdf-stamp.ts's note (the studio shows it), so later requests return at once;
 *   - a readable PDF still gets its preview, taking one record once and reading the file once;
 *   - a store whose data room is full does not read the file at all;
 *   - every Redis reply on that path is read in its exact shape (rule 24): an unknown one is refused,
 *     with no file read and no room taken.
 * Synthetic stores, synthetic PDFs made with pdf-lib, an in-memory file store, the Redis stub.
 */
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { addProduct, claimHandle, ensureStatsId, setProductFile, setProductPreview, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { dataUsed, noteData } from "@/lib/store-data";
import { problemKey, stampProblems } from "@/lib/pdf-stamp";
import type { ProductFile } from "@/lib/product-file";
import { previewKey } from "@/lib/pdf-preview";
import { GET } from "@/app/api/store/preview/route";
import { store as redis } from "./redis-stub";
import { files, reads as blobReads } from "./r30-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "r30.preview@example.com";
const HANDLE = "r30preview";

async function readablePdf(pages = 4): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([300, 400]);
  return doc.save({ useObjectStreams: false });
}

async function encryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i += 1) doc.addPage([300, 400]);
  // An /Encrypt entry in the trailer, as an owner-password PDF has: pdf-lib refuses to open it.
  const encrypt = doc.context.obj({ Filter: "Standard", V: 2, R: 3, Length: 128, P: -3904, O: "x".repeat(32), U: "y".repeat(32) });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  return doc.save({ useObjectStreams: false });
}

let made = 0;
async function product(name: string, pdf: Uint8Array): Promise<{ id: string; file: ProductFile }> {
  const added = await addProduct(OWNER, name, `${name}, synthetic`, "12");
  if (!added.ok) throw new Error(`product: ${JSON.stringify(added)}`);
  const id = added.product.id;
  const folder = await storeFolder(OWNER);
  made += 1;
  const pathname = `stores/${folder}/${id}/book-${made}.pdf`;
  files.set(pathname, { bytes: pdf, contentType: "application/pdf" });
  const file: ProductFile = { pathname, name: `book-${made}.pdf`, bytes: pdf.byteLength, contentType: "application/pdf", addedAt: "2026-11-01T00:00:00.000Z" };
  const set = await setProductFile(OWNER, id, file);
  if (!set.ok) throw new Error(`file: ${JSON.stringify(set)}`);
  const pv = await setProductPreview(OWNER, id, 3);
  if (!pv.ok) throw new Error(`preview: ${JSON.stringify(pv)}`);
  return { id, file };
}

let address = 0;
async function ask(id: string): Promise<number> {
  address += 1;
  const response = await GET(new NextRequest(`https://marktmorgen.com/api/store/preview?handle=${HANDLE}&product=${id}`, { headers: { "x-forwarded-for": `203.0.113.${1 + (address % 200)}` } }));
  return response.status;
}

/** Replaces the replies of the pipelines `which` picks, for the requests inside `run`; counts the picks. */
async function tampered<T>(which: (commands: (string | number)[][]) => boolean, reply: (real: unknown[]) => unknown, run: () => Promise<T>): Promise<{ result: T; picked: number }> {
  const real = redis.pipeline;
  let picked = 0;
  redis.pipeline = async (commands) => {
    const out = await real(commands);
    if (!which(commands)) return out;
    picked += 1;
    return reply(out) as unknown[];
  };
  try {
    return { result: await run(), picked };
  } finally {
    redis.pipeline = real;
  }
}

/** The pipeline previewCopy opens with: its record and the file's note, read together. */
const isPreviewRead = (commands: (string | number)[][]) => commands.length === 2 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:preview:") && commands[1][0] === "GET" && String(commands[1][1]).startsWith("nl:stamp:problem:");

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, HANDLE, "R30 Preview", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1R30Preview01", true);
  await setSubscription(OWNER, { customerId: "cus_R30Preview", subscriptionId: "sub_R30Preview", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const used = async () => (await dataUsed(store))!.used;

  part("A stranger asks for the preview of a product whose PDF pdf-lib cannot open");
  const locked = await product("Locked ebook", await encryptedPdf());
  const before = await used();
  const N = 60;
  const statuses = new Map<number, number>();
  for (let i = 0; i < N; i += 1) {
    const status = await ask(locked.id);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
  const grown = (await used()) - before;
  const reads = blobReads.get(locked.file.pathname) ?? 0;
  console.log(`        ${N} requests: statuses ${JSON.stringify([...statuses])}; data room +${grown} bytes; whole-PDF reads ${reads}`);
  is("every request answered 'no preview right now'", statuses.get(404), N);
  is("a failed preview takes nothing from the store's data room", grown, 0);
  is("the same unreadable PDF is read and parsed once, not on every request", reads, 1);
  is("the file is noted as unreadable in the stamp's note, which costs no data room", await redis.pipeline([["GET", problemKey(locked.file.pathname)]]), ["unreadable"]);
  is("the studio's stamp notes say why (lib/pdf-stamp.ts stampProblems)", (await stampProblems([locked.file])).get(locked.file.pathname), "unreadable");

  part("A readable PDF keeps its preview (healthy control)");
  const book = await product("Readable ebook", await readablePdf());
  const roomBefore = await used();
  is("the first request is served", await ask(book.id), 200);
  const took = (await used()) - roomBefore;
  is("its record takes one record's room, once (1,024 bytes and the month's own field at most)", took >= 1_024 && took <= 1_024 + 64, true);
  is("the first request reads the PDF once", blobReads.get(book.file.pathname), 1);
  is("the second request is served from the kept preview", await ask(book.id), 200);
  is("without reading the PDF again", blobReads.get(book.file.pathname), 1);
  is("or taking more room", (await used()) - roomBefore, took);

  part("Every reply on the preview's path is read in its exact shape (rule 24)");
  const fresh = await product("Fresh ebook", await readablePdf());
  const roomFresh = await used();
  const shapes: [string, (real: unknown[]) => unknown][] = [
    ["no list", () => undefined],
    ["a short list", () => [null]],
    ["an extra reply", (real) => [...real, "extra"]],
    ["a hole", () => { const holed = new Array(2); holed[1] = null; return holed; }],
    ["a number for the record", (real) => [1, real[1]]],
    ["an object for the record", (real) => [{}, real[1]]],
    ["a number for the note", (real) => [real[0], 0]],
    ["a list for the note", (real) => [real[0], ["unreadable"]]],
    ["true for the note", (real) => [real[0], true]],
  ];
  for (const [name, reply] of shapes) {
    const { result, picked } = await tampered(isPreviewRead, reply, () => ask(fresh.id));
    is(`${name}: refused as no preview right now, the path reached once`, [result, picked], [404, 1]);
  }
  is("no unknown reply read the PDF", blobReads.get(fresh.file.pathname) ?? 0, 0);
  is("or took any room", (await used()) - roomFresh, 0);
  const room = await tampered((commands) => commands.length === 1 && commands[0][0] === "HMGET" && commands[0][2] === "#", () => [["x", null]], () => ask(fresh.id));
  is("an unknown count of the store's room is refused before the PDF is read", [room.result, room.picked >= 1, blobReads.get(fresh.file.pathname) ?? 0], [404, true, 0]);
  const record = await tampered((commands) => commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:preview:"), () => ["QUEUED"], () => ask(fresh.id));
  is("an unknown answer to keeping the record is not taken as kept", [record.result, record.picked], [404, 1]);
  // The stub ran that SET before its answer was replaced, so the record is there: the next request is served from it.
  is("with no unknown reply, the same product is served (control)", await ask(fresh.id), 200);
  is("from the record, without reading the PDF again", [await ask(fresh.id), blobReads.get(fresh.file.pathname)], [200, 1]);
  const noted = await product("Noted ebook", await readablePdf());
  for (const value of ["too_big", "signed", "encrypted"]) {
    await redis.pipeline([["SET", problemKey(noted.file.pathname), value, "EX", 60]]);
    is(`a stamp note "${value}" does not hide a readable PDF's preview`, await ask(noted.id), 200);
    await redis.pipeline([["DEL", previewKey(noted.file, 3)]]);
  }

  part("A store whose data room is full does not read the PDF for a preview it cannot keep");
  const full = await product("Full-room ebook", await readablePdf());
  const left = (await dataUsed(store))!;
  await noteData(store, [{ slot: "r30-fill", bytes: left.room }]);
  is("no preview right now", await ask(full.id), 404);
  is("and the PDF is not read", blobReads.get(full.file.pathname) ?? 0, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
