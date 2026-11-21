/**
 * "Certificates earned" in a sales page's "By the numbers" block (93 [D2-VERIFIED-SOCIAL], unit 1;
 * docs/verified-social-proof.md; lib/certificate.ts earnedCount, lib/page-facts.ts, lib/page-facts-read.ts,
 * lib/sales-page.ts, lib/buyer-words/finished.ts and the product page; added 12 November 2026). Checked:
 *
 *   - a slot index is not a verified certificate count: while verification is unavailable, a nonempty
 *     index is unknown; one command, never a fabricated zero or a public figure;
 *   - it is said only for a course and only from ten up, with words that say exactly what was counted
 *     ("students earned the certificate"), never "students", "happy customers" or "graduates";
 *   - a new block does not start with it checked, and a saved block keeps it when the creator checked it;
 *   - the studio names an unverified nonempty index as unread; a failed issuance never becomes a fact;
 *   - the product page reads it only when a "By the numbers" block of the page asks for it (read in its source);
 *   - every language has the words.
 */
import { readFileSync } from "node:fs";
import { earnedCount, issueCertificate, withdrawCertificate } from "@/lib/certificate";
import { FINISHED_SHOWN_FROM, pageFacts } from "@/lib/page-facts";
import { readPageFacts } from "@/lib/page-facts-read";
import { FACT_KEYS, FACTS_ON_BY_DEFAULT, emptyBlock, parsePage } from "@/lib/sales-page";
import { FINISHED_WORDS } from "@/lib/buyer-words/finished";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { UnknownReply } from "@/lib/redis-exact";
import type { Listing, Store } from "@/lib/store";
import { emptyCourse, saveCourse } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

// A real course, saved, that gives a certificate (lib/course.ts); its id is made when it is made.
const certCourse = { ...emptyCourse(), certificate: true };
const COURSE = certCourse.id;
const index = `nl:course:${COURSE}:certs`;

let commands = 0;
const real = redis.pipeline.bind(redis);
let broken = false;
let loseSlotReplyFor: string | null = null;
let lostSlotId: string | null = null;
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  const slot = list.find((c) => c[0] === "HSETNX" && c[1] === loseSlotReplyFor);
  if (slot) {
    loseSlotReplyFor = null;
    lostSlotId = String(slot[3]);
    return real(list).then(() => { throw new Error("synthetic: slot applied, reply lost"); });
  }
  if (broken && list.some((c) => c[0] === "HLEN")) return Promise.resolve(list.map(() => "twelve")) as ReturnType<typeof redis.pipeline>;
  return real(list);
}) as typeof redis.pipeline;

