/**
 * The drip emails' index of the pairs that fall due (docs/drip-due-index.md; lib/learn.ts; the cost ceiling under
 * Claude 7's MÉDIO on #3344).
 *
 * Before: the daily run read every drip course of every store, every day, with all its students, to find the few
 * student-and-module pairs whose module opened in the last three days. Its cost followed the courses and the students
 * (two commands a course a run, up to MAX_PRODUCTS courses), and a refunded Store first year passed the owner's US$65
 * exposure ceiling once that walk was priced.
 *
 * Now each store keeps a sorted set of its pairs (`nl:drip:due:<statsId>`, member `course|emailKey|module`, score
 * when the module opens for that student), written when a student's row is written, its bytes taken from the data room
 * with the row. A course whose schedule changes, and every course of the old global set, is walked once into it,
 * DRIP_INDEX_PAGES_PER_RUN pages a store a run. The run reads only the pairs due now, at most
 * dripIndexEntriesPerRun(store) a run, so its cost follows the store's email figure, not its courses or students.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and the synthetic SES (tests/ses-mail-fixture.ts).
 */
import { readFileSync } from "node:fs";
import { claimHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as learn from "@/lib/learn";
import { emailKey, forgetLearnerPerson, registerDrip, sendDripEmails, touchStudent } from "@/lib/learn";
import { type Course, isOpen } from "@/lib/course";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import * as registry from "./plan-cost-registry";
import { dataUsed } from "@/lib/store-data";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { type SesMailFixtureOptions, installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

const sesHooks: SesMailFixtureOptions = {};
const mail = installSesMailFixture(sesHooks);
type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const seen: Cmd[] = [];
let inject: ((commands: Cmd[]) => Promise<unknown[]> | null) | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  seen.push(...commands);
  return inject?.(commands) ?? original(commands);
}) as typeof redis.pipeline;

const L = learn as unknown as Record<string, unknown>;
const R = registry as unknown as Record<string, unknown>;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const lesson = { id: "lesson000001", title: "First", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null };
const courseOf = (id: string, modules: { id: string; dripDays: number }[], startsAt: number | null = null) =>
  ({ id, certificate: false, startsAt, modules: modules.map((m) => ({ id: m.id, title: `Module ${m.id}`, dripDays: m.dripDays, lessons: [lesson] })) }) as unknown as Course;
const COURSE = courseOf("a".repeat(32), [{ id: "module000001", dripDays: 0 }, { id: "module000002", dripDays: 1 }, { id: "module000003", dripDays: 30 }]);
const PRODUCT = { id: "prod00000001", title: "The Course", summary: "", priceCents: 6900, createdAt: 1, course: { id: COURSE.id } };
const OWNER = "drip-index@example.com";
const ORIGIN = "https://marktmorgen.com";

async function setup(tier: "creator" | "pro" = "creator", products: unknown[] = [PRODUCT]): Promise<Store> {
  redis.clear();
  mail.configure();
  sesHooks.onSes = undefined;
  inject = null;
  await claimHandle(OWNER, "drip-index-shop", "Drip Index Shop", "");
  await setSubscription(OWNER, { customerId: "cus_DripIndex0001", subscriptionId: "sub_DripIndex0001", active: true, tier, cycle: "month", trialEnds: 0, period: paidPeriod() });
  const real = (await storeForEmail(OWNER))!;
  return { ...real, catalog: { ...real.catalog, items: (products as { id: string }[]).map((p) => ({ id: p.id })), inline: products } } as unknown as Store;
}
const dueKey = (store: Store) => `nl:drip:due:${store.statsId}`;
const pendingKey = (store: Store) => `nl:drip:pending:${store.statsId}`;
const member = (course: Course, email: string, module: string) => `${course.id}|${emailKey(email)}|${module}`;
const entries = async (store: Store) => (await original([["ZRANGEBYSCORE", dueKey(store), "-inf", "+inf", "WITHSCORES"]]))[0] as string[];
const to = (email: string) => mail.sent.filter((m) => m.to.includes(email)).length;
const run = (store: Store, now = NOW, loadCourse: (id: string) => Promise<Course | null> = async (id) => (id === COURSE.id ? COURSE : null)) =>
  sendDripEmails(async (handle) => (handle === store.handle ? store : null), loadCourse, ORIGIN, now, Date.now() + 60_000);
