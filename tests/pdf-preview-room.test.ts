/**
 * A PDF preview that cannot be made takes the store's data room once, not on
 * every visit (Codex V's MEDIUM 4215; lib/pdf-preview.ts previewCopy). Room
 * for the preview's record is taken before the original is read, for the 400
 * days the record would be kept, and room for what expires by itself is never
 * given back. Before, a product whose file was missing or not a PDF pdf-lib
 * can read took 1,024 bytes more on every public request
 * (app/api/store/preview), so anyone could fill a store's room by asking for
 * its preview again and again. Now the room taken holds a note that this file
 * has no preview: an invalid PDF for as long as a preview would be kept, a
 * file that could not be read for a day, after which it is tried again.
 * Synthetic in-memory Redis and file store only.
 */
import { PDFDocument } from "pdf-lib";
import { PREVIEW_RECORD_BYTES, previewCopy } from "@/lib/pdf-preview";
import { dataUsed } from "@/lib/store-data";
import type { ProductFile } from "@/lib/product-file";
import { advance, store as redis } from "./redis-stub";
import { counts, files } from "./pdf-preview-room-files";
import { done, is, part } from "./check";

const store = { sid: "preview-room-1", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
const pdfFile = (pathname: string, bytes: number): ProductFile => ({ pathname, name: "Recipes.pdf", bytes, contentType: "application/pdf", addedAt: "2026-11-01T00:00:00.000Z" });
const used = async () => (await dataUsed(store))!.used;

async function main(): Promise<void> {
  redis.clear();
  const start = await used();

  part("A file that is not there: room taken once, not on every visit");
  const missing = pdfFile("stores/preview-room-1/missing.pdf", 2_000);
  for (let visit = 0; visit < 5; visit += 1) await previewCopy(missing, 3, store);
  const afterMissing = await used();
  is("five visits take the room of one record, no more", afterMissing - start <= PREVIEW_RECORD_BYTES + 64, true);
  is("and the file is read once", counts.reads, 1);
  is("no preview is shown", await previewCopy(missing, 3, store), null);

  part("A file pdf-lib cannot read: the same");
  const broken = pdfFile("stores/preview-room-1/broken.pdf", 12);
  files.set(broken.pathname, new TextEncoder().encode("not a pdf at all"));
  for (let visit = 0; visit < 5; visit += 1) await previewCopy(broken, 3, store);
  is("five visits take the room of one record, no more", (await used()) - afterMissing <= PREVIEW_RECORD_BYTES + 64, true);
  is("and the file is read once", counts.reads, 2);

  part("A file that could not be read is tried again the next day");
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i += 1) doc.addPage();
  const real = await doc.save();
  files.set(missing.pathname, real);
  is("not within the day", [await previewCopy(missing, 3, store), counts.reads], [null, 2]);
  advance(25 * 60 * 60 * 1000);
  const made = await previewCopy(missing, 3, store);
  is("the day after, the preview is made", [made !== null, counts.reads, counts.writes], [true, 3, 1]);
  const again = await previewCopy(missing, 3, store);
  is("and kept: shown again without reading the file", [again?.pathname, counts.reads], [made?.pathname, 3]);
  advance(25 * 60 * 60 * 1000);
  is("an invalid PDF is not tried again the next day", [await previewCopy(broken, 3, store), counts.reads], [null, 3]);

  done();
}

void main();