async function unverified(courseId: string): Promise<boolean> {
  try {
    await earnedCount(courseId);
    return false;
  } catch (error) {
    if (!(error instanceof UnknownReply)) throw error;
    return true;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await saveCourse(certCourse, ROOM);

  part("The count");
  is("a course nobody finished: zero", await earnedCount(COURSE), 0);
  for (let i = 0; i < 12; i += 1) {
    const id = `cert${String(i).padStart(12, "0")}`;
    await redis.pipeline([
      ["SET", `nl:cert:${id}`, JSON.stringify({ id, store: "s", productId: "p", courseId: COURSE, name: `Student ${i}`, title: "T", creator: "C", email: `s${i}@example.com`, issuedAt: 1, withdrawnAt: 0 })],
      ["HSET", index, `who${i}`, id],
      ["SADD", `${index}:all`, id],
    ]);
  }
  commands = 0;
  is("a nonempty slot index is unverified, in one command", [await unverified(COURSE), commands], [true, 1]);
  // withdrawCertificate looks the student up by the address's key (lib/learn.ts emailKey); the slot is that key here.
  const { emailKey } = await import("@/lib/learn");
  await redis.pipeline([["HDEL", index, "who3"], ["HSET", index, emailKey("s3@example.com"), "cert000000000003"]]);
  is("withdrawal succeeds but does not certify the remaining index", [await withdrawCertificate(COURSE, "cert000000000003"), await unverified(COURSE)], [true, true]);
  broken = true;
  let threw: unknown = null;
  try {
    await earnedCount(COURSE);
  } catch (error) {
    threw = error;
  }
  broken = false;
  is("a reply that is not a count is unknown, never zero", threw instanceof UnknownReply, true);

  part("A failed issuance is not proof of a certificate");
  const uncertainCourse = { ...emptyCourse(), certificate: true };
  await saveCourse(uncertainCourse, ROOM);
  const uncertainIndex = `nl:course:${uncertainCourse.id}:certs`;
  for (let i = 0; i < 9; i += 1) {
    const id = `cert${String(100 + i).padStart(12, "0")}`;
    await redis.pipeline([
      ["HSET", uncertainIndex, `who${i}`, id],
      ["SET", `nl:cert:${id}`, JSON.stringify({
        id, store: "s", productId: "p", courseId: uncertainCourse.id,
        name: `Student ${i}`, title: "T", creator: "C",
        email: `u${i}@example.com`, issuedAt: 1, withdrawnAt: 0,
      })],
    ]);
  }
  // Execute the real issue path: HSETNX takes the tenth slot, its reply is
  // lost, then issueCertificate's catch removes the just-written record.
  lostSlotId = null;
  loseSlotReplyFor = uncertainIndex;
  const failedIssue = await issueCertificate({
    store: "s", productId: "p", course: uncertainCourse,
    title: "T", creator: "C", email: "u9@example.com", who: "who9",
    name: "Student Nine", room: ROOM,
  }).then(() => false, () => true);
  loseSlotReplyFor = null;
  is("control: the issue failed after claiming its slot", [failedIssue, lostSlotId !== null], [true, true]);
  const [slots, gone] = await redis.pipeline([
    ["HLEN", uncertainIndex], ["GET", `nl:cert:${lostSlotId}`],
  ]);
  is("control: ten slots but no tenth certificate", [slots, gone], [10, null]);
  const uncertainStore = { statsId: "st_uncertain_finished", language: "en", look: { sold: false } } as unknown as Store;
  const uncertainProduct = { id: "p", course: { id: uncertainCourse.id, lessons: 8 }, bundle: null } as unknown as Listing;
  const missing = await readPageFacts(uncertainStore, uncertainProduct);
  is("nine certificates and a failed tenth issue never advertise ten",
    [missing.facts.finished, missing.factsUnread.includes("finished")], [undefined, true]);

  part("What the block says");
  const course = { course: { lessons: 8 } };
  const facts = (finished: number | null, product: Parameters<typeof pageFacts>[0]["product"] = course) =>
    pageFacts({ language: "en", locale: "en-US", product, bundleItems: null, sold: null, reviews: null, finished });
  is("from ten up, with exactly what was counted", facts(12).finished, { key: "finished", value: "12", label: "students earned the certificate" });
  is("the threshold is ten", FINISHED_SHOWN_FROM, 10);
  is("below ten, unread or not a course: nothing", [facts(9).finished, facts(null).finished, facts(40, {}).finished], [undefined, undefined, undefined]);
  is("in the store's language and its own way of writing numbers", pageFacts({ language: "de", locale: "de-DE", product: course, bundleItems: null, sold: null, reviews: null, finished: 1200 }).finished, { key: "finished", value: "1.200", label: "Teilnehmende haben das Zertifikat erhalten" });
  is("French says participants, as for adults", pageFacts({ language: "fr", locale: "fr-FR", product: course, bundleItems: null, sold: null, reviews: null, finished: 12 }).finished?.label, "participants ont obtenu le certificat");

  part("The creator's choice");
  is("it is one of the numbers a block may show", FACT_KEYS.some((f) => f.key === "finished"), true);
  is("a new block does not start with it checked", FACTS_ON_BY_DEFAULT.includes("finished"), false);
  is("but starts with every other number, as before", FACTS_ON_BY_DEFAULT, FACT_KEYS.map((f) => f.key).filter((k) => k !== "finished"));
  const fresh = emptyBlock("facts", "facts0");
  is("the block the studio adds has exactly those checked", fresh.kind === "facts" ? fresh.show : null, FACT_KEYS.map((f) => f.key).filter((k) => k !== "finished"));
  const saved = parsePage({ blocks: [{ id: "facts1", kind: "facts", heading: "", show: ["lessons", "finished", "made-up"] }] });
  const block = saved?.blocks.find((b) => b.kind === "facts");
  is("a saved block keeps it when checked, and drops a number that does not exist", block && block.kind === "facts" ? block.show : null, ["lessons", "finished"]);

  part("The studio's preview");
  const store = { statsId: "st_finished", language: "en", look: { sold: false } } as unknown as Store;
  const product = { id: "p1", course: { id: COURSE, lessons: 8 }, bundle: null } as unknown as Listing;
  const read = await readPageFacts(store, product);
  is("an unverified index is omitted and named as unread", [read.facts.finished?.value, read.factsUnread.includes("finished")], [undefined, true]);
  broken = true;
  const failed = await readPageFacts(store, product);
  broken = false;
  is("a failed read is named as unread, not as none", [failed.facts.finished, failed.factsUnread.includes("finished")], [undefined, true]);
  commands = 0;
  await readPageFacts(store, { ...product, course: null } as unknown as Listing);
  const withoutCourse = commands;
  commands = 0;
  await readPageFacts(store, product);
  is("not a course: no read for it (the course and the count fewer)", commands - withoutCourse >= 2, true);
  await saveCourse({ ...certCourse, certificate: false }, ROOM);
  const off = await readPageFacts(store, product);
  is(
    "a course that no longer gives a certificate: not shown, and not said to be unread (it would seem to promise one)",
    [off.facts.finished, off.factsUnread.includes("finished")],
    [undefined, false],
  );
  await saveCourse(certCourse, ROOM);

  part("The product page");
  const page = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is(
    "it reads the count only when a block of the page asks for it and the course gives a certificate now",
    page.includes('product.course && certificateOn && page.blocks.some((block) => block.kind === "facts" && block.show.includes("finished"))') &&
      page.includes("certificateOn: course?.certificate === true,") &&
      page.includes("const certificateOn = courseFacts?.certificateOn === true;") &&
      page.includes("await earnedCount(product.course.id).catch(() => null)"),
    true,
  );
  is("and hands it to the same pageFacts the preview asks", /reviews: summary,\s*finished,\s*\}\)/.test(page), true);

  part("Every language");
  for (const code of LANGUAGE_CODES) {
    is(`${code}: words for ten and more`, FINISHED_WORDS[code](12).length > 10, true);
  }
  const all = JSON.stringify(LANGUAGE_CODES.map((c) => FINISHED_WORDS[c](12)));
  is("never graduates, happy or successful customers", /graduat|happy|success|satisf/i.test(all), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
