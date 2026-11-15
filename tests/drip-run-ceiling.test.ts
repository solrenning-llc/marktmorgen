/**
 * A ceiling on the drip emails' marks before they are spent (lib/learn.ts, sendDripEmails; the MR rule: a ceiling
 * before every spend; found under Claude 7's MÉDIO on #3344). The walk tries one SET NX of a mark for each student and
 * module that opened in the last three days, on every daily run, and lets the mark go when the send is refused; the
 * students are bounded only by the store's data room, so with the store's email figure spent every send is refused,
 * and the marks alone, at three runs a pair, cost more in a worst month than a plan's whole net profit.
 *
 * Now a run stops trying marks in a course after DRIP_REFUSALS_PER_COURSE sends that did not go (refused or not
 * confirmed), and in a store after DRIP_REFUSALS_PER_STORE, until the next run; a store is read once a run, not once a
 * course. So the marks a store spends a month are bounded by its email figure (each one sent: one mark, and at most two
 * more "taken" in its window) plus the refusals' ceiling, never by its students. The effect for a student: while a
 * course's sends are refused, the rest of its students wait for the next run, inside the same three-day window; what
 * is sent is never sent twice. No price or limit changes.
 *
 * Since the drip index (docs/drip-due-index.md; tests/drip-due-index.test.ts) the run reads each store's pairs due, not
 * its courses: the same ceilings hold over the pairs, the store's at five, and the cost line follows the email figure.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and the synthetic SES (tests/ses-mail-fixture.ts).
 */
import { claimHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { DRIP_REFUSALS_PER_COURSE, DRIP_REFUSALS_PER_STORE, emailKey, sendDripEmails } from "@/lib/learn";
import { type Course, readCoursesEach } from "@/lib/course";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { type SesMailFixtureOptions, installSesMailFixture } from "./ses-mail-fixture";
import { readFileSync } from "node:fs";
import { COST_LINES, DRIP_PAGE_ROWS, DRIP_REFUSALS_PER_STORE_RUN, DRIP_RUN_FIXED_COMMANDS, dripEntriesPerRun, dripRunCommandsPerStore, dripRunMonthlyUsd } from "./plan-cost-registry";
import { done, is, part } from "./check";

const sesHooks: SesMailFixtureOptions = {};
const mail = installSesMailFixture(sesHooks);
type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const seen: Cmd[] = [];
/** A test's hand on a batch: answers it itself when it returns a promise. */
let inject: ((commands: Cmd[]) => Promise<unknown[]> | null) | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  seen.push(...commands);
  return inject?.(commands) ?? original(commands);
}) as typeof redis.pipeline;

const NOW = Math.floor(Date.now() / 1000);
const DRIP = "nl:courses:drip";
const lesson = { id: "lesson000001", title: "First", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null };
const courseWith = (id: string) => ({ id, certificate: false, startsAt: null, modules: [{ id: "module000002", title: "Week two", dripDays: 1, lessons: [lesson] }] }) as unknown as Course;
const COURSES = ["a", "b", "c", "d", "e", "f", "1", "2"].map((c) => courseWith(c.repeat(32)));
const products = COURSES.map((course, n) => ({ id: `prod00000${String(n).padStart(3, "0")}`, title: `Course ${n}`, summary: "", priceCents: 6900, createdAt: 1, course: { id: course.id } }));
const OWNER = "drip-ceiling@example.com";

async function setup(courses: number): Promise<Store> {
  redis.clear();
  mail.configure();
  await claimHandle(OWNER, "drip-ceiling-shop", "Drip Ceiling Shop", "");
  await setSubscription(OWNER, { customerId: "cus_DripCeiling01", subscriptionId: "sub_DripCeiling01", active: true, tier: "pro", cycle: "month", trialEnds: 0, period: paidPeriod() });
  const real = (await storeForEmail(OWNER))!;
  const store = { ...real, catalog: { ...real.catalog, items: products.slice(0, courses).map((p) => ({ id: p.id })), inline: products.slice(0, courses) } } as unknown as Store;
  for (let n = 0; n < courses; n += 1) {
    await original([["SADD", DRIP, `${COURSES[n].id}|${store.handle}|${products[n].id}`]]);
    for (let s = 0; s < 30; s += 1) {
      const email = `student-${n}-${s}@example.com`;
      await original([["HSET", `nl:course:${COURSES[n].id}:students`, emailKey(email), JSON.stringify({ e: email, s: NOW - 36 * 3600, l: NOW })]]);
    }
  }
  return store;
}
const loadCourse = async (id: string) => COURSES.find((course) => course.id === id) ?? null;
const claims = () => seen.filter((c) => c[0] === "SET" && String(c[1]).includes(":dripmail:")).length;
const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = log;
  }
};

