/**
 * Board #5285, row #3351: the LOW of 6735389647 (an earlier Claude 2 session; repeated by Claude 1 in 6799136492,
 * kept by the Claude 2 family in 7098425462). previewCopy (lib/pdf-preview.ts) noted a file "unreadable" for 60 days on
 * ANY throw of firstPages, so one passing failure (the function short of memory or time) turned a good PDF's preview
 * off for 60 days. Now a first failure only notes "unreadable-once:<when>" (kept 60 days), and no new parse is tried
 * for an hour after it; a failure after that hour notes "unreadable" for 60 days, as before, and a success makes the
 * preview. The cost guard holds: at most two parses before a file is refused for 60 days. The stamp (lib/pdf-stamp.ts)
 * reads only its own exact notes, so "unreadable-once" changes nothing it does.
 * Synthetic store, synthetic PDFs made with pdf-lib, an in-memory file store, the Redis stub.
 */
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { addProduct, claimHandle, ensureStatsId, setProductFile, setProductPreview, setStripeAccount, setSubscription, storeFolder } from "@/lib/store";
import { problemKey, stampProblems } from "@/lib/pdf-stamp";
import type { ProductFile } from "@/lib/product-file";
import { GET } from "@/app/api/store/preview/route";
import { store as redis } from "./redis-stub";
import { files, reads as blobReads } from "./r30-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "second.failure@example.com";
const HANDLE = "secondfail";
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

async function readablePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i += 1) doc.addPage([300, 400]);
  return doc.save({ useObjectStreams: false });
}
async function encryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i += 1) doc.addPage([300, 400]);
  const encrypt = doc.context.obj({ Filter: "Standard", V: 2, R: 3, Length: 128, P: -3904, O: "x".repeat(32), U: "y".repeat(32) });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  return doc.save({ useObjectStreams: false });
}

let made = 0;
async function product(name: string, pdf: Uint8Array): Promise<{ id: string; file: ProductFile }> {
  const added = await addProduct(OWNER, name, `${name}, synthetic`, "12");
  if (!added.ok) throw new Error(`product: ${JSON.stringify(added)}`);
  const id = added.product.id;
  made += 1;
  const pathname = `stores/${await storeFolder(OWNER)}/${id}/book-${made}.pdf`;
  files.set(pathname, { bytes: pdf, contentType: "application/pdf" });
  const file: ProductFile = { pathname, name: `book-${made}.pdf`, bytes: pdf.byteLength, contentType: "application/pdf", addedAt: "2026-11-01T00:00:00.000Z" };
  if (!(await setProductFile(OWNER, id, file)).ok || !(await setProductPreview(OWNER, id, 3)).ok) throw new Error("product file");
  return { id, file };
}
let address = 0;
async function ask(id: string): Promise<number> {
  address += 1;
  return (await GET(new NextRequest(`https://marktmorgen.com/api/store/preview?handle=${HANDLE}&product=${id}`, { headers: { "x-forwarded-for": `198.51.100.${1 + (address % 200)}` } }))).status;
}
const note = async (file: ProductFile) => (await redis.pipeline([["GET", problemKey(file.pathname)]]))[0];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, HANDLE, "Second Failure", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1SecondFail01", true);
  await setSubscription(OWNER, { customerId: "cus_SecondFail", subscriptionId: "sub_SecondFail", active: true, period: paidPeriod() });
  const quiet = console.error;
  console.error = () => {};
  try {
    part("One passing failure never turns a good PDF's preview off for 60 days");
    const good = await product("Good ebook", await encryptedPdf());
    is("the first failure answers no preview now", await ask(good.id), 404);
    is("and notes it once, not unreadable", String(await note(good.file)).startsWith("unreadable-once:"), true);
    is("the stamp reads nothing from that note", (await stampProblems([good.file])).get(good.file.pathname) ?? null, null);
    is("within the hour, no new parse is tried", [await ask(good.id), blobReads.get(good.file.pathname)], [404, 1]);
    files.set(good.file.pathname, { bytes: await readablePdf(), contentType: "application/pdf" });
    shift = 3_600_000 + 1_000;
    is("an hour on, the same path parses: the preview is made", [await ask(good.id), blobReads.get(good.file.pathname)], [200, 2]);

    // Claude 3 vyDE's LEVE on #5360: the success proves the PDF good, so it clears its once-note; a later passing failure
    // on the same path (its preview pages changed, or no preview was kept for room) is a first failure again, never
    // "unreadable" for 60 days at once.
    part("A success clears the once-note: a later passing failure is a first one again");
    is("the success removed the once-note", await note(good.file), null);
    if (!(await setProductPreview(OWNER, good.id, 4)).ok) throw new Error("preview pages");
    files.set(good.file.pathname, { bytes: await encryptedPdf(), contentType: "application/pdf" });
    shift = 10 * 86_400_000;
    is("ten days on, 4 preview pages, one passing failure: no preview now", await ask(good.id), 404);
    is("noted once again, not unreadable for 60 days", String(await note(good.file)).startsWith("unreadable-once:"), true);
    files.set(good.file.pathname, { bytes: await readablePdf(), contentType: "application/pdf" });
    shift = 10 * 86_400_000 + 3_600_000 + 1_000;
    is("an hour later the good PDF makes its preview", await ask(good.id), 200);

    part("A note written meanwhile is kept: only the once-note read is cleared");
    shift = 0;
    const raced = await product("Raced ebook", await encryptedPdf());
    await ask(raced.id);
    files.set(raced.file.pathname, { bytes: await readablePdf(), contentType: "application/pdf" });
    shift = 3_600_000 + 1_000;
    const pipe = redis.pipeline.bind(redis);
    let swapped = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      // Just before the clear, another writer puts a stamp note of its own on the same path.
      if (!swapped && commands.some((c) => c[0] === "EVAL" && c.includes(problemKey(raced.file.pathname)))) {
        swapped = true;
        await pipe([["SET", problemKey(raced.file.pathname), "unreadable"]]);
      }
      return pipe(commands);
    }) as typeof redis.pipeline;
    await ask(raced.id);
    redis.pipeline = pipe;
    is("the clear ran, and the note written meanwhile stays", [swapped, await note(raced.file)], [true, "unreadable"]);

    part("Two failures an hour apart: unreadable for 60 days, as before");
    shift = 0;
    const bad = await product("Locked ebook", await encryptedPdf());
    await ask(bad.id);
    shift = 3_600_000 + 1_000;
    is("the second failure answers no preview", await ask(bad.id), 404);
    is("and notes the file unreadable", await note(bad.file), "unreadable");
    is("which the studio's stamp notes show", (await stampProblems([bad.file])).get(bad.file.pathname), "unreadable");
    shift = 2 * 3_600_000;
    is("later requests read it no more: two parses in all", [await ask(bad.id), blobReads.get(bad.file.pathname)], [404, 2]);

    // Claude 2 lpgvy's LEVE on #5360: the once-note outlives the hour, so a PDF asked again hours later is on its second
    // failure, never a first again (else it would be parsed every few hours for 60 days).
    part("Asked again three hours after its first failure: the second failure, unreadable");
    shift = 0;
    const late = await product("Late ebook", await encryptedPdf());
    await ask(late.id);
    shift = 3 * 3_600_000;
    is("three hours on it fails again: noted unreadable for 60 days", [await ask(late.id), await note(late.file)], [404, "unreadable"]);
    shift = 9 * 3_600_000;
    is("and read no more: two parses in all", [await ask(late.id), blobReads.get(late.file.pathname)], [404, 2]);
  } finally {
    console.error = quiet;
    Date.now = realNow;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
