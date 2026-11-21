/**
 * The daily courses job's drip emails (lib/learn.ts, sendDripEmails; app/api/cron/courses): a run that is bounded,
 * fair and honest (CX-123 rule 24).
 *
 * Before: the route had no maxDuration and no cutoff, and the walk no deadline, so a long run went on past Vercel's
 * limit, and the courses at the head of SMEMBERS always went first; one exception (a store, a listing, a course or
 * its students that could not be read, a mark's DEL) ended the whole walk, every day at the same course; only the
 * 5,000 most recently active students of a course were read, so the least active never got the email and nothing
 * said so; a course whose store, listing or record answered out of shape was taken out of the drip set as if it
 * were gone; and a drip set read out of shape was "no course", a run that said 0 sent.
 * Now: sixty seconds and a cutoff; a deadline that leaves the rest for the next run, which starts where this one
 * stopped; a failure that is counted and logged while the other courses go on, and is tried again the next run;
 * every student read, page by page; only a confirmed absence takes a course out; an unknown set says so.
 * And a run that got no further on the course it began with (a page whose sends are slow and fail, their marks let
 * go) leaves the next run to begin with the course after it, so one slow page never holds back every course after
 * it (Claude 2 on #3344); what is sent is never sent twice, and what failed is sent once the sends go again.
 *
 * Since the drip index (docs/drip-due-index.md; tests/drip-due-index.test.ts) a run goes store by store, each store's
 * pending courses walked into its index and its pairs due sent, one of each course in turn: the same bounds, fairness
 * and honesty hold, the cursor now naming the store a run stopped at.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and the synthetic SES (tests/ses-mail-fixture.ts).
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, setMailSettings, setProductCourse, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { emailKey, registerDrip, sendDripEmails } from "@/lib/learn";
import { type Course, editCourse, emptyCourse, saveCourse } from "@/lib/course";
import * as coursesRoute from "@/app/api/cron/courses/route";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { type SesMailFixtureOptions, installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

/** A test's hand on the synthetic SES: set by a part, cleared after it. */
const sesHooks: SesMailFixtureOptions = {};
const mail = installSesMailFixture(sesHooks);

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
/** A test's hand on the pipeline: answers a batch itself when it returns a promise, else Redis answers. */
let inject: ((commands: Cmd[]) => Promise<unknown[]> | null) | null = null;
/** A test's hand on single commands: the batch runs, and each command it picks answers `reply` instead. */
let replace: { pick: (c: Cmd) => boolean; reply: unknown } | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  const own = inject?.(commands);
  if (own) return own;
  const out = await original(commands);
  const r = replace;
  return r ? commands.map((c, n) => (r.pick(c) ? r.reply : out[n])) : out;
}) as typeof redis.pipeline;

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const NOW = Math.floor(realNow() / 1000);
const DRIP = "nl:courses:drip";
const lesson = { id: "lesson000001", title: "First", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null };
const courseWith = (id: string) => ({ id, certificate: false, startsAt: null, modules: [{ id: "module000002", title: "Week two", dripDays: 1, lessons: [lesson] }] }) as unknown as Course;
const A = courseWith("a".repeat(32));
const B = courseWith("b".repeat(32));
const productFor = (course: Course, n: number) => ({ id: `prod0000000${n}`, title: `Course ${n}`, summary: "", priceCents: 6900, createdAt: 1, course: { id: course.id } });
const PA = productFor(A, 1), PB = productFor(B, 2);
const OWNER = "drip-bounded@example.com";

/** A clean Redis with one paying store whose catalog holds both courses, and the synthetic store object. */
async function setup(): Promise<Store> {
  redis.clear();
  mail.configure();
  skew = 0;
  await claimHandle(OWNER, "drip-bounded-shop", "Drip Bounded Shop", "");
  await setSubscription(OWNER, { customerId: "cus_DripBounded01", subscriptionId: "sub_DripBounded01", active: true, tier: "pro", cycle: "month", trialEnds: 0, period: paidPeriod() });
  const real = (await storeForEmail(OWNER))!;
  return { ...real, catalog: { ...real.catalog, items: [{ id: PA.id }, { id: PB.id }], inline: [PA, PB] } } as unknown as Store;
}
const memberOf = (store: Store, course: Course, product: { id: string }) => `${course.id}|${store.handle}|${product.id}`;
/** A student a day and a half in, whose second week opened half a day ago; `seen` is their last visit. */
async function student(course: Course, email: string, seen = NOW): Promise<string> {
  await original([["HSET", `nl:course:${course.id}:students`, emailKey(email), JSON.stringify({ e: email, s: NOW - 36 * 3600, l: seen })]]);
  return email;
}
const to = (email: string) => mail.sent.filter((m) => m.to.includes(email)).length;
/**
 * A drip course kept (docs/drip-due-index.md): still in the old set, in its store's pending set (moved there, waiting
 * for its walk), or walked into the index with its card. Taken out is none of the three.
 */
