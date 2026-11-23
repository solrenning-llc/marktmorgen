/**
 * Issue #4304 (Claude 2 C, cost MEDIUM; Claude 6 block of the coordinator's split, 5437), part A: the certificates.
 * The studio's course page (app/studio/course/[product]/page.tsx) draws certificatesFor (lib/certificate.ts) on every
 * visit, and it read every certificate the course ever issued (SMEMBERS of the course's set, then one GET each)
 * before keeping the newest 500. A studio page is priced at STUDIO_PAGE_UNITS units of about 20 commands
 * (tests/plan-cost-registry.ts, the "studio" line), so a course with 2,000 certificates paid about 25 times that on
 * every draw, growing with every student who finished. One draw now reads a bounded page of the course's by-time
 * list, whatever the course holds; certificates issued before that list was kept are added a few at a time, their
 * room taken first, and an erasure gives that room back. Synthetic records, the in-memory Redis.
 */
import { CERT_BACKFILL_PER_DRAW, MAX_LISTED_CERTS, allKey, atKey, certKey, certificatesFor, forgetCertificatesPerson } from "@/lib/certificate";
import { emailKey } from "@/lib/learn";
import { type DataStore, dataUsed, takeData } from "@/lib/store-data";
import { ENTRY_BYTES, dataBytes } from "@/lib/store-data-rules";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const ISSUED = 2_000;
const OLDER = 60;
const STUDIO_COMMANDS = STUDIO_PAGE_UNITS * 20;
const T0 = 1_700_000_000;

const record = (id: string, courseId: string, at: number, email = "a@example.com") =>
  JSON.stringify({ id, name: "Ada Student", title: "Course", store: "shop", creator: "Shop", courseId, productId: "p", email, issuedAt: at, withdrawnAt: 0 });
const idOf = (n: number) => n.toString(36).padStart(16, "0");

const real = redis.pipeline.bind(redis);
let commands = 0;
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands += batch.length;
  return real(batch);
}) as typeof redis.pipeline;
async function counted<T>(read: () => Promise<T>): Promise<[T, number]> {
  commands = 0;
  const value = await read();
  return [value, commands];
}
const used = async (room: DataStore) => (await dataUsed(room))?.used ?? -1;

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
  is(`the draw sends at most a studio page's ${STUDIO_COMMANDS} commands (it sent ${firstCommands})`, firstCommands <= STUDIO_COMMANDS, true);
  is("it still knows how many were issued", first?.total ?? null, ISSUED);
  is("and how many stand (one per student's slot)", first?.standing ?? null, ISSUED - ISSUED / 4);
  is(`it lists a page of ${MAX_LISTED_CERTS}, newest first`, [first?.list.length, first?.list[0]?.issuedAt], [MAX_LISTED_CERTS, T0 + ISSUED - 1]);
  is("an older page follows, and none is missing", [first?.more, first?.unlisted], [true, 0]);
  const [second, secondCommands] = await counted(() => certificatesFor(COURSE, { room: ROOM, page: 1 }));
  is("the next page starts where the first ended", second?.list[0]?.issuedAt ?? null, T0 + ISSUED - 1 - MAX_LISTED_CERTS);
  is(`and is as bounded (${secondCommands} commands)`, secondCommands <= STUDIO_COMMANDS, true);
  const last = await certificatesFor(COURSE, { page: Math.ceil(ISSUED / MAX_LISTED_CERTS) - 1 });
  is("the last page holds the oldest, and none follows", [last?.list.at(-1)?.issuedAt, last?.more], [T0, false]);

  part(`A course with ${OLDER} certificates issued before the by-time list was kept`);
  const OLD = "d".repeat(12);
  for (let i = 0; i < OLDER; i += 1) {
    const id = idOf(10_000 + i);
    redis.run(["SADD", allKey(OLD), id]);
    redis.run(["SET", certKey(id), record(id, OLD, T0 + i, i === 0 ? "old@example.com" : "a@example.com")]);
  }
  is("a draw without the store's room adds none, and says so", (await certificatesFor(OLD))?.unlisted ?? null, OLDER);
  const before = await used(ROOM);
  const [walk, walkCommands] = await counted(() => certificatesFor(OLD, { room: ROOM }));
  is(`one draw adds at most ${CERT_BACKFILL_PER_DRAW} (${walkCommands} commands)`, [walk?.unlisted, walkCommands <= STUDIO_COMMANDS], [OLDER - CERT_BACKFILL_PER_DRAW, true]);
  // The course's first room in the store's data room is opened by this draw, which counts the slot itself once.
  const afterFirst = await used(ROOM);
  is("each added one's entry took room first", afterFirst - before >= CERT_BACKFILL_PER_DRAW * ENTRY_BYTES, true);
  await certificatesFor(OLD, { room: ROOM });
  const caught = await certificatesFor(OLD, { room: ROOM });
  is("three draws add them all", [caught?.unlisted, caught?.total], [0, OLDER]);
  is("the later two took one entry each for the rest", (await used(ROOM)) - afterFirst, (OLDER - CERT_BACKFILL_PER_DRAW) * ENTRY_BYTES);
  const settled = await used(ROOM);
  is("a further draw adds nothing and takes nothing", [(await certificatesFor(OLD, { room: ROOM }))?.unlisted, (await used(ROOM)) - settled], [0, 0]);
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

  part("A full room adds nothing to the by-time list, and the page says some are not listed yet");
  const FULL = "e".repeat(12);
  const small: DataStore = { sid: "full-room-store", tier: "creator", subscriptionActive: false, subscriptionId: "", trialEnds: 0, planEndedAt: "" };
  // Filled until not even one more entry fits: slot by slot, smaller each time it is refused.
  let filler = 0;
  for (const size of [1_000_000, 100_000, 10_000, 1_000, 112]) {
    while ((await takeData(small, [{ slot: `filler${filler}`, bytes: size }])).ok) filler += 1;
  }
  for (let i = 0; i < 3; i += 1) {
    const id = idOf(20_000 + i);
    redis.run(["SADD", allKey(FULL), id]);
    redis.run(["SET", certKey(id), record(id, FULL, T0 + i, emailKey("x@example.com"))]);
  }
  const full = await certificatesFor(FULL, { room: small });
  is("none added, all three said as not listed", [full?.unlisted, full?.list.length, redis.run(["ZCARD", atKey(FULL)])], [3, 0, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
