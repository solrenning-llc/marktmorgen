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
import { COPIES_PER_PERSON, COPY_NOTE_BYTES, COPY_PATH_MOST, UNNOTE_PAGE, UNNOTE_PAGES_PER_CALL } from "@/lib/stamp-cost-rules";
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
  // A note is in two places: the buyer's note, and its file's list after the buyer's 32-byte key and a space.
  const entry = 32 + 1 + member;
  const listKey = stamp.stampedFileKey(shop.sid, book).length;
  is("a note's room covers its member, its file's entry and both sets' own overhead", COPY_NOTE_BYTES >= member + entry + 2 * 64, true);
  is("an erasure's bytes cover every copy at its longest, its file's entry and list's key too", COPIES_PER_PERSON * (2 * member + 4 * COPY_PATH_MOST + 54 + RECORD_BYTES_MOST + entry + listKey) <= ERASE_STAMPED[1], true);
  is("and its commands, one SREM a file's list at most one a copy", 1 + 1 + 2 + takeDataCommands(1) + 2 + 4 + COPIES_PER_PERSON <= ERASE_STAMPED[0], true);
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
  // Pat's fifty notes name one file, so one list's SREM.
  is("measured: the note read, its records and members deleted, its file's entries taken off, its room given back", sent.length <= 5 + takeDataCommands(1) && sent.includes("SMEMBERS") && sent.includes("SREM"), true);

  // Claude 5 iYwjc's MÉDIO on #5475 @4f980f9bee: removing or replacing a file deleted its copies but left every buyer's
  // note of them, for good: each kept its room in the store's data room and one of the buyer's places, and the buyer's
  // copy of their data still named the deleted file.
  part("Removing a file takes its copies out of every buyer's note, frees their places and gives their room back");
  const slot = async () => Number((await redis.pipeline([["HGET", `nl:data:${shop.sid}`, "stamp:who"]]))[0] ?? 0);
  const sam = { reference: "cs_test_s9A8m7Q6r5T4", email: "sam@example.com", paidAt: Date.UTC(2026, 10, 23) / 1000 };
  const kim = { reference: "cs_test_k1I2m3Q4r5T6", email: "kim@example.com", paidAt: Date.UTC(2026, 10, 23) / 1000 };
  const samWho = stamp.stampedCopiesKey(shop.sid, sam.email);
  const notes = await pdfFile("Notes.pdf", "2026-11-20T12:00:05.000Z");
  const map = await pdfFile("Map.pdf", "2026-11-20T12:00:06.000Z");
  const before = await slot();
  const handed = await Promise.all([stamp.stampedDelivery(notes, sam, shop, meter), stamp.stampedDelivery(map, sam, shop, meter), stamp.stampedDelivery(notes, kim, shop, meter)]);
  is("control: three copies kept and noted, their room counted", [handed.map((a) => a.kind), Number((await redis.pipeline([["SCARD", samWho]]))[0]), (await slot()) - before], [["kept", "kept", "kept"], 2, 3 * COPY_NOTE_BYTES]);
  await stamp.dropStamped(notes, shop);
  const left = await stamp.stampedCopiesOf(shop.sid, sam.email);
  is("Sam's note keeps only the copy of the file still on sale: one of his places is free again", left.paths.map((p) => p.slice(p.lastIndexOf("/") + 1)), ["Map.pdf"]);
  is("Kim's note is empty", (await stamp.stampedCopiesOf(shop.sid, kim.email)).members, []);
  is("the room of the two removed notes is given back", (await slot()) - before, COPY_NOTE_BYTES);
  is("the file's own list of notes is gone, and nothing waits on the queue", [Number((await redis.pipeline([["EXISTS", stamp.stampedFileKey(shop.sid, notes)]]))[0]), (await redis.pipeline([["SMEMBERS", stamp.UNNOTE_QUEUE]]))[0]], [0, []]);
  const samCopy = await copyPerson((await erasureScope(shop, sam.email))!);
  const samListed = samCopy.sections.find((s) => s.module === "lib/pdf-stamp.ts")?.records as { stampedCopyOf: string }[] | undefined;
  is("Sam's copy of his data no longer names the removed file", samListed?.map((r) => r.stampedCopyOf), ["Map.pdf"]);

  part("Deleting a buyer also takes their copies off each file's list of notes, and gives their room back");
  is("control: the map's list holds Sam's copy", Number((await redis.pipeline([["SCARD", stamp.stampedFileKey(shop.sid, map)]]))[0]), 1);
  is("the notes are forgotten", await stamp.forgetStampedPerson(shop, sam.email, left), 1);
  is("no entry is left on the map's list, and the room is back", [Number((await redis.pipeline([["EXISTS", stamp.stampedFileKey(shop.sid, map)]]))[0]), (await slot()) - before], [0, 0]);

  part("A removed file with more notes than one call takes is finished by the next calls, never reported done early");
  const big = await pdfFile("Big.pdf", "2026-11-20T12:00:03.000Z");
  const bigList = stamp.stampedFileKey(shop.sid, big);
  const bigFolder = stamp.copyFolder(big);
  const many = UNNOTE_PAGE * UNNOTE_PAGES_PER_CALL + 1;
  const people = Array.from({ length: many }, (_, i) => `${i.toString(16).padStart(32, "0")}`);
  const members = people.map((_, i) => `nl:stamp:copy:${i.toString(16).padStart(40, "0")} ${bigFolder}${i.toString(16).padStart(24, "0")}/Big.pdf`);
  await redis.pipeline([
    ["SADD", bigList, ...people.map((p, i) => `${p} ${members[i]}`)],
    ...people.map((p, i) => ["SADD", `nl:stamp:who:${shop.sid}:${p}`, members[i]]),
    ["HINCRBY", `nl:data:${shop.sid}`, "stamp:who", many * COPY_NOTE_BYTES],
    ["HINCRBY", `nl:data:${shop.sid}`, "#", many * COPY_NOTE_BYTES],
  ]);
  const roomBefore = await slot();
  await stamp.dropStamped(big, shop);
  is("one call takes out at most its pages, and puts the rest down to finish", [Number((await redis.pipeline([["SCARD", bigList]]))[0]), (await redis.pipeline([["SMEMBERS", stamp.UNNOTE_QUEUE]]))[0]], [1, [`${shop.sid} ${bigFolder.split("/")[3]}`]]);
  is("the room of every note taken out is back", roomBefore - (await slot()), (many - 1) * COPY_NOTE_BYTES);
  const next = await stamp.stampedDelivery(guide, kim, shop, meter);
  is("control: the next kept copy is kept", next.kind, "kept");
  is("and it finishes the rest: the list is gone, the queue empty, every note out", [Number((await redis.pipeline([["EXISTS", bigList]]))[0]), (await redis.pipeline([["SMEMBERS", stamp.UNNOTE_QUEUE]]))[0], Number((await redis.pipeline([["SCARD", `nl:stamp:who:${shop.sid}:${people[many - 1]}`]]))[0])], [0, [], 0]);
  is("and the last note's room is back (Kim's new note counted instead)", roomBefore + COPY_NOTE_BYTES - (await slot()), many * COPY_NOTE_BYTES);

  part("An answer about the file's list that is not read exactly: the notes stay, the work stays on the queue, nothing is given back early");
  const odd = await pdfFile("Odd.pdf", "2026-11-20T12:00:04.000Z");
  const oddCopy = await stamp.stampedDelivery(odd, kim, shop, meter);
  is("control: kept and noted", [oddCopy.kind, Number((await redis.pipeline([["SCARD", stamp.stampedFileKey(shop.sid, odd)]]))[0])], ["kept", 1]);
  const oddRoom = await slot();
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((c) => c[0] === "SREM" && c[1] === stamp.stampedFileKey(shop.sid, odd)) ? commands.map(() => "OK") : real(commands)) as typeof redis.pipeline;
  try {
    await stamp.dropStamped(odd, shop);
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  is("the room is not given back on an unknown answer", await slot(), oddRoom);
  is("the file stays on the queue to be finished", ((await redis.pipeline([["SMEMBERS", stamp.UNNOTE_QUEUE]]))[0] as string[]).length, 1);
  const later = await stamp.stampedDelivery(map, kim, shop, meter);
  is("control: the next copy is kept (its own note counted)", later.kind, "kept");
  is("and it finishes the removed file's notes", [(await redis.pipeline([["SMEMBERS", stamp.UNNOTE_QUEUE]]))[0], Number((await redis.pipeline([["EXISTS", stamp.stampedFileKey(shop.sid, odd)]]))[0]), oddRoom + COPY_NOTE_BYTES - (await slot())], [[], 0, COPY_NOTE_BYTES]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