const inSet = async (member: string, statsId?: string | null) => {
  const [courseId] = member.split("|");
  const [old, pending, card] = await original([["SISMEMBER", DRIP, member], ["SISMEMBER", `nl:drip:pending:${statsId ?? ""}`, member], ["GET", `nl:drip:card:${courseId}`]]);
  return old === 1 || pending === 1 || typeof card === "string";
};
type Counts = Record<string, unknown>;
const quiet = async <T>(work: () => Promise<T>): Promise<{ value: T | "rejected"; errors: string[] }> => {
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    return { value: await work().catch(() => "rejected" as const), errors };
  } finally {
    console.error = log;
  }
};

async function main(): Promise<void> {
  part("(a) The route has sixty seconds, like the other jobs");
  is("maxDuration is 60", (coursesRoute as { maxDuration?: number }).maxDuration, 60);

  part("(a) A deadline already past: nothing is sent and both courses are said to be waiting");
  {
    const store = await setup();
    await original([["SADD", DRIP, memberOf(store, A, PA), memberOf(store, B, PB)]]);
    const late = await student(A, "late-a@example.com");
    const run = await sendDripEmails(async () => store, async (id) => (id === A.id ? A : id === B.id ? B : null), "https://marktmorgen.com", NOW, realNow() - 1);
    is("nothing sent past the deadline", to(late), 0);
    // The run's unit is now the store (docs/drip-due-index.md): its courses wait in its pending set.
    is("the store waits for the next run, its two courses kept", [(run as Counts).pending, await inSet(memberOf(store, A, PA), store.statsId), await inSet(memberOf(store, B, PB), store.statsId)], [1, true, true]);
  }

  part("(a) A run cut by its deadline: the next run starts at the store it stopped at, not at the head again");
  {
    const store = await setup();
    // A second store, its own course and student (docs/drip-due-index.md: a run walks stores, each from its index).
    const otherOwner = "drip-bounded-2@example.com";
    await claimHandle(otherOwner, "drip-bounded-two", "Drip Bounded Two", "");
    await setSubscription(otherOwner, { customerId: "cus_DripBounded02", subscriptionId: "sub_DripBounded02", active: true, tier: "pro", cycle: "month", trialEnds: 0, period: paidPeriod() });
    const realOther = (await storeForEmail(otherOwner))!;
    const other = { ...realOther, catalog: { ...realOther.catalog, items: [{ id: PB.id }], inline: [PB] } } as unknown as Store;
    await original([["SADD", DRIP, memberOf(store, A, PA), memberOf(other, B, PB)]]);
    const first = await student(A, "first-a@example.com");
    const second = await student(B, "second-b@example.com");
    const loads: string[][] = [[], []];
    let pass = 0;
    const load = async (handle: string) => {
      const found = handle === store.handle ? store : handle === other.handle ? other : null;
      if (found) loads[pass].push(handle);
      return found;
    };
    const loadCourse = async (id: string) => (id === A.id ? A : id === B.id ? B : null);
    // Stores are run in the order of their members (statsId|handle).
    const [firstStore, secondStore] = [store, other].sort((x, y) => (`${x.statsId}|${x.handle}` < `${y.statsId}|${y.handle}` ? -1 : 1));
    const firstEmail = firstStore === store ? first : second;
    const secondEmail = firstStore === store ? second : first;
    // The first run's time runs out as it emails the first store's student.
    sesHooks.onSes = (message) => {
      if (pass === 0 && message.to.includes(firstEmail)) skew = 10 * 60_000;
      return undefined;
    };
    const loadTimed = load;
    const one = await sendDripEmails(loadTimed, loadCourse, "https://marktmorgen.com", NOW, realNow() + 60_000);
    is("the first run emails the first store's student, and stops before the second store", [to(firstEmail), to(secondEmail)], [1, 0]);
    is("it says one store waits", (one as Counts).pending, 1);
    sesHooks.onSes = undefined;
    skew = 0;
    pass = 1;
    await sendDripEmails(load, loadCourse, "https://marktmorgen.com", NOW, realNow() + 60_000);
    is("the next run starts at the store the first one stopped at", loads[1][0], secondStore.handle);
    is("its student is emailed once, the first store's not twice", [to(firstEmail), to(secondEmail)], [1, 1]);
  }

  part("(b) A course that throws is counted and logged; the courses after it still get their emails");
  {
    const store = await setup();
    await original([["SADD", DRIP, memberOf(store, A, PA)]]);
    await original([["SADD", DRIP, memberOf(store, B, PB)]]);
    const after = await student(B, "after-b@example.com");
    let tries = 0;
    const loadCourse = async (id: string) => {
      if (id === A.id) {
        tries += 1;
        throw new Error("synthetic: the course could not be read");
      }
      return id === B.id ? B : null;
    };
    const { value, errors } = await quiet(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW));
    is("the run answers, it does not end at the failing course", value === "rejected", false);
    is("the course after it is emailed", to(after), 1);
    is("the failure is counted", value === "rejected" ? null : (value as Counts).failed, 1);
    is("and logged", errors.some((e) => e.includes("drip")), true);
    is("the failing course stays in the drip set", await inSet(memberOf(store, A, PA), store.statsId), true);
    await quiet(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW));
    is("and is tried again the next run", tries, 2);
  }

  part("(b) A course whose students' read throws: the others go on");
  {
    const store = await setup();
    await original([["SADD", DRIP, memberOf(store, A, PA)]]);
    await original([["SADD", DRIP, memberOf(store, B, PB)]]);
    await student(A, "stuck-a@example.com");
    const after = await student(B, "after2-b@example.com");
    inject = (commands) => (commands.some((c) => String(c[1]).startsWith(`nl:course:${A.id}:students`)) ? Promise.reject(new Error("synthetic: the database did not answer in time")) : null);
    const { value } = await quiet(() => sendDripEmails(async () => store, async (id) => (id === A.id ? A : id === B.id ? B : null), "https://marktmorgen.com", NOW));
    inject = null;
    is("the run answers", value === "rejected", false);
    is("the course after it is emailed", to(after), 1);
  }

  part("(b) A page of students or a blocked check answered in another shape: that course is failed and kept, never 'nobody'");
  // Since the drip index (docs/drip-due-index.md): a page is read by the walk into the index, which fails that course;
  // a pair's blocked check (SISMEMBER) answered in another shape keeps the pair, unsent, and the store's run is
  // counted failed, while every other course's pair goes on.
  for (const [label, pick, walked] of [
    ["a page of students", (c: Cmd) => c[0] === "HSCAN" && String(c[1]).startsWith(`nl:course:${A.id}:`), 1],
    ["the blocked check", (c: Cmd) => c[0] === "SISMEMBER" && String(c[1]) === `nl:course:${A.id}:blocked`, 2],
  ] as [string, (c: Cmd) => boolean, number][]) {
    const store = await setup();
    await original([["SADD", DRIP, memberOf(store, A, PA)]]);
    await original([["SADD", DRIP, memberOf(store, B, PB)]]);
    const tag = label.replace(/\W+/g, "-");
    const unread = await student(A, `unread-${tag}@example.com`);
    const after = await student(B, `after-${tag}@example.com`);
    replace = { pick, reply: "QUEUED" };
    const { value } = await quiet(() => sendDripEmails(async () => store, async (id) => (id === A.id ? A : id === B.id ? B : null), "https://marktmorgen.com", NOW));
    replace = null;
    is(`${label} unknown: failed, and walked only where its page read`, value === "rejected" ? null : [(value as Counts).failed, (value as Counts).courses], [1, walked]);
    is(`${label} unknown: nobody of that course emailed, the other course's student emailed, the course kept`, [to(unread), to(after), await inSet(memberOf(store, A, PA), store.statsId)], [0, 1, true]);
    const due = (await original([["ZRANGEBYSCORE", `nl:drip:due:${store.statsId}`, "-inf", "+inf"]]))[0] as string[];
    if (walked === 2) is(`${label} unknown: its pair kept in the index for the next run`, due.some((m) => m.startsWith(`${A.id}|${emailKey(unread)}|`)), true);
    await quiet(() => sendDripEmails(async () => store, async (id) => (id === A.id ? A : id === B.id ? B : null), "https://marktmorgen.com", NOW));
    is(`${label} answered again: the next run emails that course's student once`, [to(unread), to(after)], [1, 1]);
  }

  part("(c) A course past 5,000 students: the least active student is emailed too, and an unreadable row is said");
  {
    const store = await setup();
    await original([["SADD", DRIP, memberOf(store, A, PA)]]);
    // 5,000 students who came back today and joined long ago (nothing opens for them), one who joined a day and a
    // half ago and never came back: the least active, the 5,001st by last visit.
    const rows: Cmd = ["HSET", `nl:course:${A.id}:students`];
    for (let i = 0; i < 5_000; i += 1) {
      const email = `old-${i}@example.com`;
      rows.push(emailKey(email), JSON.stringify({ e: email, s: NOW - 400 * 86_400, l: NOW }));
    }
    await original([rows]);
    const quietest = await student(A, "quietest@example.com", NOW - 36 * 3600);
    await original([["HSET", `nl:course:${A.id}:students`, "f".repeat(32), "not a row"]]);
    const { value } = await quiet(() => sendDripEmails(async () => store, async (id) => (id === A.id ? A : null), "https://marktmorgen.com", NOW));
    is("the least active student is emailed", to(quietest), 1);
    is("the row that could not be read is counted, never silently left", value === "rejected" ? null : (value as Counts).unreadStudents, 1);
  }

  part("(f) A page whose sends are slow and fail does not hold back the courses after it (Claude 2 on #3344)");
  {
    const store = await setup();
    await original([["SADD", DRIP, memberOf(store, A, PA), memberOf(store, B, PB)]]);
    const slow: string[] = [];
    for (let n = 0; n < 6; n += 1) slow.push(await student(A, `slow-${n}@example.com`));
    const waiting = await student(B, "waiting-b@example.com");
    const loaded: string[] = [];
    const loadCourse = async (id: string) => {
      loaded.push(id);
      return id === A.id ? A : id === B.id ? B : null;
    };
    // Every send to the first course's students takes fifteen seconds and is refused, so its mark is let go.
    sesHooks.onSes = (message) => {
      if (!message.to.some((address) => address.startsWith("slow-"))) return undefined;
      skew += 15_000;
      return new Response(JSON.stringify({ message: "synthetic: the provider is slow and refuses" }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const runs: Counts[] = [];
    for (let n = 0; n < 3; n += 1) {
      skew = 0;
      const { value } = await quiet(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW, realNow() + 40_000));
      runs.push(value === "rejected" ? {} : (value as Counts));
    }
    sesHooks.onSes = undefined;
    // Work left for the next run is said either way: a course the deadline cut short is pending, and one whose sends
    // were refused past DRIP_REFUSALS_PER_COURSE is held until the next run (the ceiling before the marks' spend).
    is("every run answers and leaves work for the next", runs.map((run) => typeof run.pending === "number" && typeof run.held === "number" && run.pending + run.held > 0), [true, true, true]);
    is("within three runs, the course after the slow page is read", loaded.includes(B.id), true);
    is("and its student is emailed once", to(waiting), 1);
    is("nobody of the slow page is emailed while its sends fail", slow.map(to), slow.map(() => 0));
    for (let n = 0; n < 3; n += 1) {
      skew = 0;
      await quiet(() => sendDripEmails(async () => store, loadCourse, "https://marktmorgen.com", NOW, realNow() + 40_000));
    }
    is("once the sends go again, each student of the slow page is emailed exactly once, the other course's not again", [...slow.map(to), to(waiting)], [...slow.map(() => 1), 1]);
  }

  part("(f) Control: a course alone whose page is slow is begun with again, and nothing is sent twice");
  {
    const store = await setup();
    await original([["SADD", DRIP, memberOf(store, A, PA)]]);
    const alone: string[] = [];
    for (let n = 0; n < 4; n += 1) alone.push(await student(A, `slow-alone-${n}@example.com`));
    let tries = 0;
    sesHooks.onSes = (message) => {
      if (!message.to.some((address) => address.startsWith("slow-"))) return undefined;
      tries += 1;
      skew += 15_000;
      // The first send of each run goes; the ones after it are refused.
      return tries % 3 === 1 ? undefined : new Response(JSON.stringify({ message: "synthetic: refused" }), { status: 400, headers: { "content-type": "application/json" } });
    };
    for (let n = 0; n < 6; n += 1) {
      skew = 0;
      await quiet(() => sendDripEmails(async () => store, async (id) => (id === A.id ? A : null), "https://marktmorgen.com", NOW, realNow() + 40_000));
    }
    sesHooks.onSes = undefined;
    is("each student is emailed at most once", alone.map(to).every((n) => n <= 1), true);
    skew = 0;
    await quiet(() => sendDripEmails(async () => store, async (id) => (id === A.id ? A : null), "https://marktmorgen.com", NOW, realNow() + 40_000));
    is("and once the sends go again, every one of them exactly once", alone.map(to), alone.map(() => 1));
  }

  part("(d)(e) Through the route: only a confirmed absence takes a course out; an unknown set is said");
  {
    redis.clear();
    mail.configure();
    skew = 0;
    const owner = "drip-route@example.com";
    await claimHandle(owner, "drip-route-shop", "Drip Route Shop", "");
    await setMailSettings(owner, { fromName: "Drip Route", address: "Synthetic test address" });
    await setSubscription(owner, { customerId: "cus_DripRoute001", subscriptionId: "sub_DripRoute001", active: true, tier: "pro", cycle: "month", trialEnds: 0, period: paidPeriod() });
    const made = await addProduct(owner, "Drip route course", "A synthetic course", "49", null);
    if (!made.ok) throw Error("Synthetic product was not created");
    const base = emptyCourse();
    const built = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Drip lesson" });
    if (!built.ok) throw Error("Synthetic lesson was not created");
    const course = { ...built.course, modules: built.course.modules.map((m) => ({ ...m, dripDays: 1 })) } as Course;
    await saveCourse(course, ROOM);
    const linked = await setProductCourse(owner, made.product.id, { id: course.id, lessons: 1 });
    if (!linked.ok) throw Error("Synthetic course was not linked");
    const routeStore = (await storeForEmail(owner))!;
    const handle = routeStore.handle;
    const member = `${course.id}|${handle}|${made.product.id}`;
    await original([["SADD", DRIP, member]]);
    const routeStudent = await student(course, "route-student@example.com");
    const call = async () => {
      const { value } = await quiet(async () => (await coursesRoute.GET(new NextRequest("https://local.example/api/cron/courses"))).json() as Promise<Counts>);
      return value === "rejected" ? {} : value;
    };
    // The course's record is read in a batch (MGET, readCoursesEach): its entry answered in another shape, and the
    // whole batch answered nothing; the store's address is still one GET.
    for (const [label, key, reply] of [
      ["the course's record answered in another shape", `nl:course:${course.id}`, ["QUEUED"]],
      ["the course's record answered nothing", `nl:course:${course.id}`, undefined],
      ["the store's address answered in another shape", `nl:store:handle:${handle}`, 7],
    ] as [string, string, unknown][]) {
      let hits = 0;
      inject = (commands) => (commands.length === 1 && ((commands[0][0] === "GET" && commands[0][1] === key) || (commands[0][0] === "MGET" && commands[0].includes(key))) ? (hits += 1, Promise.resolve([reply])) : null);
      await call();
      inject = null;
      is(`${label}: the answer was given to the walk's own read`, hits > 0, true);
      is(`${label}: the course stays in the drip set`, await inSet(member, routeStore.statsId), true);
    }
    inject = (commands) => (commands.some((c) => c[0] === "SMEMBERS" && c[1] === DRIP) ? Promise.resolve(commands.map(() => "QUEUED")) : null);
    const unknown = await call();
    inject = null;
    is("an unknown drip set is said, never 0 sent", [unknown.sent === 0, unknown.dripsFailed], [false, true]);
    // Put back for the controls, whatever an earlier step did to it.
    await original([["SADD", DRIP, member]]);
    const healthy = await call();
    is("healthy control: the student is emailed once, the course kept", [to(routeStudent), await inSet(member, routeStore.statsId), healthy.dripsFailed], [1, true, undefined]);
    // Confirmed absence, as the studio removes a course (app/api/store/course/route.ts): its record deleted and
    // registerDrip told nothing opens over time, which deletes its card; a pair of it still in the index is dropped
    // by the run, never emailed.
    await original([["DEL", `nl:course:${course.id}`]]);
    await registerDrip(routeStore, made.product as never, { ...course, modules: [] } as Course);
    const late = await student(course, "route-late@example.com");
    await original([["ZADD", `nl:drip:due:${routeStore.statsId}`, NOW - 12 * 3600, `${course.id}|${emailKey(late)}|${course.modules[0].id}`]]);
    await call();
    const left = (await original([["ZRANGEBYSCORE", `nl:drip:due:${routeStore.statsId}`, "-inf", "+inf"]]))[0] as string[];
    is("confirmed absence control: a course whose record is gone leaves the drip set, its pair dropped unsent", [await inSet(member, routeStore.statsId), to(late), left.some((m) => m.startsWith(course.id))], [false, 0, false]);
  }

  Date.now = realNow;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