const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = log;
  }
};
const claims = () => seen.filter((c) => c[0] === "SET" && String(c[1]).includes(":dripmail:")).length;

async function main(): Promise<void> {
  part("The ceilings are named and small");
  is("a store stops after five refused sends a run", learn.DRIP_REFUSALS_PER_STORE, 5);
  is("a store's walk into the index has a page budget a run", typeof L.DRIP_INDEX_PAGES_PER_RUN === "number" && (L.DRIP_INDEX_PAGES_PER_RUN as number) > 0, true);
  is("the entries a run reads follow the store's email figure", typeof L.dripIndexEntriesPerRun === "function", true);

  part("touchStudent writes the row and its pairs in one step, and a full room writes neither");
  {
    const store = await setup();
    const email = "first@example.com";
    await touchStudent(COURSE.id, email, NOW - 36 * 3600, store, { course: COURSE, productId: PRODUCT.id });
    const kept = await entries(store);
    is("one pair a module that opens over time, scored when it opens", kept, [member(COURSE, email, "module000002"), String(NOW - 12 * 3600), member(COURSE, email, "module000003"), String(NOW - 36 * 3600 + 30 * DAY)]);
    is("the store is in the stores' set", (await original([["SISMEMBER", "nl:drip:stores", `${store.statsId}|${store.handle}`]]))[0], 1);
    const full = await setup();
    await original([["HSET", `nl:data:${full.sid || full.statsId}`, "#", 10_000_000_000]]);
    await touchStudent(COURSE.id, "full@example.com", NOW, full, { course: COURSE, productId: PRODUCT.id });
    const row = (await original([["HGET", `nl:course:${COURSE.id}:students`, emailKey("full@example.com")]]))[0];
    is("a full room: no row, no pair", [row, (await entries(full)).length], [null, 0]);
    const earlier = await setup();
    await touchStudent(COURSE.id, email, NOW, earlier, { course: COURSE, productId: PRODUCT.id });
    await touchStudent(COURSE.id, email, NOW - 36 * 3600, earlier, { course: COURSE, productId: PRODUCT.id });
    is("an earlier start rewrites the scores", (await entries(earlier)).slice(0, 2), [member(COURSE, email, "module000002"), String(NOW - 12 * 3600)]);
    // A later visit writes its pairs no more: the course start (no outline) keeps the row's mark, and a visit after it
    // writes the row alone.
    await touchStudent(COURSE.id, email, NOW, earlier);
    seen.length = 0;
    await touchStudent(COURSE.id, email, NOW, earlier, { course: COURSE, productId: PRODUCT.id });
    is("a later visit: the row alone, no ZADD and no room taken", seen.filter((c) => c[0] === "ZADD" || c[0] === "EVAL").length, 0);
  }

  part("A due pair is emailed once; one not yet due is untouched; one past the window is removed unsent");
  {
    const store = await setup();
    const due = "due@example.com";
    const later = "later@example.com";
    const old = "old@example.com";
    await touchStudent(COURSE.id, due, NOW - 36 * 3600, store, { course: COURSE, productId: PRODUCT.id });
    await touchStudent(COURSE.id, later, NOW, store, { course: COURSE, productId: PRODUCT.id });
    // A pair whose module opened eight days ago, past the seven-day window, written as an older run would have left it.
    await original([["HSET", `nl:course:${COURSE.id}:students`, emailKey(old), JSON.stringify({ e: old, s: NOW - 9 * DAY, l: NOW })], ["ZADD", dueKey(store), NOW - 8 * DAY, member(COURSE, old, "module000002")]]);
    seen.length = 0;
    const first = await quietly(() => run(store));
    is("the due student emailed once", [to(due), first.sent], [1, 1]);
    is("the one not yet due and the one past the window not emailed", [to(later), to(old)], [0, 0]);
    const left = await entries(store);
    is("the sent pair and the stale one leave the index; the future ones stay", [left.includes(member(COURSE, due, "module000002")), left.includes(member(COURSE, old, "module000002")), left.includes(member(COURSE, later, "module000002"))], [false, false, true]);
    is("one mark, for the pair sent", claims(), 1);
    await quietly(() => run(store));
    is("the next run sends nothing again", to(due), 1);
    await quietly(() => run(store, NOW + DAY));
    is("a day on, the later student's module is due and emailed once", to(later), 1);
  }

  part("A student started by the course start route, who never opens the course page, is emailed on the right day (Claude 4 on the index, (b))");
  {
    const store = await setup();
    await registerDrip(store, PRODUCT as never, COURSE);
    const dripCardFor = L.dripCardFor as ((courseId: string) => Promise<unknown>) | undefined;
    is("the course's drip card can be read on its own, without the outline", typeof dripCardFor, "function");
    const card = dripCardFor ? await dripCardFor(COURSE.id) : null;
    is("the card registerDrip kept", card !== null && card !== "unknown" && typeof card === "object", true);
    const started = "started-only@example.com";
    // The start route's call: the card, never the outline (app/api/store/course/start/route.ts).
    await touchStudent(COURSE.id, started, NOW - 36 * 3600, store, card && card !== "unknown" ? ({ card } as never) : undefined);
    is("its pairs are in the index without a visit to the course page", (await entries(store)).includes(member(COURSE, started, "module000002")), true);
    await quietly(() => run(store));
    is("and the module's email goes on the day it opens, once", to(started), 1);
    const route = readFileSync("app/api/store/course/start/route.ts", "utf8");
    is("the start route reads the card and hands it to touchStudent", /dripCardFor\(course\.id\)/.test(route) && /touchStudent\(course\.id, order\.email, order\.created, store, [^)]*card/.test(route), true);
  }

  part("The window is seven days (three until 15 November 2026): a pair five or six and a half days old is emailed once, not dropped");
  {
    const store = await setup();
    const five = "five@example.com";
    const six = "six@example.com";
    // Pairs a three-day window dropped unsent: the seven-day window emails them, later than a fresh pair, once.
    await touchStudent(COURSE.id, five, NOW - 6 * DAY, store, { course: COURSE, productId: PRODUCT.id });
    await touchStudent(COURSE.id, six, NOW - 7.5 * DAY, store, { course: COURSE, productId: PRODUCT.id });
    is("both pairs in the index", [(await entries(store)).includes(member(COURSE, five, "module000002")), (await entries(store)).includes(member(COURSE, six, "module000002"))], [true, true]);
    const first = await quietly(() => run(store));
    is("both emailed, once each", [to(five), to(six), first.sent], [1, 1, 2]);
    await quietly(() => run(store, NOW + DAY));
    is("a day on, neither emailed again", [to(five), to(six)], [1, 1]);
    is("the window's constants: seven days, seven runs", learn.DRIP_WINDOW_RUNS, 7);
  }

  part("A pair indexed late, its module opened inside the window, is still emailed once; access never waits for the index (Claude 4 on the index, (a))");
  {
    const store = await setup();
    const late = "late-indexed@example.com";
    // The module opened two days ago (start three days ago, dripDays 1); the pair is written only now.
    await touchStudent(COURSE.id, late, NOW - 3 * DAY, store, { course: COURSE, productId: PRODUCT.id });
    is("the pair is kept, inside the window", (await entries(store)).includes(member(COURSE, late, "module000002")), true);
    await quietly(() => run(store));
    await quietly(() => run(store));
    is("emailed once, never twice", to(late), 1);
    const unit = COURSE.modules[1];
    is("access opens on its own time, with no index at all", [isOpen(COURSE, unit, NOW - 3 * DAY, NOW), isOpen(COURSE, unit, NOW, NOW)], [true, false]);
    is("the access rule reads no drip index", /nl:drip:|dueKey/.test(readFileSync("lib/course.ts", "utf8")), false);
  }

  part("A store with 2,000 indexed courses and no pair due costs only the fixed commands");
  {
    const store = await setup();
    const add: Cmd = ["ZADD", dueKey(store)];
    for (let n = 0; n < MAX_PRODUCTS; n += 1) add.push(NOW + 10 * DAY, `${String(n).padStart(32, "0")}|${"e".repeat(32)}|module000002`);
    await original([add, ["SADD", "nl:drip:stores", `${store.statsId}|${store.handle}`]]);
    seen.length = 0;
    const counts = await quietly(() => run(store, NOW, async () => { throw new Error("no course is read"); }));
    is("nothing sent, nothing failed", [counts.sent, counts.failed], [0, 0]);
    is("no student page and no course read: no HSCAN, no MGET, no course GET", seen.filter((c) => c[0] === "HSCAN" || c[0] === "MGET" || (c[0] === "GET" && /^nl:course:[0-9a-f]{32}$/.test(String(c[1])))).length, 0);
    const fixed = (R.DRIP_RUN_FIXED_COMMANDS as number) + (R.DRIP_STORE_FIXED_COMMANDS as number);
    is(`the run's commands are the fixed ones (${seen.length} of at most ${fixed})`, seen.length <= fixed, true);
  }

  part("A schedule change puts the course in the store's pending set, and the walk rewrites its pairs");
  {
    const store = await setup();
    const email = "moved@example.com";
    await registerDrip(store, PRODUCT as never, COURSE);
    // Began nine days ago: the second module opened eight days ago, past its seven-day window, so it is not even indexed.
    await touchStudent(COURSE.id, email, NOW - 9 * DAY, store, { course: COURSE, productId: PRODUCT.id });
    await quietly(() => run(store));
    is("nothing pending once the course is walked, nothing sent", [(await original([["SCARD", pendingKey(store)]]))[0], to(email)], [0, 0]);
    const changed = courseOf(COURSE.id, [{ id: "module000002", dripDays: 8 }, { id: "module000003", dripDays: 30 }]);
    await registerDrip(store, PRODUCT as never, changed);
    is("a changed schedule: the course pending", (await original([["SISMEMBER", pendingKey(store), `${COURSE.id}|${store.handle}|${PRODUCT.id}`]]))[0], 1);
    const counts = await quietly(() => run(store, NOW, async (id) => (id === COURSE.id ? changed : null)));
    is("the course walked and taken out of pending", [counts.courses, (await original([["SCARD", pendingKey(store)]]))[0]], [1, 0]);
    is("its student emailed once for the module that now opened a day ago", to(email), 1);
    const same = await setup();
    await registerDrip(same, PRODUCT as never, COURSE);
    await quietly(() => run(same));
    await registerDrip(same, PRODUCT as never, { ...COURSE, modules: COURSE.modules.map((m) => ({ ...m, title: `${m.title}!` })) } as Course);
    is("a title changed, not the schedule: nothing pending", (await original([["SCARD", pendingKey(same)]]))[0], 0);
  }

  part("A removed module's pair is dropped by the run, never emailed");
  {
    const store = await setup();
    const email = "removed@example.com";
    await registerDrip(store, PRODUCT as never, COURSE);
    await touchStudent(COURSE.id, email, NOW - 36 * 3600, store, { course: COURSE, productId: PRODUCT.id });
    await registerDrip(store, PRODUCT as never, courseOf(COURSE.id, [{ id: "module000003", dripDays: 30 }]));
    await original([["SREM", pendingKey(store), `${COURSE.id}|${store.handle}|${PRODUCT.id}`]]);
    await quietly(() => run(store));
    is("not emailed, and its pair gone", [to(email), (await entries(store)).includes(member(COURSE, email, "module000002"))], [0, false]);
  }

  part("A person's deletion removes their pairs, with an exact count");
  {
    const store = await setup();
    const email = "gone@example.com";
    await touchStudent(COURSE.id, email, NOW - 36 * 3600, store, { course: COURSE, productId: PRODUCT.id });
    const before = (await entries(store)).length / 2;
    const removed = await forgetLearnerPerson(store, email, [{ courseId: COURSE.id, moduleIds: COURSE.modules.map((m) => m.id) }]);
    is("both pairs gone, none left", [before, (await entries(store)).length], [2, 0]);
    is("counted in the records removed", removed >= 2, true);
    await touchStudent(COURSE.id, email, NOW - 36 * 3600, store, { course: COURSE, productId: PRODUCT.id });
    inject = (commands) => (commands.some((c) => c[0] === "ZREM") ? Promise.resolve(commands.map((c) => (c[0] === "ZREM" ? "QUEUED" : 1))) : null);
    const unknown = await forgetLearnerPerson(store, email, [{ courseId: COURSE.id, moduleIds: COURSE.modules.map((m) => m.id) }]).then(() => "finished", () => "unknown");
    inject = null;
    is("a ZREM answered in another shape: the deletion says it did not finish", unknown, "unknown");
  }

  part("An unreadable ZRANGEBYSCORE reply sends nothing and keeps the pairs");
  {
    const store = await setup();
    const email = "unread@example.com";
    await touchStudent(COURSE.id, email, NOW - 36 * 3600, store, { course: COURSE, productId: PRODUCT.id });
    inject = (commands) => (commands.some((c) => c[0] === "ZRANGEBYSCORE") ? Promise.resolve(commands.map((c) => (c[0] === "ZRANGEBYSCORE" ? "QUEUED" : 0))) : null);
    const counts = await quietly(() => run(store));
    inject = null;
    is("nothing sent, the store counted failed", [to(email), counts.sent, counts.failed], [0, 0, 1]);
    is("its pairs kept", (await entries(store)).includes(member(COURSE, email, "module000002")), true);
    await quietly(() => run(store));
    is("the next run sends it once", to(email), 1);
  }

  part("Migration: a course of the old global set moves to its store's pending set and is walked once");
  {
    const store = await setup();
    const email = "legacy@example.com";
    const old = `${COURSE.id}|${store.handle}|${PRODUCT.id}`;
    await original([["SADD", "nl:courses:drip", old], ["HSET", `nl:course:${COURSE.id}:students`, emailKey(email), JSON.stringify({ e: email, s: NOW - 36 * 3600, l: NOW })]]);
    const counts = await quietly(() => run(store));
    is("out of the old set, walked, its student emailed once", [(await original([["SISMEMBER", "nl:courses:drip", old]]))[0], counts.courses, to(email)], [0, 1, 1]);
    is("its card written, its later pair indexed", [typeof (await original([["GET", `nl:drip:card:${COURSE.id}`]]))[0], (await entries(store)).includes(member(COURSE, email, "module000003"))], ["string", true]);
    seen.length = 0;
    await quietly(() => run(store));
    is("the next run walks no student page", seen.filter((c) => c[0] === "HSCAN").length, 0);
  }

  part("A course's walk stops at the page budget and goes on from where it stopped the next run");
  {
    const store = await setup();
    await registerDrip(store, PRODUCT as never, COURSE);
    // More pages than one run's budget and fewer than two (one student each): HSCAN answers page n with the cursor
    // n + 1, the last with "0".
    const budget = L.DRIP_INDEX_PAGES_PER_RUN as number;
    const PAGES = budget + Math.ceil(budget / 2);
    const scans: string[] = [];
    inject = (commands) => {
      if (commands.length !== 1 || commands[0][0] !== "HSCAN") return null;
      const at = Number(commands[0][2]);
      scans.push(String(commands[0][2]));
      const email = `page-${at}@example.com`;
      return Promise.resolve([[at + 1 >= PAGES ? "0" : String(at + 1), [emailKey(email), JSON.stringify({ e: email, s: NOW - 36 * 3600, l: NOW })]]]);
    };
    await quietly(() => run(store));
    const pendingMember = `${COURSE.id}|${store.handle}|${PRODUCT.id}`;
    is("the first run reads the page budget, from the first page", [scans.length, scans[0]], [budget, "0"]);
    is("the course still pending, its walk kept at the next page", [(await original([["SISMEMBER", pendingKey(store), pendingMember]]))[0], (await original([["HGET", `nl:drip:walk:${store.statsId}`, COURSE.id]]))[0]], [1, String(budget)]);
    scans.length = 0;
    await quietly(() => run(store));
    inject = null;
    is("the next run goes on from there to the last page", [scans[0], scans.length], [String(budget), PAGES - budget]);
    is("the course walked, out of pending, its cursor gone", [(await original([["SCARD", pendingKey(store)]]))[0], (await original([["HGET", `nl:drip:walk:${store.statsId}`, COURSE.id]]))[0]], [0, null]);
  }

  part("A run's commands stay within the formula, every send refused");
  {
    const products = Array.from({ length: 8 }, (_, n) => ({ ...PRODUCT, id: `prod0000000${n}`, course: { id: String(n).repeat(32) } }));
    const store = await setup("creator", products);
    const courses = products.map((p) => courseOf(p.course.id, [{ id: "module000002", dripDays: 1 }]));
    for (let n = 0; n < 8; n += 1) {
      await registerDrip(store, products[n] as never, courses[n]);
      for (let s = 0; s < 30; s += 1) await touchStudent(courses[n].id, `student-${n}-${s}@example.com`, NOW - 36 * 3600, store, { course: courses[n], productId: products[n].id });
    }
    await original([["DEL", pendingKey(store)]]);
    sesHooks.onSes = () => new Response(JSON.stringify({ message: "synthetic: refused" }), { status: 400, headers: { "content-type": "application/json" } });
    seen.length = 0;
    const counts = await quietly(() => run(store));
    sesHooks.onSes = undefined;
    const entriesPerRun = typeof L.dripIndexEntriesPerRun === "function" ? (L.dripIndexEntriesPerRun as (s: Store) => number)(store) : Number.NaN;
    is("the Store plan reads a seventh of its email figure a run", entriesPerRun, Math.ceil(STORE_ALLOWANCES.creator.email / 7));
    is("the window's seven runs still hold the whole email figure, so none is left for want of a run", entriesPerRun * learn.DRIP_WINDOW_RUNS >= STORE_ALLOWANCES.creator.email, true);
    is("nothing sent; the marks stop at the store's ceiling", [counts.sent, claims() <= learn.DRIP_REFUSALS_PER_STORE], [0, true]);
    const most = typeof R.dripRunCommandsPerStore === "function" ? (R.dripRunCommandsPerStore as (e: number) => number)(entriesPerRun) + (R.DRIP_RUN_FIXED_COMMANDS as number) : -1;
    is(`the run's commands (${seen.length}) within the formula (${most})`, seen.length <= most, true);
  }

  part("A pair already in the index takes no room again: a schedule change and a visit after the walk (Claude 5 on #3344, MEDIUM 1)");
  {
    const store = await setup();
    await registerDrip(store, PRODUCT as never, COURSE);
    const used = async () => (await dataUsed(store))?.used ?? Number.NaN;
    for (let i = 0; i < 20; i += 1) await original([["HSET", `nl:course:${COURSE.id}:students`, emailKey(`walked${i}@example.com`), JSON.stringify({ e: `walked${i}@example.com`, s: NOW, l: NOW })]]);
    await original([["SADD", pendingKey(store), `${COURSE.id}|${store.handle}|${PRODUCT.id}`]]);
    await quietly(() => run(store));
    const walked = await used();
    const pairs = (await original([["ZCARD", dueKey(store)]]))[0];
    is("the walk indexed every student's pairs", Number(pairs) > 0, true);
    const later = courseOf(COURSE.id, [{ id: "module000001", dripDays: 0 }, { id: "module000002", dripDays: 2 }, { id: "module000003", dripDays: 31 }]);
    await registerDrip(store, PRODUCT as never, later);
    await quietly(() => run(store, NOW, async (id) => (id === COURSE.id ? later : null)));
    is("the same pairs rescored", (await original([["ZCARD", dueKey(store)]]))[0], pairs);
    is("a schedule change takes no room again for pairs already there", await used(), walked);
    for (let i = 0; i < 20; i += 1) await touchStudent(COURSE.id, `walked${i}@example.com`, NOW, store, { course: later, productId: PRODUCT.id });
    is("a visit after the walk takes no room again for its pairs", await used(), walked);
  }

  part("A store that pays nothing is walked too, and its share prices the walk (Claude 5 on #3344, MEDIUM 3)");
  {
    const source = readFileSync("tests/plan-cost-registry.ts", "utf8");
    const worst = source.slice(source.indexOf("export function nonPayingWorst"), source.indexOf("\n}\n", source.indexOf("export function nonPayingWorst")));
    is("nonPayingWorst prices course-drip-run", /course-drip-run/.test(worst), true);
  }

  part("The cost line per plan, computed from the code's constants, fits the Store plan's room under US$65");
  {
    const monthly = R.dripRunMonthlyUsd as (tier: "creator" | "pro" | "scale") => number;
    const line = (["creator", "pro", "scale"] as const).map((tier) => Math.round(monthly(tier) * 1e4) / 1e4);
    // Store, Studio and Scale a month, in dollars (docs/margin-alignment-2026-10-18.md). With the window of three days
    // they were 0.0145, 0.0311 and 0.0682, and the merge of main of 15 November 2026 took a refunded Store first year
    // to US$65.0003, over its ceiling. A window of seven days reads a seventh of the email figure a run, not a third:
    // 0.0114, 0.0185 and 0.0345, and a refunded Store first year of US$64.9972 (email-logo-region, read-ceilings).
    is("Store, Studio and Scale a month, in dollars", line, [0.0114, 0.0185, 0.0345]);
    is("the Store line at least US$0.003 below the three-day window's", line[0] <= 0.0145 - 0.003, true);
    is("the registry's ceilings are the code's", [R.DRIP_REFUSALS_PER_STORE_RUN, R.DRIP_INDEX_PAGES_RUN], [learn.DRIP_REFUSALS_PER_STORE, L.DRIP_INDEX_PAGES_PER_RUN]);
  }
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
