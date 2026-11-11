/**
 * A buyer's stamped copy, and a PDF's preview, are new files in the store's paid storage: each is written only
 * after its bytes are reserved against the plan's storage, measured from the file stores themselves (owner rule MR:
 * a ceiling before every spend; unknown is never room). Before this, lib/pdf-stamp.ts stampedCopy and
 * lib/pdf-preview.ts previewCopy wrote their copy whatever the store held: a store at its storage kept growing by
 * up to MAX_STAMP_BYTES a sale, kept for as long as the original, a cost no plan's storage line priced.
 *
 * A store without room, or whose storage cannot be measured, still hands the buyer the file they paid for, as
 * uploaded: only the stamped copy (or the preview) is not made, and the studio is told why.
 *
 * Vercel Blob is stood in for in memory (tests/stamped-drop-retry-world.ts); Redis is the repository's in-memory
 * stand-in (tests/redis-stub.ts); every file and address is synthetic.
 */
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { previewCopy } from "@/lib/pdf-preview";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import type { ProductFile } from "@/lib/product-file";
import * as world from "./stamped-drop-retry-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const PENDING = `nl:storage:pending:${FOLDER}`;
const BRAKE = PAID_STORAGE_BYTES.creator;
const shop = { sid: "stamped-copy-storage", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };

let n = 0;
async function original(name = "Workbook.pdf", pages = 3): Promise<ProductFile> {
  n += 1;
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([300, 400]);
  const bytes = await doc.save();
  const pathname = `stores/${FOLDER}/${String(n).padStart(10, "0")}/${name}`;
  world.files.set(pathname, bytes);
  return { pathname, name, bytes: bytes.byteLength, contentType: "application/pdf", addedAt: `2026-11-11T12:00:0${n % 10}.000Z` };
}
const sale = (i: number) => ({ reference: `cs_test_s7O4r2A${String(i).padStart(5, "0")}`, email: `buyer${i}@example.com`, paidAt: Date.UTC(2026, 10, 11) / 1000 });
const copies = (file: ProductFile) => [...world.files.keys()].filter((pathname) => pathname.startsWith(stamp.copyFolder(file)));
/** The store's folder listed as holding `bytes` already, for the next listing only. */
const holding = (bytes: number) => world.pages.push({ blobs: [{ pathname: `stores/${FOLDER}/0000000000/Big.zip`, size: bytes }], hasMore: false });
const pending = async () => (await redis.pipeline([["GET", PENDING]]))[0];

async function main() {
  const errors: string[] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  part("Control: a store with room gets the buyer's stamped copy, and nothing stays reserved");
  const roomy = await original();
  const made = await stamp.stampedCopy(roomy, sale(1), shop);
  is("the copy is made and kept", [Boolean(made), made ? world.files.has(made.pathname) : false], [true, true]);
  is("the reservation is gone once the copy is written (the copy itself is now measured)", [null, "[]"].includes(await pending() as string | null), true);
  world.pages.length = 0;

  part("A store already at its plan's storage gets no new stamped copy: the buyer gets the file as uploaded");
  const full = await original("Ledger.pdf");
  holding(BRAKE);
  const refused = await stamp.stampedCopy(full, sale(2), shop);
  is("no copy is handed over", refused, null);
  is("and no copy is written to the file store", copies(full), []);
  is("the studio is told it is the storage", (await stamp.stampProblems([full])).get(full.pathname), "storage");
  world.pages.length = 0;

  part("While the store is noted full, a later download does not measure the store again");
  const listedBefore = world.listed.length;
  is("the next sale is handed the file as uploaded", await stamp.stampedCopy(full, sale(3), shop), null);
  is("without another listing of the store", world.listed.length, listedBefore);
  is("and still nothing is written", copies(full), []);

  part("A storage that cannot be measured is no room");
  const unknown = await original("Unknown.pdf");
  world.pages.push(null);
  is("no copy is handed over", await stamp.stampedCopy(unknown, sale(4), shop), null);
  is("and none is written", copies(unknown), []);
  world.pages.length = 0;

  part("Room another upload already reserved is not room");
  const crowded = await original("Crowded.pdf");
  await redis.pipeline([["SET", PENDING, JSON.stringify([{ id: "f".repeat(32), bytes: BRAKE - 1_000, at: Date.now() }])]]);
  is("no copy is handed over", await stamp.stampedCopy(crowded, sale(5), shop), null);
  is("and none is written", copies(crowded), []);
  is("the other upload's reservation is left as it was", JSON.parse(String(await pending())).length, 1);
  await redis.pipeline([["DEL", PENDING]]);

  part("A PDF's preview is a new file too: made only within the store's storage");
  const previewed = await original("Preview-me.pdf", 4);
  holding(BRAKE);
  is("a full store gets no preview made", await previewCopy(previewed, 2, shop), null);
  is("and none is written", copies(previewed), []);
  world.pages.length = 0;
  const preview = await previewCopy(previewed, 2, shop);
  is("control: with room, the preview is made and kept", [Boolean(preview), preview ? world.files.has(preview.pathname) : false], [true, true]);
  is("and nothing stays reserved", [null, "[]"].includes(await pending() as string | null), true);

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
