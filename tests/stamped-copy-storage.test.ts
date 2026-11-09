/**
 * A stamped copy takes its bytes from the store's storage before it is written (audit R17, finding 1).
 *
 * A stamped PDF or EPUB (lib/pdf-stamp.ts, stampedCopy) is a new file in the paid file store, up to MAX_STAMP_BYTES
 * (50 MB), one per sale and file, kept until the original leaves the product. Before this, nothing checked it against
 * the plan's storage: a store whose storage was full grew by one copy per order, past the plan's storage line
 * (tests/plan-cost-registry.ts, "storage": the plan's storage, all used), with no ceiling taken first (owner's margin
 * rule, MR). Now the copy's bytes are reserved in the store's storage (lib/storage-reservations.ts, the reservation the
 * vault uploads use) against the plan's figure, measured exactly (lib/storage-quota.ts); with no room, a measure that
 * is not known (CX-123 rule 24: unknown never fits), or a store whose renewal is unpaid, nothing is written and the
 * buyer gets the original file, as the code already does when a copy cannot be made.
 *
 * Vercel Blob is stood in for in memory (tests/stamped-copy-storage-world.ts), with synthetic sizes for a full store;
 * Redis is the repository's in-memory stand-in (tests/redis-stub.ts, with tests/storage-reservation-scripts.ts); every
 * store, file and address is synthetic. No provider is called.
 */
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { stampLine } from "@/lib/pdf-stamp-line";
import { storageBrakeFor, storageUsed } from "@/lib/storage-quota";
import { standingOf } from "@/lib/plan-standing";
import type { ProductFile } from "@/lib/product-file";
import * as world from "./stamped-copy-storage-world";
import { store as redis } from "./redis-stub";
import "./storage-reservation-scripts";
import { done, is, part } from "./check";

const FOLDER = "c0ffee00c0ffee00c0ffee00c0ffee00";
const PAID = Date.UTC(2026, 10, 9) / 1000;
const shop = { sid: "stamped-copy-storage", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "", statsId: "7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c" };
const BRAKE = storageBrakeFor(standingOf(shop), shop.tier);
const FILLER = `stores/${FOLDER}/p2/course-videos.zip`;

let pdf: Uint8Array = new Uint8Array();
const original: ProductFile = { pathname: `stores/${FOLDER}/p1/guide.pdf`, name: "guide.pdf", bytes: 0, contentType: "application/pdf", addedAt: "2026-11-01T00:00:00.000Z" };
/** Sales whose stamped copies are all the same size: same-length references and addresses, the same day. */
const sale = (n: number) => ({ reference: `cs_test_storage_${String(n).padStart(4, "0")}`, email: `buyer${String(n).padStart(4, "0")}@example.com`, paidAt: PAID });
/** The store's storage reservations still held (lib/storage-reservations.ts): none is the key absent or an empty list. */
const pending = async () => {
  const raw = (await redis.pipeline([["GET", `nl:storage:pending:${FOLDER}`]]))[0];
  return raw === null ? 0 : (JSON.parse(String(raw)) as unknown[]).length;
};
const copies = () => [...world.files.keys()].filter((pathname) => pathname.includes("/stamped/")).sort();

/** A fresh store: the original guide and a filler leaving `room` bytes of the plan's storage. */
function storeWith(room: number): void {
  redis.clear();
  world.files.clear();
  world.written.length = 0;
  world.listing.mode = "ok";
  world.files.set(original.pathname, { bytes: pdf });
  world.files.set(FILLER, { bytes: new Uint8Array(1), size: BRAKE - pdf.byteLength - room });
}