async function main(): Promise<void> {
  part("The ceilings are named and small");
  // The store's ceiling from 20 to 5 with the drip index (docs/drip-due-index.md): five refused sends in a day already
  // say its sends are not going, and a course with refusals does not hold back its other courses.
  is("a course stops after a few refused sends, a store after five", [DRIP_REFUSALS_PER_COURSE, DRIP_REFUSALS_PER_STORE], [3, 5]);

  part("The walk's worst month, a line of each plan (course-drip-run), from the same numbers as the code");
  const source = readFileSync("lib/learn.ts", "utf8");
  is("the registry's ceiling and page are the code's", [DRIP_REFUSALS_PER_STORE_RUN === DRIP_REFUSALS_PER_STORE, source.includes(`const DRIP_PAGE = ${DRIP_PAGE_ROWS};`)], [true, true]);
  is("a line of every plan's worst month", COST_LINES.some((line) => line.id === "course-drip-run"), true);
  const month = (["creator", "pro", "scale"] as const).map((tier) => Math.round(dripRunMonthlyUsd(tier) * 100) / 100);
  // Store, Studio and Scale at full use: with the index (docs/drip-due-index.md) a few cents, where the marks without
  // the ceiling cost more than each plan's whole net profit and the walk of every course 31 to 87 cents.
  is("Store, Studio and Scale a month, in dollars", month, [0.01, 0.02, 0.03]);

  part("Every send refused (the store's email figure spent): the marks stop at the ceilings, not at the students");
  {
    const store = await setup(8);
    sesHooks.onSes = () => new Response(JSON.stringify({ message: "synthetic: refused" }), { status: 400, headers: { "content-type": "application/json" } });
    seen.length = 0;
    let loads = 0;
    const run = await quietly(() => sendDripEmails(async () => { loads += 1; return store; }, loadCourse, "https://marktmorgen.com", NOW, Date.now() + 60_000));
    sesHooks.onSes = undefined;
    is("nothing sent", run.sent, 0);
    is("at most DRIP_REFUSALS_PER_STORE marks in the store, DRIP_REFUSALS_PER_COURSE in each course", [claims() <= DRIP_REFUSALS_PER_STORE, claims()], [true, Math.min(8 * DRIP_REFUSALS_PER_COURSE, DRIP_REFUSALS_PER_STORE)]);
    is("of 240 students due, so the marks follow the ceiling, not the students", claims() < 240, true);
    is("the store read once for the run, not once a course", loads, 1);
    // Every command of the run, from the cost line's own formula: the run's own sets and cursor; the old set's courses
    // moved to the store's pending set (two SADDs and the old set's SREM, once); and one store's run, its walk of the
    // eight courses into its index inside the page budget and its pairs due read, a third of its email figure.
    const most = DRIP_RUN_FIXED_COMMANDS + 3 + dripRunCommandsPerStore(dripEntriesPerRun("pro"));
    is(`the run's commands (${seen.length}) stay within the formula (${most})`, seen.length <= most, true);
  }

  part("Every send goes: everyone due is emailed once, and the next run sends nothing more");
  {
    const store = await setup(2);
    seen.length = 0;
    const run = await quietly(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW, Date.now() + 60_000));
    // A run reads a seventh of the Studio email figure (43 pairs); the rest wait in the index for the next run.
    is("the first run: as many as a run reads", run.sent, dripEntriesPerRun("pro"));
    const second = await quietly(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW + 86_400, Date.now() + 60_000));
    is("the next day's run: the rest; sixty students, sixty emails, sixty marks, none lost", [run.sent + second.sent, claims()], [60, 60]);
    const again = await quietly(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW, Date.now() + 60_000));
    is("the next run: none sent again", again.sent, 0);
  }

  part("A course whose sends are refused does not hold back the store's other courses");
  {
    const store = await setup(2);
    sesHooks.onSes = (message) => (message.to.some((address) => address.startsWith("student-0-")) ? new Response(JSON.stringify({ message: "synthetic: refused" }), { status: 400, headers: { "content-type": "application/json" } }) : undefined);
    // Over the window's runs (a seventh of the email figure a run): the refused course stops at its ceiling, the other goes.
    let sent = 0;
    for (let n = 0; n < 7; n += 1) sent += (await quietly(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW + n * 86_400, Date.now() + 60_000))).sent;
    sesHooks.onSes = undefined;
    is("the other course's thirty are emailed", sent, 30);
  }

  part("Courses read a hundred at a command (readCoursesEach), never a GET each");
  {
    const store = await setup(8);
    for (const course of COURSES) await original([["SET", `nl:course:${course.id}`, JSON.stringify(course)]]);
    seen.length = 0;
    const each = async () => { throw new Error("one at a time is not used"); };
    const run = await quietly(() => sendDripEmails(async () => store, each, "https://marktmorgen.com", NOW, Date.now() + 60_000, (ids) => readCoursesEach(ids)));
    // A run reads at most a seventh of the store's email figure of pairs due (dripIndexEntriesPerRun): the rest wait in
    // the index for the next runs, inside the same seven-day window (three days and a third until 15 November 2026).
    is("the first run emails as many as a run reads", run.sent, dripEntriesPerRun("pro"));
    is("eight courses' outlines, one MGET, no GET of a course", [seen.filter((c) => c[0] === "MGET" && String(c[1]).startsWith("nl:course:")).length, seen.filter((c) => c[0] === "GET" && String(c[1]).startsWith("nl:course:")).length], [1, 0]);
    let sent = run.sent;
    // One run a day over the window: 240 due, 43 a run, all sent by the sixth day, inside the seven; none lost, none twice.
    for (let n = 1; n < 7; n += 1) sent += (await quietly(() => sendDripEmails(async () => store, each, "https://marktmorgen.com", NOW + n * 86_400, Date.now() + 60_000, (ids) => readCoursesEach(ids)))).sent;
    is("everyone due emailed within the window's seven runs, once", [sent, claims()], [240, 240]);
  }

  // Since the drip index (docs/drip-due-index.md), a course of the old set is moved to its store's pending set and its
  // outline read once to write its card: a course is "kept" while it is pending or has its card.
  const keptOf = async (store: Store, n: number) =>
    (await original([["SISMEMBER", `nl:drip:pending:${store.statsId}`, `${COURSES[n].id}|${store.handle}|${products[n].id}`]]))[0] === 1 ||
    typeof (await original([["GET", `nl:drip:card:${COURSES[n].id}`]]))[0] === "string";

  part("An entry of the batch: its exact null is a course gone; one it cannot read keeps that course, the others go on");
  {
    const store = await setup(3);
    const before = mail.sent.filter((m) => m.to.some((a) => a.startsWith("student-2-"))).length;
    await original([["SET", `nl:course:${COURSES[0].id}`, JSON.stringify(COURSES[0])], ["SET", `nl:course:${COURSES[2].id}`, "{not a course"]]);
    const run = await quietly(() => sendDripEmails(async () => store, async () => null, "https://marktmorgen.com", NOW, Date.now() + 60_000, (ids) => readCoursesEach(ids)));
    is("the readable course's thirty emailed", run.sent, 30);
    is("the course whose record is gone (exact null) is let go; the unreadable one stays, counted failed", [await keptOf(store, 0), await keptOf(store, 1), await keptOf(store, 2), run.failed], [true, false, true, 1]);
    is("nobody of the unreadable course emailed", mail.sent.filter((m) => m.to.some((a) => a.startsWith("student-2-"))).length - before, 0);
  }

  part("The batch not answered whole: nothing sent on its courses, every one kept for the next run");
  {
    const store = await setup(3);
    for (const course of COURSES.slice(0, 3)) await original([["SET", `nl:course:${course.id}`, JSON.stringify(course)]]);
    let hits = 0;
    inject = (commands) => (commands[0]?.[0] === "MGET" && String(commands[0][1]).startsWith("nl:course:") ? (hits += 1, Promise.reject(new Error("synthetic: the database did not answer"))) : null);
    const run = await quietly(() => sendDripEmails(async () => store, async () => null, "https://marktmorgen.com", NOW, Date.now() + 60_000, (ids) => readCoursesEach(ids)));
    inject = null;
    is("the batch was the walk's own read", hits > 0, true);
    is("nothing sent, every course failed and kept", [run.sent, run.failed, await keptOf(store, 0), await keptOf(store, 1), await keptOf(store, 2)], [0, 3, true, true, true]);
    is("and none of them has a card yet, so the next run reads it again", (await original(COURSES.slice(0, 3).map((c) => ["GET", `nl:drip:card:${c.id}`]))).every((v) => v === null), true);
  }
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
