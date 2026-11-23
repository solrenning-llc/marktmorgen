/**
 * Issue #4304 (Claude 2 C, cost MEDIUM; Claude 6 block of the coordinator's split, 5437), part A: the certificates.
 * The studio's course page (app/studio/course/[product]/page.tsx) draws certificatesFor (lib/certificate.ts) on every
 * visit, and it read every certificate the course ever issued (SMEMBERS of the course's set, then one GET each)
 * before keeping the newest 500. A studio page is priced at STUDIO_PAGE_UNITS units of about 20 commands
 * (tests/plan-cost-registry.ts, the "studio" line), so a course with 2,000 certificates paid about 25 times that on
 * every draw, growing with every student who finished. One draw now reads a bounded page of the course's by-time
 * list, whatever the course holds; certificates issued before that list was kept are added a few at a time by a walk,
 * their room taken first, and an erasure gives that room back once. Held here too, from Claude 5 iYnra's review of
 * 17ca8336f4: the steady draw's exact commands, the walk never stalling on ids that cannot be added, a full room said
 * as such, the room given back exactly in each race, and a walk that does not read never hiding the page.
 * Synthetic records, the in-memory Redis.
 */
import { CERT_BACKFILL_PER_DRAW, MAX_LISTED_CERTS, allKey, atKey, certKey, certificatesFor, forgetCertificatesPerson, issueCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import { type DataStore, dataUsed, takeData } from "@/lib/store-data";
import { ENTRY_BYTES, dataBytes } from "@/lib/store-data-rules";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const ISSUED = 2_000;
const OLDER = 60;
const STUDIO_COMMANDS = STUDIO_PAGE_UNITS * 20;
const T0 = 1_700_000_000;

const record = (id: string, courseId: string, at: number, email = "a@example.com") =>
  JSON.stringify({ id, name: "Ada Student", title: "Course", store: "shop", creator: "Shop", courseId, productId: "p", email, issuedAt: at, withdrawnAt: 0 });
const idOf = (n: number) => n.toString(36).padStart(16, "0");
const cursorKey = (courseId: string) => `nl:course:${courseId}:certs:atc`;

const real = redis.pipeline.bind(redis);
let commands = 0;
/** Lets a test answer or act before a batch reaches Redis; null passes it through. */
let before: ((batch: (string | number)[][]) => unknown[] | null) | null = null;
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands += batch.length;
  const answered = before ? before(batch) : null;
  return answered ?? real(batch);
}) as typeof redis.pipeline;
async function counted<T>(read: () => Promise<T>): Promise<[T, number]> {
  commands = 0;
  const value = await read();
  return [value, commands];
}
const used = async (room: DataStore) => (await dataUsed(room))?.used ?? -1;
const seedOlder = (courseId: string, from: number, count: number, email = "a@example.com") => {
  for (let i = 0; i < count; i += 1) {
    const id = idOf(from + i);
    redis.run(["SADD", allKey(courseId), id]);
    redis.run(["SET", certKey(id), record(id, courseId, T0 + i, email)]);
  }
};

const lesson = { id: "lesson000001", title: "One", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null } as unknown as Course["modules"][number]["lessons"][number];
const courseOf = (id: string): Course => ({ id, certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson] }] }) as Course;
const issueInput = (course: Course, who: string) => ({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email: `${who}@example.com`, who: emailKey(`${who}@example.com`), name: "Ana Lopes", room: ROOM });

