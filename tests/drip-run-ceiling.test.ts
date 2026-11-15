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
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and the synthetic SES (tests/ses-mail-fixture.ts).
 */
import { claimHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { DRIP_REFUSALS_PER_COURSE, DRIP_REFUSALS_PER_STORE, emailKey, sendDripEmails } from "@/lib/learn";
import { type Course, readCoursesEach } from "@/lib/course";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { type SesMailFixtureOptions, installSesMailFixture } from "./ses-mail-fixture";
import { readFileSync } from "node:fs";
import { COST_LINES, DRIP_PAGE_ROWS, DRIP_REFUSALS_PER_STORE_RUN, DRIP_REFUSED_SEND_COMMANDS, dripRunMonthlyUsd } from "./plan-cost-registry";
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
  is("a course stops after a few refused sends, a store after a score", [DRIP_REFUSALS_PER_COURSE, DRIP_REFUSALS_PER_STORE], [3, 20]);

  part("The walk's worst month, a line of each plan (course-drip-run), from the same numbers as the code");
  const source = readFileSync("lib/learn.ts", "utf8");
  is("the registry's ceiling and page are the code's", [DRIP_REFUSALS_PER_STORE_RUN === DRIP_REFUSALS_PER_STORE, source.includes(`const DRIP_PAGE = ${DRIP_PAGE_ROWS};`)], [true, true]);
  is("a line of every plan's worst month", COST_LINES.some((line) => line.id === "course-drip-run"), true);
  const month = (["creator", "pro", "scale"] as const).map((tier) => Math.round(dripRunMonthlyUsd(tier) * 100) / 100);
  // Store, Studio and Scale at their data room full of students, every product a course: well under a dollar or two,
  // where the marks without the ceiling cost more than each plan's whole net profit.
  is("Store, Studio and Scale a month, in dollars", month, [0.31, 0.59, 0.87]);

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
    // Every command of the run: two for the set and the cursor, at most one write of the cursor; for each course, its
    // blocked students and its first page of students (its listing is the store's inline catalog and its record the
    // test's reader here; the cost line prices both); and for each refused send, at most DRIP_REFUSED_SEND_COMMANDS:
    // its mark, the email figure's SET NX and INCRBY, the sender's state read and the mark's release script.
    const most = 3 + 8 * 2 + DRIP_REFUSED_SEND_COMMANDS * DRIP_REFUSALS_PER_STORE;
    is("the run's commands stay within the formula", seen.length <= most, true);
  }

  part("Every send goes: everyone due is emailed once, and the next run sends nothing more");
  {
    const store = await setup(2);
    seen.length = 0;
    const run = await quietly(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW, Date.now() + 60_000));
    is("sixty students, sixty emails, sixty marks", [run.sent, claims()], [60, 60]);
    const again = await quietly(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW, Date.now() + 60_000));
    is("the next run: none sent again", again.sent, 0);
  }

  part("A course whose sends are refused does not hold back the store's other courses");
  {
    const store = await setup(2);
    sesHooks.onSes = (message) => (message.to.some((address) => address.startsWith("student-0-")) ? new Response(JSON.stringify({ message: "synthetic: refused" }), { status: 400, headers: { "content-type": "application/json" } }) : undefined);
    const run = await quietly(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW, Date.now() + 60_000));
    sesHooks.onSes = undefined;
    is("the other course's thirty are emailed", run.sent, 30);
  }

  part("Courses read a hundred at a command (readCoursesEach), never a GET each");
  {
    const store = await setup(8);
    for (const course of COURSES) await original([["SET", `nl:course:${course.id}`, JSON.stringify(course)]]);
    seen.length = 0;
    const run = await quietly(() => sendDripEmails(async () => store, async () => { throw new Error("one at a time is not used"); }, "https://marktmorgen.com", NOW, Date.now() + 60_000, (ids) => readCoursesEach(ids)));
    is("everyone due emailed", run.sent, 240);
    is("eight courses, one MGET, no GET of a course", [seen.filter((c) => c[0] === "MGET").length, seen.filter((c) => c[0] === "GET" && String(c[1]).startsWith("nl:course:")).length], [1, 0]);
  }

  part("An entry of the batch: its exact null is a course gone; one it cannot read keeps that course, the others go on");
  {
    const store = await setup(3);
    const before = mail.sent.filter((m) => m.to.some((a) => a.startsWith("student-2-"))).length;
    await original([["SET", `nl:course:${COURSES[0].id}`, JSON.stringify(COURSES[0])], ["SET", `nl:course:${COURSES[2].id}`, "{not a course"]]);
    const run = await quietly(() => sendDripEmails(async () => store, async () => null, "https://marktmorgen.com", NOW, Date.now() + 60_000, (ids) => readCoursesEach(ids)));
    const inSet = async (n: number) => (await original([["SISMEMBER", DRIP, `${COURSES[n].id}|${store.handle}|${products[n].id}`]]))[0];
    is("the readable course's thirty emailed", run.sent, 30);
    is("the course whose record is gone (exact null) leaves the set; the unreadable one stays, counted failed", [await inSet(0), await inSet(1), await inSet(2), run.failed], [1, 0, 1, 1]);
    is("nobody of the unreadable course emailed", mail.sent.filter((m) => m.to.some((a) => a.startsWith("student-2-"))).length - before, 0);
  }

  part("The batch not answered whole: nothing sent on its courses, every one kept for the next run");
  {
    const store = await setup(3);
    for (const course of COURSES.slice(0, 3)) await original([["SET", `nl:course:${course.id}`, JSON.stringify(course)]]);
    let hits = 0;
    inject = (commands) => (commands[0]?.[0] === "MGET" ? (hits += 1, Promise.reject(new Error("synthetic: the database did not answer"))) : null);
    const run = await quietly(() => sendDripEmails(async () => store, async () => null, "https://marktmorgen.com", NOW, Date.now() + 60_000, (ids) => readCoursesEach(ids)));
    inject = null;
    const kept = await original(COURSES.slice(0, 3).map((course, n) => ["SISMEMBER", DRIP, `${course.id}|${store.handle}|${products[n].id}`]));
    is("the batch was the walk's own read", hits > 0, true);
    is("nothing sent, every course failed and kept", [run.sent, run.failed, kept], [0, 3, [1, 1, 1]]);
  }
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
