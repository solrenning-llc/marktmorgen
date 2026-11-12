/**
 * A buyer's stamped copy, and a PDF's preview, are new files in the store's paid storage: each is kept only after
 * its bytes are reserved against the plan's storage, measured from the file stores themselves (owner rule MR: a
 * ceiling before every spend; unknown is never room). Before this, lib/pdf-stamp.ts and lib/pdf-preview.ts wrote
 * their copy whatever the store held: a store at its storage kept growing by up to MAX_STAMP_BYTES a sale.
 *
 * Decisions applied (Claude 1, C3-136, 12 November 2026):
 *   1. A store without room never hands its buyer the file unstamped: the copy is stamped on the fly and sent
 *      without being kept ("fly"), and when that cannot be made now the buyer is asked to try again ("retry"),
 *      never handed the original.
 *   2. Measuring the store (a Blob and R2 listing) is paid for from the store's public requests before it lists
 *      (STORAGE_MEASURE_UNITS), and a store found without room is not listed again for an hour (noRoomKey), by its
 *      copies or by its previews; the copy made on the fly is paid for the same way (flyUnits).
 *
 * Vercel Blob is stood in for in memory (tests/stamped-drop-retry-world.ts); Redis is the repository's in-memory
 * stand-in (tests/redis-stub.ts); every file and address is synthetic.
 */
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { previewCopy } from "@/lib/pdf-preview";
import { serveStamped } from "@/lib/serve-file";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { FLY_BASE_UNITS, NO_ROOM_NOTE_SECONDS, STORAGE_MEASURE_UNITS, type CopyMeter, flyHoldUnits, flyUnits } from "@/lib/stamp-cost-rules";
import { ordersWords } from "@/lib/buyer-words/orders";
import type { ProductFile } from "@/lib/product-file";
import * as world from "./stamped-drop-retry-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const PENDING = `nl:storage:pending:${FOLDER}`;
const NO_ROOM = `nl:stamp:noroom:${FOLDER}`;
const BRAKE = PAID_STORAGE_BYTES.creator;
const shop = { sid: "stamped-copy-storage", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };

/** The store's public requests, in memory: every take and give-back is written down; `left` is what the window has. */
function meter(left = 1_000_000) {
  const log: string[] = [];
  const state = { left, taken: 0 };
  const m: CopyMeter = {
    async take(units) {
      log.push(`take ${units}`);
      if (!Number.isSafeInteger(units) || units < 1 || units > state.left) return false;
      state.left -= units;
      state.taken += units;
      return true;
    },
    async give(units) {
      log.push(`give ${units}`);
      state.left += units;
      state.taken -= units;
    },
  };
  return { m, log, state };
}

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
const noted = async () => (await redis.pipeline([["GET", NO_ROOM]]))[0] !== null;
const forgetNoRoom = () => redis.pipeline([["DEL", NO_ROOM]]);
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();
const body = async (response: Response) => new Uint8Array(await response.arrayBuffer());