async function main() {
  const quiet = console.error;
  console.error = () => {};
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) doc.addPage([300, 400]);
  pdf = await doc.save();
  original.bytes = pdf.byteLength;
  const copyBytes = (await stamp.stampPdf(pdf, stampLine(sale(1).email, sale(1).reference, new Date(PAID * 1000)))).byteLength;

  part("A store whose storage is full");
  storeWith(0);
  is("the measure says full (control)", [(await storageUsed(FOLDER, BRAKE)).available, (await storageUsed(FOLDER, BRAKE)).full], [true, true]);
  const full = [];
  for (let n = 1; n <= 3; n += 1) full.push(await stamp.stampedCopy(original, sale(n), shop));
  is("three sales each get the original file (no copy handed over)", full, [null, null, null]);
  is("and no stamped copy is written", copies(), []);
  is("the store's measured storage stays within its plan's figure", (await storageUsed(FOLDER, BRAKE)).bytes <= BRAKE, true);

  part("Room for less than one copy");
  storeWith(copyBytes - 1);
  is("the original, and nothing written", [await stamp.stampedCopy(original, sale(1), shop), copies()], [null, []]);

  part("A measure that is not known never fits (rule 24)");
  storeWith(10 * copyBytes);
  world.listing.mode = "fail";
  is("a file store that cannot be listed: the original, nothing written", [await stamp.stampedCopy(original, sale(1), shop), world.written], [null, []]);
  world.listing.mode = "shapeless";
  is("a listing page in an unknown shape: the original, nothing written", [await stamp.stampedCopy(original, sale(2), shop), world.written], [null, []]);
  world.listing.mode = "ok";
  await redis.pipeline([["SET", `nl:stream:col:${FOLDER}`, "not-a-collection"]]);
  is("a video measure that is not known: the original, nothing written", [await stamp.stampedCopy(original, sale(3), shop), world.written], [null, []]);

  part("Uploads already reserved count against the room");
  storeWith(copyBytes + 10);
  await redis.pipeline([["SET", `nl:storage:pending:${FOLDER}`, JSON.stringify([{ id: "a".repeat(32), bytes: 20, at: Date.now() }])]]);
  is("a vault upload holding the rest: the original, nothing written", [await stamp.stampedCopy(original, sale(1), shop), copies()], [null, []]);
  await redis.pipeline([["SET", `nl:storage:pending:${FOLDER}`, "not a list"]]);
  is("a reservation list in an unknown shape: the original, nothing written", [await stamp.stampedCopy(original, sale(2), shop), copies()], [null, []]);

  part("A store whose renewal is unpaid stores nothing new");
  storeWith(10 * copyBytes);
  is("the original, nothing written", [await stamp.stampedCopy(original, sale(1), { ...shop, renewalUnpaidSince: PAID }), copies()], [null, []]);

  part("Two downloads at once with room for one copy");
  storeWith(copyBytes + 10);
  const both = await Promise.all([stamp.stampedCopy(original, sale(1), shop), stamp.stampedCopy(original, sale(2), shop)]);
  is("one copy is handed over, the other buyer gets the original", both.filter(Boolean).length, 1);
  is("one copy is written", copies().length, 1);
  is("and the store stays within its plan's figure", (await storageUsed(FOLDER, BRAKE)).bytes <= BRAKE, true);
  is("no reservation is left behind", await pending(), 0);

  part("Control: a store with room gets its copy as before");
  storeWith(10 * copyBytes);
  const copy = await stamp.stampedCopy(original, sale(1), shop);
  is("a copy is handed over, in the folder of copies beside the original", [Boolean(copy), copy?.pathname.startsWith(stamp.copyFolder(original)), copy?.bytes], [true, true, copyBytes]);
  is("it is written once, under stores/<folder>/, so the store's own measure counts it", [copies(), copies().every((pathname) => pathname.startsWith(`stores/${FOLDER}/`))], [[copy?.pathname], true]);
  is("the measure grows by exactly the copy", (await storageUsed(FOLDER, BRAKE)).bytes, BRAKE - 10 * copyBytes + copyBytes);
  is("its record is kept", typeof (await redis.pipeline([["GET", stamp.copyKey(sale(1).reference, original)]]))[0], "string");
  is("no reservation is left behind", await pending(), 0);
  world.written.length = 0;
  is("the second download of the sale is the same copy, with nothing written", [(await stamp.stampedCopy(original, sale(1), shop))?.pathname, world.written], [copy?.pathname, []]);

  console.error = quiet;
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
