/**
 * A buyer's stamped copy that is already in the file store is handed over again, never stamped again (#4237, item 3;
 * Claude 1's storage and media cost audit).
 *
 * stampedCopy (lib/pdf-stamp.ts) keeps a record of the copy it made only while the store's data room has space for it
 * (keepFor). Without that record every later download of the same sale read the whole original again (up to
 * MAX_STAMP_BYTES), stamped it and wrote it over the same path, although the copy was already there: its path is made
 * from the sale and the file alone. Now, with no record, the copy's own path is asked about first (one HEAD); a copy
 * found there is handed over as it is, and only a missing one is made again.
 *
 * Vercel Blob in memory (tests/stamped-drop-retry-world.ts), in-memory Redis. Nothing real is reached.
 */
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import type { ProductFile } from "@/lib/product-file";
import * as world from "./stamped-drop-retry-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "fedcba9876543210fedcba9876543210";

async function pdfFile(name: string, at: string): Promise<ProductFile> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const pdf = await doc.save();
  const pathname = `stores/${FOLDER}/${name.replace(/\W/g, "")}/${name}`;
  world.files.set(pathname, pdf);
  return { pathname, name, bytes: pdf.byteLength, contentType: "application/pdf", addedAt: at };
}

async function main(): Promise<void> {
  redis.clear();
  const shop = { sid: "stamp-reuse", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
  const sale = { reference: "cs_test_k2Q4w6E8r0T1", email: "lee@example.com", paidAt: Date.UTC(2026, 10, 8) / 1000 };

  part("Its record not kept: the copy already made is handed over again, the original never read again");
  const file = await pdfFile("Planner.pdf", "2026-11-08T12:00:01.000Z");
  const first = await stamp.stampedCopy(file, sale, shop);
  is("the first download makes the copy", [Boolean(first), first ? world.files.has(first.pathname) : false], [true, true]);
  const made = first ? world.files.get(first.pathname) : undefined;
  // As when the store's data room had no space for the record (keepFor refused), or the record expired.
  await redis.pipeline([["DEL", stamp.copyKey(sale.reference, file)]]);
  // The original is taken away, so a download that read it again would hand over nothing stamped.
  world.files.delete(file.pathname);
  const again = await stamp.stampedCopy(file, sale, shop);
  is("the next download hands over the same copy", again?.pathname, first?.pathname);
  is("as it is, not written again", first ? world.files.get(first.pathname) === made : false, true);
  is("with its size and kind", [again?.bytes, again?.contentType, again?.name], [made?.byteLength, "application/pdf", "Planner.pdf"]);

  part("Control: a copy that is gone is made again from the original");
  const other = await pdfFile("Journal.pdf", "2026-11-08T12:00:02.000Z");
  const once = await stamp.stampedCopy(other, sale, shop);
  if (once) world.files.delete(once.pathname);
  await redis.pipeline([["DEL", stamp.copyKey(sale.reference, other)]]);
  const remade = await stamp.stampedCopy(other, sale, shop);
  is("stamped again at its path", [remade?.pathname, remade ? world.files.has(remade.pathname) : false], [once?.pathname, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
