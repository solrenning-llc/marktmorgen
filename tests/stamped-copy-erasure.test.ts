/**
 * A buyer's stamped copies go when the buyer is deleted (board #5427, row #3312; the ALTO first written in
 * 13f87a3273, never merged).
 *
 * A stamped PDF or EPUB carries "Sold to <the buyer's address>" on every page (lib/pdf-stamp.ts). It is kept in the
 * store's folder, at a path made from the sale and the file, and before this fix only deleting the file it was made
 * from deleted it: deleting the person (lib/person-erasure.ts) left every copy, with the address in it, for as long
 * as the product kept its file. Now each copy kept is noted under the person first (stampedCopiesOf), deleting the
 * person deletes each one with its record, and an answer about the note that is not read exactly leaves the erasure
 * unfinished, never done with a copy left.
 *
 * Real erasure, real stamping; Vercel Blob in memory (tests/stamped-drop-retry-world.ts), in-memory Redis. Nothing
 * real is reached.
 */
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { copyPerson } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import { COPIES_PER_PERSON, COPY_NOTE_BYTES, COPY_PATH_MOST } from "@/lib/stamp-cost-rules";
import { ERASE_STAMPED } from "@/lib/erasure-rules";
import { RECORD_BYTES_MOST } from "@/lib/backup-deletions";
import { takeDataCommands } from "@/lib/store-data";
import type { ProductFile } from "@/lib/product-file";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import * as world from "./stamped-drop-retry-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const meter = { take: async () => true, give: async () => {} };

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
  const owner = "stamp-erasure@example.com";
  await claimHandle(owner, "stamperasure", "Stamp Erasure", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_stamp", subscriptionId: "sub_stamp", active: true, tier: "scale", period: paidPeriod() });
  const shop = await storeForEmail(owner);
  if (!shop?.statsId) throw new Error("fixture: no store");

  const maya = { reference: "cs_test_m4Y8a1B2c3D4", email: "maya@example.com", paidAt: Date.UTC(2026, 10, 20) / 1000 };
  const lee = { reference: "cs_test_l7E3e9F1g2H5", email: "lee@example.com", paidAt: Date.UTC(2026, 10, 21) / 1000 };
  const book = await pdfFile("Workbook.pdf", "2026-11-20T12:00:01.000Z");
  const guide = await pdfFile("Guide.pdf", "2026-11-20T12:00:02.000Z");

  part("Deleting a buyer deletes every stamped copy made for them, with its record");
  const mine = await Promise.all([book, guide].map((file) => stamp.stampedDelivery(file, maya, shop, meter)));
  const theirs = await stamp.stampedDelivery(book, lee, shop, meter);
  const paths = mine.map((answer) => (answer.kind === "kept" ? answer.copy.pathname : ""));
  const other = theirs.kind === "kept" ? theirs.copy.pathname : "";
  is("control: both of Maya's copies are kept, with her address in them", [mine.map((a) => a.kind), paths.every((p) => world.files.has(p))], [["kept", "kept"], true]);
  is("control: Lee's copy is kept too", [theirs.kind, world.files.has(other)], ["kept", true]);
  const copy = await copyPerson((await erasureScope(shop, maya.email))!);
  const listed = copy.sections.find((s) => s.module === "lib/pdf-stamp.ts")?.records as { stampedCopyOf: string }[] | undefined;
  is("her copy of her data names her stamped copies", listed?.map((r) => r.stampedCopyOf).sort(), ["Guide.pdf", "Workbook.pdf"]);
  const result = await erasePerson(shop, maya.email, { kind: "person" });
  is("the deletion is done", result.ok, true);
  is("her copies are gone from the file store", paths.map((p) => world.files.has(p)), [false, false]);
  is("and their records", (await redis.pipeline([["GET", stamp.copyKey(maya.reference, book)], ["GET", stamp.copyKey(maya.reference, guide)]])), [null, null]);
  is("another buyer's copy of the same file is kept", [world.files.has(other), typeof (await redis.pipeline([["GET", stamp.copyKey(lee.reference, book)]]))[0]], [true, "string"]);
  is("the confirmation counts the copies", result.ok ? result.parts.find((p) => p.module === "lib/pdf-stamp.ts")?.records : null, 2);
  is("lib/person-data.ts says so", PERSON_DATA.some((line) => line.file === "lib/pdf-stamp.ts" && line.how === "erased"), true);

  part("A copy handed over again after the deletion is noted again, and the next deletion finds it");
  const again = await stamp.stampedDelivery(book, maya, shop, meter);
  is("control: a new copy is made", [again.kind, again.kind === "kept" && world.files.has(again.copy.pathname)], ["kept", true]);
  is("the next deletion deletes it", [(await erasePerson(shop, maya.email, { kind: "person" })).ok, world.files.has(paths[0])], [true, false]);

  part("A note that is not read exactly: the deletion is not done, and the copy stays to be deleted by the next try");
  const kept = await stamp.stampedDelivery(guide, lee, shop, meter);
  const leeGuide = kept.kind === "kept" ? kept.copy.pathname : "";
  const real = redis.pipeline.bind(redis);
  const who = stamp.stampedCopiesKey(shop.sid, lee.email);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === who ? [["not", 1]] : real(commands)) as typeof redis.pipeline;
  let unknown;
  try {
    unknown = await erasePerson(shop, lee.email, { kind: "person" });
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  is("never answered done", [unknown.ok, !unknown.ok && unknown.reason === "incomplete" ? unknown.failed.includes("lib/pdf-stamp.ts") : false], [false, true]);
  is("control: the copies are still there, still noted", [world.files.has(other), world.files.has(leeGuide)], [true, true]);
  const retried = await erasePerson(shop, lee.email, { kind: "person" });
  is("pressed again, it finishes and deletes both", [retried.ok, world.files.has(other), world.files.has(leeGuide)], [true, false, false]);

  part("A store whose note cannot be confirmed never keeps a copy it could not find again");
  const pat = { reference: "cs_test_p1A2t3Q4r5S6", email: "pat@example.com", paidAt: Date.UTC(2026, 10, 22) / 1000 };
  const patWho = stamp.stampedCopiesKey(shop.sid, pat.email);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((c) => c[0] === "SADD" && c[1] === patWho) ? commands.map(() => "OK") : real(commands)) as typeof redis.pipeline;
  let unnoted;
  try {
    unnoted = await stamp.stampedDelivery(book, pat, shop, meter);
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  const unkeptAt = `${stamp.copyFolder(book)}`;
  is("the copy is sent stamped, not kept", [unnoted.kind, [...world.files.keys()].filter((p) => p.startsWith(unkeptAt)).length], ["fly", 0]);

  part("A deletion that read the note between the note and the write: the copy written is deleted again, and sent unkept");
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "SISMEMBER" && commands[0][1] === patWho ? [0] : real(commands)) as typeof redis.pipeline;
  let raced;
  try {
    raced = await stamp.stampedDelivery(book, pat, shop, meter);
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  is("sent stamped, nothing left in the file store", [raced.kind, [...world.files.keys()].filter((p) => p.startsWith(unkeptAt)).length], ["fly", 0]);

  part(`At most ${COPIES_PER_PERSON} copies noted for one person: past them a copy is stamped on the fly and not kept`);
  await redis.pipeline([["DEL", patWho], ["SADD", patWho, ...Array.from({ length: COPIES_PER_PERSON }, (_, i) => `nl:stamp:copy:${String(i).padStart(40, "0")} stores/${FOLDER}/stamped/${"a".repeat(24)}/${"b".repeat(24)}/n${i}.pdf`)]]);
  const past = await stamp.stampedDelivery(guide, pat, shop, meter);
  is("sent on the fly", past.kind, "fly");
  is("not noted, and nothing kept", [Number((await redis.pipeline([["SCARD", patWho]]))[0]), [...world.files.keys()].filter((p) => p.startsWith(stamp.copyFolder(guide))).length], [COPIES_PER_PERSON, 0]);

  part("What the note and its deletion cost stays inside what is counted for them");
  const member = 54 + 1 + COPY_PATH_MOST;
  is("a note's room covers its member and the set's own overhead", COPY_NOTE_BYTES >= member + 64, true);
  is("an erasure's bytes cover every copy at its longest", COPIES_PER_PERSON * (2 * member + 4 * COPY_PATH_MOST + 54 + RECORD_BYTES_MOST) <= ERASE_STAMPED[1], true);
  is("and its commands", 1 + 1 + 2 + takeDataCommands(1) + 2 + 4 <= ERASE_STAMPED[0], true);
  const sent: string[] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(...commands.map((c) => String(c[0])));
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    const found = await stamp.stampedCopiesOf(shop.sid, pat.email);
    await stamp.forgetStampedPerson(shop, pat.email, found);
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  is("measured: the note read, its records and members deleted, its room given back", sent.length <= 4 + takeDataCommands(1) && sent.includes("SMEMBERS") && sent.includes("SREM"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