async function main() {
  const errors: string[] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  part("Control: a store with room keeps the buyer's stamped copy, its measurement paid for first");
  const roomy = await original();
  const paid = meter();
  const made = await stamp.stampedDelivery(roomy, sale(1), shop, paid.m);
  is("the copy is kept", [made.kind, made.kind === "kept" ? world.files.has(made.copy.pathname) : false], ["kept", true]);
  is("the measurement took its public requests before listing, and nothing more", paid.log, [`take ${STORAGE_MEASURE_UNITS}`]);
  is("the reservation is gone once the copy is written (the copy itself is now measured)", [null, "[]"].includes(await pending() as string | null), true);
  is("the next download of the sale is the kept copy, with nothing taken", [(await stamp.stampedDelivery(roomy, sale(1), shop, paid.m)).kind, paid.log.length], ["kept", 1]);
  world.pages.length = 0;

  part("A store at its plan's storage keeps no new copy: the buyer gets a stamped copy made on the fly, never the original");
  const full = await original("Ledger.pdf");
  const uploaded = world.files.get(full.pathname)!;
  holding(BRAKE);
  const fly1 = meter();
  const first = await stamp.stampedDelivery(full, sale(2), shop, fly1.m);
  is("the answer is a copy made on the fly", first.kind, "fly");
  const flyBytes = first.kind === "fly" ? first.bytes : new Uint8Array();
  is("its bytes are stamped, not the file as uploaded", [same(flyBytes, uploaded), flyBytes.byteLength > 0], [false, true]);
  is("it is the whole file, every page", await pageCount(flyBytes), 3);
  is("named and typed as the original", first.kind === "fly" ? [first.name, first.contentType] : null, ["Ledger.pdf", "application/pdf"]);
  is("nothing is written to the store's folder", copies(full), []);
  is("the measurement, then the sending, were paid for before each", fly1.log, [`take ${STORAGE_MEASURE_UNITS}`, `take ${flyUnits(0, flyBytes.byteLength)}`]);
  is("the studio is told it is the storage", (await stamp.stampProblems([full])).get(full.pathname), "storage");
  is("and the store is noted without room for an hour", [await noted(), NO_ROOM_NOTE_SECONDS], [true, 3600]);
  world.pages.length = 0;

  part("While the store is noted full, a later download stamps on the fly without listing the store again");
  const listedBefore = world.listed.length;
  const fly2 = meter();
  const second = await stamp.stampedDelivery(full, sale(3), shop, fly2.m);
  is("the next sale is handed a copy made on the fly", second.kind, "fly");
  is("marked for its own buyer (not the first sale's copy)", second.kind === "fly" ? same(second.bytes, flyBytes) : null, false);
  is("without another listing of the store", world.listed.length, listedBefore);
  is("and still nothing is written", copies(full), []);
  const held = flyHoldUnits(full.bytes);
  is("the work was held at its worst before the original was read, and what it did not need given back", [fly2.log[0], fly2.log[1]?.startsWith("give"), fly2.state.taken >= FLY_BASE_UNITS, fly2.state.taken < held], [`take ${held}`, true, true, true]);

  part("Another file of the same store, during the same hour, is not measured either");
  const other = await original("Other.pdf");
  const fly3 = meter();
  const third = await stamp.stampedDelivery(other, sale(4), shop, fly3.m);
  is("it is made on the fly, without a listing and without a measurement paid for", [third.kind, world.listed.length, fly3.log.includes(`take ${STORAGE_MEASURE_UNITS}`)], ["fly", listedBefore, false]);
  is("nothing written", copies(other), []);

  part("A copy that cannot be made on the fly now asks the buyer to try again: never the original");
  const broke = meter(flyHoldUnits(full.bytes) - 1);
  is("a store whose requests cannot pay for the work: try again", (await stamp.stampedDelivery(full, sale(5), shop, broke.m)).kind, "retry");
  is("and nothing was spent reading it", broke.state.taken, 0);
  const gone = await original("Gone.pdf");
  world.files.delete(gone.pathname);
  const lost = meter();
  is("an original that cannot be read just now: try again", (await stamp.stampedDelivery(gone, sale(6), shop, lost.m)).kind, "retry");
  is("its hold given back down to the read it tried", [lost.log[0], lost.log[1]?.startsWith("give"), lost.state.taken < flyHoldUnits(gone.bytes)], [`take ${flyHoldUnits(gone.bytes)}`, true, true]);
  const response = await serveStamped({ kind: "retry" }, full, ordersWords("en").downloadProblems.stampNotReady);
  is("the download answers try again, in plain words", [response.status, await response.text(), response.headers.get("Retry-After")], [503, "Your copy, marked with your email, could not be made just now. Please try again in a few minutes.", "120"]);
  is("the try-again message is in each store language", (["es", "fr", "de", "it", "nl", "pt"] as const).every((code) => ordersWords(code).downloadProblems.stampNotReady.length > 20 && ordersWords(code).downloadProblems.stampNotReady !== ordersWords("en").downloadProblems.stampNotReady), true);
  await forgetNoRoom();

  part("The first discovery of a full store also never falls back to the original");
  const late = await original("Late.pdf");
  holding(BRAKE);
  const tight = meter(STORAGE_MEASURE_UNITS);
  is("measured, no room, and no requests left to send it: try again", (await stamp.stampedDelivery(late, sale(7), shop, tight.m)).kind, "retry");
  is("nothing written", copies(late), []);
  world.pages.length = 0;
  await forgetNoRoom();

  part("A store whose requests cannot pay for the measurement lists nothing, and still never hands over the original");
  const unpaid = await original("Unpaid.pdf");
  const listedNow = world.listed.length;
  const none = meter(FLY_BASE_UNITS);
  is("the copy can be neither measured nor sent: try again", (await stamp.stampedDelivery(unpaid, sale(8), shop, none.m)).kind, "retry");
  is("the store was not listed", world.listed.length, listedNow);
  is("nothing written", copies(unpaid), []);
  is("and the studio is not told the storage ran out: it did not", (await stamp.stampProblems([unpaid])).get(unpaid.pathname), undefined);
  is("nor is the store noted without room", await noted(), false);
  const enough = meter(STORAGE_MEASURE_UNITS - 1);
  const sent = await stamp.stampedDelivery(unpaid, sale(9), shop, enough.m);
  is("with requests to send it but not to measure: sent on the fly, not kept, not listed", [sent.kind, world.listed.length, copies(unpaid)], ["fly", listedNow, []]);

  part("A storage that cannot be measured is no room");
  const unknown = await original("Unknown.pdf");
  world.pages.push(null);
  is("a copy made on the fly", (await stamp.stampedDelivery(unknown, sale(10), shop, meter().m)).kind, "fly");
  is("and none is written", copies(unknown), []);
  world.pages.length = 0;
  await forgetNoRoom();

  part("Room another upload already reserved is not room");
  const crowded = await original("Crowded.pdf");
  await redis.pipeline([["SET", PENDING, JSON.stringify([{ id: "f".repeat(32), bytes: BRAKE - 1_000, at: Date.now() }])]]);
  is("a copy made on the fly", (await stamp.stampedDelivery(crowded, sale(11), shop, meter().m)).kind, "fly");
  is("and none is written", copies(crowded), []);
  is("the other upload's reservation is left as it was", JSON.parse(String(await pending())).length, 1);
  await redis.pipeline([["DEL", PENDING]]);
  await forgetNoRoom();

  part("The studio's note stays until the storage has room again, and a copy of the file is kept");
  is("the file found without room is still noted for the studio after the hour's note on the store is gone", (await stamp.stampProblems([full])).get(full.pathname), "storage");
  const again = await stamp.stampedDelivery(full, sale(12), shop, meter().m);
  is("with room, the next sale's copy is kept", [again.kind, again.kind === "kept" ? world.files.has(again.copy.pathname) : false], ["kept", true]);
  is("and the studio no longer says the storage ran out for it", (await stamp.stampProblems([full])).get(full.pathname), undefined);

  part("A copy already in place whose record went missing is overwritten, not charged again as new storage");
  const landed = await original("Landed.pdf");
  const firstCopy = await stamp.stampedDelivery(landed, sale(13), shop, meter().m);
  const target = firstCopy.kind === "kept" ? firstCopy.copy.pathname : "";
  const size = world.files.get(target)?.byteLength ?? 0;
  is("control: the first copy is kept", [firstCopy.kind, size > 0], ["kept", true]);
  await redis.pipeline([["DEL", stamp.copyKey(sale(13).reference, landed)]]);
  /** The store's folder listed as holding the copy in place plus `other` bytes, for the next listing only. */
  const holdingWith = (other: number, withTarget: boolean) => world.pages.push({ blobs: [{ pathname: `stores/${FOLDER}/0000000000/Big.zip`, size: other }, ...(withTarget ? [{ pathname: target, size }] : [])], hasMore: false });
  holdingWith(BRAKE - size - 1_000, true);
  const rewrite = await stamp.stampedDelivery(landed, sale(13), shop, meter().m);
  is("less than one copy free, the copy in place is written over and kept", [rewrite.kind, rewrite.kind === "kept" ? rewrite.copy.pathname : ""], ["kept", target]);
  is("the store is not noted without room", await noted(), false);
  is("nor does the studio say the storage ran out", (await stamp.stampProblems([landed])).get(landed.pathname), undefined);
  is("and nothing stays reserved", [null, "[]"].includes(await pending() as string | null), true);
  world.pages.length = 0;
  await redis.pipeline([["DEL", stamp.copyKey(sale(13).reference, landed)]]);
  world.files.delete(target);
  holdingWith(BRAKE - 1_000, false);
  const fresh = await stamp.stampedDelivery(landed, sale(13), shop, meter().m);
  is("control: the same free room with no copy in place is not enough, and a copy is made on the fly", [fresh.kind, world.files.has(target)], ["fly", false]);
  world.pages.length = 0;
  await forgetNoRoom();

  part("A copy made on the fly goes out from here, whole, as a download");
  const flown = await serveStamped({ kind: "fly", bytes: flyBytes, name: "Ledger.pdf", contentType: "application/pdf" }, full, "x");
  is("the stamped bytes, as an attachment, with their length", [flown.status, same(await body(flown), flyBytes), flown.headers.get("Content-Disposition")?.includes("attachment"), flown.headers.get("Content-Length")], [200, true, true, String(flyBytes.byteLength)]);
  const plainFile = await serveStamped({ kind: "original" }, full, "x");
  is("control: where stamping does not apply, the file as uploaded", same(await body(plainFile), uploaded), true);

  part("A PDF's preview is a new file too: kept only within the store's storage");
  const previewed = await original("Preview-me.pdf", 4);
  holding(BRAKE);
  const p1 = meter();
  is("a full store gets no preview made", await previewCopy(previewed, 2, shop, p1.m), null);
  is("and none is written", copies(previewed), []);
  is("its measurement was paid for first", p1.log, [`take ${STORAGE_MEASURE_UNITS}`]);
  world.pages.length = 0;
  const listedAfterPreview = world.listed.length;
  const p2 = meter();
  is("asked again within the hour: still no preview", await previewCopy(previewed, 2, shop, p2.m), null);
  is("without listing the store or paying for a measurement", [world.listed.length, p2.log], [listedAfterPreview, []]);
  await forgetNoRoom();
  const p3 = meter();
  const preview = await previewCopy(previewed, 2, shop, p3.m);
  is("control: with room, the preview is made and kept", [Boolean(preview), preview ? world.files.has(preview.pathname) : false], [true, true]);
  is("and nothing stays reserved", [null, "[]"].includes(await pending() as string | null), true);

  part("A file that cannot be stamped for what it is (Codex X5's MEDIUM): handed over as uploaded, the store full or not");
  // A PDF that cannot be read (password-protected, damaged): stampBytes refuses it for what it is, not for now.
  const unstampable = async () => {
    n += 1;
    const pathname = `stores/${FOLDER}/${String(n).padStart(10, "0")}/Locked.pdf`;
    const bytes = new TextEncoder().encode("%PDF-1.7\nnot a document pdf-lib can open\n%%EOF");
    world.files.set(pathname, bytes);
    return { pathname, name: "Locked.pdf", bytes: bytes.byteLength, contentType: "application/pdf", addedAt: `2026-11-11T12:30:0${n % 10}.000Z` } as ProductFile;
  };
  const problemOf = async (file: ProductFile) => (await redis.pipeline([["GET", stamp.problemKey(file.pathname)]]))[0];
  await forgetNoRoom();
  const lockedRoomy = await unstampable();
  is("control, a store with room: the original, and the problem noted", [(await stamp.stampedDelivery(lockedRoomy, sale(20), shop, meter().m)).kind, await problemOf(lockedRoomy)], ["original", "unreadable"]);
  await redis.pipeline([["SET", NO_ROOM, "1", "EX", NO_ROOM_NOTE_SECONDS]]);
  const lockedFull = await unstampable();
  const lockedMeter = meter();
  is("a store noted without room: the original too, never 'try again'", (await stamp.stampedDelivery(lockedFull, sale(21), shop, lockedMeter.m)).kind, "original");
  is("and the problem noted for the creator, the same as with room", await problemOf(lockedFull), "unreadable");
  is("and only the work done is paid for, never more than it held", lockedMeter.state.taken <= flyHoldUnits(lockedFull.bytes), true);
  await forgetNoRoom();

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