async function main(): Promise<void> {
  redis.clear();

  part(`A course with ${ISSUED} certificates on its by-time list: one studio draw reads a bounded page`);
  const COURSE = "c".repeat(12);
  for (let i = 0; i < ISSUED; i += 1) {
    redis.run(["SADD", allKey(COURSE), idOf(i)]);
    redis.run(["ZADD", atKey(COURSE), T0 + i, idOf(i)]);
    redis.run(["SET", certKey(idOf(i)), record(idOf(i), COURSE, T0 + i)]);
    if (i % 4 !== 0) redis.run(["HSET", `nl:course:${COURSE}:certs`, `student${i}`, idOf(i)]);
  }
  const [first, firstCommands] = await counted(() => certificatesFor(COURSE, { room: ROOM }));
  is(`a steady draw sends exactly 6 commands: the counts and the walk's place, a page, its records (it sent ${firstCommands})`, firstCommands, 6);
  is(`  (within a studio page's ${STUDIO_COMMANDS})`, firstCommands <= STUDIO_COMMANDS, true);
  is("it still knows how many were issued", first?.total ?? null, ISSUED);
  is("and how many stand (one per student's slot)", first?.standing ?? null, ISSUED - ISSUED / 4);
  is(`it lists a page of ${MAX_LISTED_CERTS}, newest first`, [first?.list.length, first?.list[0]?.issuedAt], [MAX_LISTED_CERTS, T0 + ISSUED - 1]);
  is("an older page follows, and none is missing", [first?.more, first?.unlisted, first?.roomFull], [true, 0, false]);
  const [second, secondCommands] = await counted(() => certificatesFor(COURSE, { room: ROOM, page: 1 }));
  is("the next page starts where the first ended", second?.list[0]?.issuedAt ?? null, T0 + ISSUED - 1 - MAX_LISTED_CERTS);
  is(`and is as bounded (${secondCommands} commands)`, secondCommands, 6);
  const last = await certificatesFor(COURSE, { page: Math.ceil(ISSUED / MAX_LISTED_CERTS) - 1 });
  is("the last page holds the oldest, and none follows", [last?.list.at(-1)?.issuedAt, last?.more], [T0, false]);
  const past = await certificatesFor(COURSE, { page: 999 });
  is("a page past the end lists none, with the total still known (the page says so, never 'nobody finished')", [past?.list.length, past?.total], [0, ISSUED]);

  part(`A course with ${OLDER} certificates issued before the by-time list was kept`);
  const OLD = "d".repeat(12);
  seedOlder(OLD, 10_000, OLDER);
  redis.run(["SET", certKey(idOf(10_000)), record(idOf(10_000), OLD, T0, "old@example.com")]);
  is("a draw without the store's room adds none, and says how many wait", (await certificatesFor(OLD))?.unlisted ?? null, OLDER);
  const before0 = await used(ROOM);
  const [walk, walkCommands] = await counted(() => certificatesFor(OLD, { room: ROOM }));
  is(`one draw adds at most ${CERT_BACKFILL_PER_DRAW} (${walkCommands} commands, room scripts included)`, [walk?.unlisted, walkCommands <= STUDIO_COMMANDS], [OLDER - CERT_BACKFILL_PER_DRAW, true]);
  // The first draw also keeps the walk's place, its room taken for as long as it lives.
  const afterFirst = await used(ROOM);
  is("each added one's entry took room first, and the walk's place its own", afterFirst - before0 > CERT_BACKFILL_PER_DRAW * ENTRY_BYTES, true);
  await certificatesFor(OLD, { room: ROOM });
  const third = await certificatesFor(OLD, { room: ROOM });
  is("three draws add them all, 25 a step through one SSCAN page larger than a step", [third?.unlisted, third?.total], [0, OLDER]);
  is("the later two took one entry each for the rest", (await used(ROOM)) - afterFirst, (OLDER - CERT_BACKFILL_PER_DRAW) * ENTRY_BYTES);
  const settled = await used(ROOM);
  const [steady, steadyCommands] = await counted(() => certificatesFor(OLD, { room: ROOM }));
  is("a further draw adds nothing, takes nothing and is a steady draw again", [steady?.unlisted, (await used(ROOM)) - settled, steadyCommands], [0, 0, 6]);
  const listed: number[] = [];
  for (let page = 0; page < 3; page += 1) listed.push(...((await certificatesFor(OLD, { page }))?.list.map((c) => c.issuedAt) ?? []));
  is("every one is listed, newest first", listed, Array.from({ length: OLDER }, (_, i) => T0 + OLDER - 1 - i));

  part("Erasing a student gives back the entry their certificate took on the by-time list, and only that");
  const oldest = idOf(10_000);
  const recordBytes = dataBytes([record(oldest, OLD, T0, "old@example.com")], 3);
  const beforeErase = await used(ROOM);
  is("the student's one certificate is deleted", await forgetCertificatesPerson([OLD], "old@example.com", ROOM), 1);
  is("it is off the by-time list", redis.run(["ZSCORE", atKey(OLD), oldest]), null);
  is("its record's room and its entry come back", beforeErase - (await used(ROOM)), recordBytes + ENTRY_BYTES);

  part("Ids that can never be added (records gone, malformed or another course's) never stall the walk nor keep the note");
  const DEAD = "e".repeat(12);
  for (let i = 0; i < 30; i += 1) redis.run(["SADD", allKey(DEAD), idOf(20_000 + i)]);
  redis.run(["SET", certKey(idOf(20_005)), "{not json"]);
  redis.run(["SET", certKey(idOf(20_006)), record(idOf(20_006), "f".repeat(12), T0)]);
  seedOlder(DEAD, 20_100, 2);
  let deadPage = await certificatesFor(DEAD, { room: ROOM });
  for (let draw = 0; draw < 6 && (deadPage?.unlisted ?? 1) > 0; draw += 1) deadPage = await certificatesFor(DEAD, { room: ROOM });
  is("the two that can be added are listed", deadPage?.list.length ?? null, 2);
  is("and once a whole round added none, the walk is done: nothing more is said as waiting", [deadPage?.unlisted, redis.run(["GET", cursorKey(DEAD)])], [0, "done"]);
  const [deadSteady, deadCommands] = await counted(() => certificatesFor(DEAD, { room: ROOM }));
  is("so a draw is steady again, 6 commands", [deadSteady?.unlisted, deadCommands], [0, 6]);
  is("the walk's place expires (it never stays for good)", Number(redis.run(["TTL", cursorKey(DEAD)])) > 0, true);

  part("A full room adds nothing to the by-time list, and the page says the room is full");
  const FULL = "a".repeat(12);
  const small: DataStore = { sid: "full-room-store", tier: "creator", subscriptionActive: false, subscriptionId: "", trialEnds: 0, planEndedAt: "" };
  let filler = 0;
  for (const size of [1_000_000, 100_000, 10_000, 1_000, 112]) {
    while ((await takeData(small, [{ slot: `filler${filler}`, bytes: size }])).ok) filler += 1;
  }
  seedOlder(FULL, 30_000, 3);
  const full = await certificatesFor(FULL, { room: small });
  is("none added, all three said as waiting, the room said full", [full?.unlisted, full?.list.length, full?.roomFull, redis.run(["ZCARD", atKey(FULL)])], [3, 0, true, 0]);

  part("A fresh walk with no room for its place says the room is full, never a walk that silently never moves (Claude 5 iYwjc's LEVE A on #5481)");
  const NOPLACE = "7".repeat(12);
  // Its one waiting id's record is gone: nothing to add, so only the walk's place needs room, and the room is full.
  redis.run(["SADD", allKey(NOPLACE), idOf(40_000)]);
  let noPlace = await certificatesFor(NOPLACE, { room: small });
  for (let draw = 0; draw < 4; draw += 1) noPlace = await certificatesFor(NOPLACE, { room: small });
  is("after five draws: the one waiting said as waiting, the room said full, no place written", [noPlace?.unlisted, noPlace?.roomFull, redis.run(["GET", cursorKey(NOPLACE)])], [1, true, null]);

  part("A walk that cannot go on is said as such, never as more being added (Claude 3 wSUb3's and Claude 5 ichw's LEVE on #5481)");
  const UNREAD = "4".repeat(12);
  seedOlder(UNREAD, 50_000, 30);
  // A place that does not read. Production never writes one (every first write is SET NX EX), and this one has no expiry.
  redis.run(["SET", cursorKey(UNREAD), "not-a-walk"]);
  const unread1 = await certificatesFor(UNREAD, { room: ROOM });
  const unread2 = await certificatesFor(UNREAD, { room: ROOM });
  is("two draws: all 30 said as waiting, none added, the walk said as stopped on both, never the room", [unread1?.unlisted, unread2?.unlisted, redis.run(["ZCARD", atKey(UNREAD)]), unread1?.walkProblem, unread2?.walkProblem, unread2?.roomFull], [30, 30, 0, "place", "place", false]);
  is("and the place is left as it was, never started again on a guess", redis.run(["GET", cursorKey(UNREAD)]), "not-a-walk");
  const MID = "3".repeat(12);
  seedOlder(MID, 60_000, 30);
  const mid1 = await certificatesFor(MID, { room: ROOM });
  is("control: a walk mid-way with room is said as going, its place valid and not done", [mid1?.walkProblem, mid1?.unlisted, mid1?.roomFull, redis.run(["GET", cursorKey(MID)]) !== "done"], [null, 30 - CERT_BACKFILL_PER_DRAW, false, true]);
  is("and a full room is said as the room, never as a stopped walk", [full?.walkProblem, noPlace?.walkProblem], [null, null]);
  const AFTER = "2".repeat(12);
  seedOlder(AFTER, 70_000, 3);
  // The step's ZADD lands, then the walk's first place SET answers in a shape that does not read.
  before = (batch) => (batch.length === 1 && batch[0][0] === "SET" && batch[0][1] === cursorKey(AFTER) && batch[0].includes("NX") ? ["weird"] : null);
  const after = await certificatesFor(AFTER, { room: ROOM });
  before = null;
  is("a step that adds and then fails: the three are listed, none said as waiting, the step said as failed", [after?.list.length, redis.run(["ZCARD", atKey(AFTER)]), after?.unlisted, after?.walkProblem], [3, 3, 0, "step"]);
  const studioPage = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  const note = studioPage.slice(studioPage.indexOf("{certificates.unlisted > 0 ? ("), studioPage.indexOf("Up to 25 more are added") + 40);
  const order = ['certificates.walkProblem === "place"', "They can't be added for now.", 'certificates.walkProblem === "step"', "Opening this page again tries again.", "certificates.roomFull", "Up to 25 more are added"].map((text) => note.indexOf(text));
  is("the page's note, inside the waiting block, says a stopped walk, then a failed step, then a full room, then progress", order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), true);

  part("A walk that does not read is left for the next draw and never hides the page (Claude 5 iYnra's NIT 8)");
  const ODD = "b".repeat(12);
  seedOlder(ODD, 40_000, 3);
  redis.run(["ZADD", atKey(ODD), T0 + 9, idOf(40_009)]);
  redis.run(["SET", certKey(idOf(40_009)), record(idOf(40_009), ODD, T0 + 9)]);
  redis.run(["SADD", allKey(ODD), idOf(40_009)]);
  redis.run(["SET", cursorKey(ODD), "not a place"]);
  let zadds = 0;
  before = (batch) => {
    if (batch.some((c) => c[0] === "ZADD")) zadds += 1;
    return null;
  };
  const odd = await certificatesFor(ODD, { room: ROOM });
  is("a walk's place that does not read: no walk, the page still listed", [odd?.list.map((c) => c.issuedAt), zadds], [[T0 + 9], 0]);
  redis.run(["DEL", cursorKey(ODD)]);
  before = (batch) => (batch.length === 1 && batch[0][0] === "ZMSCORE" ? ["not a list"] : null);
  const oddScores = await certificatesFor(ODD, { room: ROOM });
  is("a ZMSCORE that does not read: no ZADD, the page still listed, and the step said as failed", [oddScores?.list.length, redis.run(["ZCARD", atKey(ODD)]), oddScores?.walkProblem], [1, 1, "step"]);
  const beforeOdd = await used(ROOM);
  before = (batch) => (batch.length === 1 && batch[0][0] === "ZADD" ? ["three"] : null);
  const oddCount = await certificatesFor(ODD, { room: ROOM });
  is("a ZADD count that does not read: the page still listed, and the room taken stays taken (it only counts too much)", [oddCount?.list.length, (await used(ROOM)) - beforeOdd >= 3 * ENTRY_BYTES], [1, true]);
  before = null;

  part("Races give the room back exactly (Claude 5 iYnra's LEVE 2 and 3)");
  // What a first walk of a course takes for n added ids, with no race: its entries, its walk's place and its slot.
  const walked = async (courseId: string, from: number, n: number) => {
    seedOlder(courseId, from, n);
    const at = await used(ROOM);
    await certificatesFor(courseId, { room: ROOM });
    return (await used(ROOM)) - at;
  };
  const threeWalked = await walked("6".repeat(12), 70_000, 3);
  const oneWalked = await walked("5".repeat(12), 80_000, 1);
  is("(a control: three added take three entries more than one)", threeWalked - oneWalked, 2 * ENTRY_BYTES);
  const RACE = "9".repeat(12);
  seedOlder(RACE, 50_000, 4);
  // Another draw adds the first of them between this draw's ZMSCORE and its ZADD.
  before = (batch) => {
    if (batch.length === 1 && batch[0][0] === "ZADD" && batch[0][2] === "NX") {
      before = null;
      redis.run(["ZADD", atKey(RACE), T0, idOf(50_000)]);
    }
    return null;
  };
  const raceBefore = await used(ROOM);
  await certificatesFor(RACE, { room: ROOM });
  is("a draw that finds one added meanwhile takes room for the three it added, not four", (await used(ROOM)) - raceBefore, threeWalked);
  // An erasure takes a record away between the draw's read of it and its ZADD.
  const GONE = "8".repeat(12);
  seedOlder(GONE, 60_000, 2);
  before = (batch) => {
    if (batch.length === 1 && batch[0][0] === "ZADD" && batch[0][2] === "NX") {
      before = null;
      redis.run(["DEL", certKey(idOf(60_001))]);
    }
    return null;
  };
  const goneBefore = await used(ROOM);
  await certificatesFor(GONE, { room: ROOM });
  is("an id whose record went meanwhile is taken off again", [redis.run(["ZSCORE", atKey(GONE), idOf(60_001)]), redis.run(["ZSCORE", atKey(GONE), idOf(60_000)]) !== null], [null, true]);
  is("and its entry given back: the room keeps one entry, for the one that stands", (await used(ROOM)) - goneBefore, oneWalked);
  // An issue whose by-time write finds the id there already (a draw between its SADD and its ZADD).
  const ISSUE = courseOf("7".repeat(32));
  await issueCertificate(issueInput(ISSUE, "warmup"));
  const control = await used(ROOM);
  await issueCertificate(issueInput(ISSUE, "contro"));
  const controlTaken = (await used(ROOM)) - control;
  before = (batch) => {
    const zadd = batch.find((c) => c[0] === "ZADD" && String(c[1]).endsWith(":certs:at"));
    if (zadd) {
      before = null;
      redis.run(["ZADD", String(zadd[1]), T0, String(zadd[zadd.length - 1])]);
    }
    return null;
  };
  const raced = await used(ROOM);
  await issueCertificate(issueInput(ISSUE, "raceda"));
  is("an issue whose by-time entry another draw added gives its own reserved entry back", (await used(ROOM)) - raced, controlTaken - ENTRY_BYTES);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
