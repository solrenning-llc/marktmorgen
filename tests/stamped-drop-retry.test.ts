/**
 * A buyer's stamped copies are deleted with the file they were made from, even when the file store fails at that
 * moment, and a listing the store does not finish is never read as the whole folder (CX-123 rule 24; audit R24
 * round 9, item 3).
 *
 * Each stamped copy carries the buyer's email on every page, and lib/file-store.ts filesHeld counts it in the
 * store's paid storage. Before this, a failed listing or deletion in dropStamped (lib/pdf-stamp.ts) was only
 * logged: nothing tried again, so the copies stayed for good. And listFiles (lib/file-store.ts) ended its walk
 * when Vercel Blob said "has more" without a cursor, handing a partial folder over as the whole one.
 *
 * Vercel Blob is stood in for in memory (tests/stamped-drop-retry-world.ts); Redis is the repository's
 * in-memory stand-in (tests/redis-stub.ts); every file and address is synthetic.
 */
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { listFiles } from "@/lib/file-store";
import type { ProductFile } from "@/lib/product-file";
import * as world from "./stamped-drop-retry-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const QUEUE = "nl:stamp:drop";
const bytes = (text: string) => new TextEncoder().encode(text);

let n = 0;
function original(name = "Guide.pdf"): ProductFile {
  n += 1;
  const pathname = `stores/${FOLDER}/${String(n).padStart(10, "0")}/${name}`;
  world.files.set(pathname, bytes(`original ${n}`));
  return { pathname, name, bytes: 12, contentType: "application/pdf", addedAt: `2026-11-08T12:00:0${n % 10}.000Z` };
}
/** Puts `count` stamped copies of a file where lib/pdf-stamp.ts keeps them, and answers their paths. */
function copiesOf(file: ProductFile, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const pathname = `${stamp.copyFolder(file)}${String(i).padStart(24, "0")}/${file.name}`;
    world.files.set(pathname, bytes(`Sold to buyer${i}@example.com`));
    out.push(pathname);
  }
  return out;
}
const left = (file: ProductFile) => [...world.files.keys()].filter((pathname) => pathname.startsWith(stamp.copyFolder(file))).length;
const queued = async () => ((await redis.pipeline([["SMEMBERS", QUEUE]]))[0] as string[]).slice().sort();
async function outcome<T>(run: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await run();
  } catch {
    return "threw";
  }
}
type Retry = (limit: number) => Promise<number>;
const retry = (limit: number): Promise<number> => {
  const found = (stamp as unknown as { retryStampDrops?: Retry }).retryStampDrops;
  return found ? found(limit) : Promise.reject(new Error("retryStampDrops is missing"));
};
/** Runs with one Redis command answered in a shape of the test's choosing. */
async function bending<T>(command: string, answer: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((one, i) => (String(one[0]).toUpperCase() === command ? answer : replies[i]));
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function main() {
  const errors: string[] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  part("listFiles reads Vercel Blob's pages in their exact shape");
  const prefix = `stores/${FOLDER}/stamped/${"a".repeat(24)}/`;
  const a = `${prefix}one/Guide.pdf`;
  const b = `${prefix}two/Guide.pdf`;
  world.pages.push({ blobs: [{ pathname: a, size: 1 }], hasMore: true, cursor: "c1" }, { blobs: [{ pathname: b, size: 1 }], hasMore: false });
  is("control: two pages joined by a cursor are listed whole", await outcome(() => listFiles(prefix)), [a, b]);
  world.pages.push({ blobs: [], hasMore: false });
  is("control: a confirmed empty folder is an empty list", await outcome(() => listFiles(prefix)), []);
  world.pages.push({ blobs: [{ pathname: a, size: 1 }], hasMore: true, cursor: undefined });
  is("\"has more\" without a cursor is unknown, never the end of the folder", await outcome(() => listFiles(prefix)), "threw");
  world.pages.push({ blobs: [{ pathname: a, size: 1 }], hasMore: true, cursor: "" });
  is("\"has more\" with an empty cursor is unknown too", await outcome(() => listFiles(prefix)), "threw");
  world.pages.push({ blobs: [{ pathname: a, size: 1 }] });
  is("a page that does not say whether more follows is unknown", await outcome(() => listFiles(prefix)), "threw");
  world.pages.push({ blobs: [{ pathname: a, size: 1 }], hasMore: true, cursor: "c1" }, { blobs: [{ pathname: b, size: 1 }], hasMore: true, cursor: "c1" }, { blobs: [], hasMore: false });
  is("a cursor handed out twice is unknown, never walked again", await outcome(() => listFiles(prefix)), "threw");
  world.pages.length = 0;
  world.pages.push({ blobs: [{ pathname: `stores/${FOLDER}/0000000001/Guide.pdf`, size: 1 }], hasMore: false });
  is("a path outside the prefix asked for is unknown, never handed on to be deleted", await outcome(() => listFiles(prefix)), "threw");
  world.pages.push({ blobs: [{ pathname: 7, size: 1 }], hasMore: false });
  is("a path that is not text is unknown", await outcome(() => listFiles(prefix)), "threw");
  world.pages.push(null);
  is("control: no page at all is unknown", await outcome(() => listFiles(prefix)), "threw");
  world.pages.length = 0;

  part("Deleting a file deletes its buyers' stamped copies");
  const kept = original("Kept.pdf");
  const keptCopies = copiesOf(kept, 1);
  const first = original();
  copiesOf(first, 2);
  await stamp.dropStamped(first);
  is("control: every copy of the deleted file is gone", left(first), 0);
  is("control: nothing is put down to be tried again", await queued(), []);
  is("control: another file's original and copies stay", [world.files.has(kept.pathname), keptCopies.every((pathname) => world.files.has(pathname))], [true, true]);

  part("A deletion that fails is tried again until it is done, never counted as done");
  const second = original();
  copiesOf(second, 2);
  world.failDeletes(1);
  is("the removal itself still answers (the file is already off the product)", await outcome(() => stamp.dropStamped(second)), undefined);
  is("the copies are still there", left(second), 2);
  is("and their folder is put down to be tried again", await queued(), [stamp.copyFolder(second)]);
  const third = original();
  copiesOf(third, 1);
  await stamp.dropStamped(third);
  is("the next removal deletes its own copies", left(third), 0);
  is("and the copies left from before", left(second), 0);
  is("and takes their folder off the list only once they are gone", await queued(), []);

  part("A listing the store does not finish deletes nothing and is tried again");
  const fourth = original();
  copiesOf(fourth, 3);
  world.pages.push({ blobs: [{ pathname: `${stamp.copyFolder(fourth)}${"0".repeat(24)}/Guide.pdf`, size: 1 }], hasMore: true, cursor: undefined });
  await stamp.dropStamped(fourth);
  is("nothing of a partial listing is deleted as if it were the whole folder", left(fourth), 3);
  is("the folder is put down to be tried again", await queued(), [stamp.copyFolder(fourth)]);
  is("a later try deletes every copy", [await outcome(() => retry(5)), left(fourth), await queued()], [1, 0, []]);

  part("The list of folders to try again is read exactly");
  const fifth = original();
  copiesOf(fifth, 2);
  world.failDeletes(1);
  await stamp.dropStamped(fifth);
  const before = world.deleted.length;
  is("a list read in an unknown shape is refused", await bending("SRANDMEMBER", "OK", () => outcome(() => retry(5))), "threw");
  is("and deletes nothing", [world.deleted.length, left(fifth), await queued()], [before, 2, [stamp.copyFolder(fifth)]]);
  is("an exact read then deletes them", [await outcome(() => retry(5)), left(fifth), await queued()], [1, 0, []]);
  await redis.pipeline([["SADD", QUEUE, `stores/${FOLDER}/`]]);
  const lists = world.listed.length;
  await outcome(() => retry(5));
  is("a member that is not a folder of stamped copies is never listed nor deleted", [world.listed.slice(lists).some((one) => one.prefix === `stores/${FOLDER}/`), world.files.has(kept.pathname)], [false, true]);
  await redis.pipeline([["DEL", QUEUE]]);

  part("A folder that cannot be put down is said, never taken as done");
  const sixth = original();
  copiesOf(sixth, 1);
  world.failDeletes(1);
  errors.length = 0;
  is("the removal still answers", await bending("SADD", "OK", () => outcome(() => stamp.dropStamped(sixth))), undefined);
  is("and the log says the copies are left with nothing to try again", errors.some((line) => line.includes("nothing will try again")), true);
  is("the copies are not counted as gone", left(sixth), 1);
  // The bent answer came after the real write, so the folder may be on the list after all; it starts the next part empty.
  await redis.pipeline([["DEL", QUEUE]]);

  part("A new stamped copy also tries again the folders left over");
  const seventh = original();
  copiesOf(seventh, 2);
  world.failDeletes(1);
  await stamp.dropStamped(seventh);
  is("the folder waits", await queued(), [stamp.copyFolder(seventh)]);
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const pdf = await doc.save();
  const book = original("Workbook.pdf");
  world.files.set(book.pathname, pdf);
  const file: ProductFile = { ...book, bytes: pdf.byteLength };
  const shop = { sid: "stamped-drop-retry", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
  const sale = { reference: "cs_test_r9S7t5A3m1P0", email: "maya@example.com", paidAt: Date.UTC(2026, 10, 8) / 1000 };
  const copy = await stamp.stampedCopy(file, sale, shop);
  is("control: the buyer still gets the copy", [Boolean(copy), copy ? world.files.has(copy.pathname) : false], [true, true]);
  is("and the folder left over is deleted and taken off the list", [left(seventh), await queued()], [0, []]);
  is("control: the second download of the sale is the same copy", (await stamp.stampedCopy(file, sale, shop))?.pathname, copy?.pathname);

  // Codex M on #3312 (review 5820239497): a removal that failed queued this file's own folder while a download was
  // stamping it; the retry after the write must never delete the copy it is about to hand over.
  part("A new copy never deletes itself: its own folder waits on the list for a later try");
  const own = original("Ledger.pdf");
  const ownDoc = await PDFDocument.create();
  ownDoc.addPage([300, 400]);
  const ownPdf = await ownDoc.save();
  world.files.set(own.pathname, ownPdf);
  const ownFile: ProductFile = { ...own, bytes: ownPdf.byteLength };
  await redis.pipeline([["SADD", QUEUE, stamp.copyFolder(ownFile)]]);
  const ownSale = { reference: "cs_test_r9S7t5A3m1P1", email: "ana@example.com", paidAt: Date.UTC(2026, 10, 8) / 1000 };
  const ownCopy = await stamp.stampedCopy(ownFile, ownSale, shop);
  is("the copy handed over still exists", [Boolean(ownCopy), ownCopy ? world.files.has(ownCopy.pathname) : false], [true, true]);
  is("and its folder stays on the list for a later try", await queued(), [stamp.copyFolder(ownFile)]);
  await redis.pipeline([["DEL", QUEUE]]);

  console.error = quiet;
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
