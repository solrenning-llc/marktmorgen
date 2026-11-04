/**
 * The three API readings that read more than a page — a course's students,
 * the affiliates and the bookings — take the further API requests their
 * reading costs (lib/api-read-rules.ts) before they read it, and are refused
 * with 429 monthly_limit, with nothing more read and none of them kept, when
 * the store has fewer left. A course's students come a page at a time. The
 * MCP tool that reads the affiliate program takes them the same way.
 * Synthetic stores, keys and Stripe answers only.
 */
import { GET as studentsRead } from "@/app/api/v1/students/route";
import { GET as affiliatesRead } from "@/app/api/v1/affiliates/route";
import { GET as bookingsRead } from "@/app/api/v1/bookings/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { AFFILIATE_FIELDS, API_PAGE, BOOKING_FIELDS, STUDENT_FIELDS } from "@/lib/api-read";
import { apiReadUnits, bookWork, bookingsWork, studentsPageWork } from "@/lib/api-read-rules";
import { BOOK_STRIPE_PAGES, bookSizes } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson, setBlocked } from "@/lib/learn";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setProductCourse, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
process.env.STRIPE_SECRET_KEY = "sk_test_api_read_units_only";

// Every command the database is sent, and every Stripe path asked for.
let commands: (string | number)[][] = [];
let stripe: string[] = [];
const pipeline = redis.pipeline.bind(redis);
// The stand-in answers an HSCAN whole; a course's students are answered a COUNT at a time, as a busy hash is.
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  const out = await pipeline(batch.map((c) => (c[0] === "HSCAN" && String(c[1]).endsWith(":students") ? ["HGETALL", c[1]] : c)));
  return out.map((reply: unknown, i: number) => {
    const c = batch[i];
    if (c[0] !== "HSCAN" || !String(c[1]).endsWith(":students")) return reply;
    const flat = Array.isArray(reply) ? (reply as string[]) : [];
    const from = Number(c[2]) * 2;
    const count = Number(c[4]) * 2;
    const next = from + count < flat.length ? String((from + count) / 2) : "0";
    return [next, flat.slice(from, from + count)];
  });
}) as typeof redis.pipeline;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  stripe.push(url.pathname);
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

let n = 0;
async function paidStore(withStripe: boolean): Promise<{ owner: string; store: () => Promise<Store>; key: string }> {
  n += 1;
  const owner = `api-units-${n}@example.com`;
  await claimHandle(owner, `api-units-${n}`, `API Units ${n}`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_ApiUnits${n}0000`, subscriptionId: `sub_ApiUnits${n}0000`, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  if (withStripe) await setStripeAccount(owner, `acct_1ApiUnits000${n}`, true);
  const store = async () => (await storeForEmail(owner))!;
  const made = await makeKey((await store()).sid, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  return { owner, store, key: made.key };
}
const get = (key: string, path: string) => new Request(`https://marktmorgen.com${path}`, { headers: { Authorization: `Bearer ${key}` } });
const used = async (s: { store: () => Promise<Store> }) => allowanceUsed(await s.store(), "api");
/** Leaves one of the month's API requests: the door's, and none more. */
async function leaveOne(s: { store: () => Promise<Store> }): Promise<void> {
  const store = await s.store();
  const left = allowanceFor(store, "api") - (await allowanceUsed(store, "api"));
  if (left > 1) is("the month is taken down to one", (await takeAllowance(store, "api", left - 1)).ok, true);
}

/** Forgets what every store took this month, so a store emptied above can read again. */
async function freshMonth(): Promise<void> {
  const [, keys] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:allow:api:*", "COUNT", 10_000]]))[0] as [string, string[]];
  if (keys.length) await redis.pipeline([["DEL", ...keys]]);
}

async function main(): Promise<void> {
  redis.clear();

  part("A course's students: a page at a time, each page taking what reading its progress costs");
  const course = await paidStore(false);
  const product = await addProduct(course.owner, "Bread School", "", "50");
  if (!product.ok) throw new Error("no product");
  let made = emptyCourse();
  for (const title of ["One", "Two"]) {
    const added = editCourse(made, { op: "lesson-add", moduleId: made.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    made = added.course;
  }
  await saveCourse(made, ROOM);
  await setProductCourse(course.owner, product.product.id, { id: made.id, lessons: 2 });
  const STUDENTS = 450;
  const emails = Array.from({ length: STUDENTS }, (_, i) => `student${i}@example.com`);
  await redis.pipeline(emails.map((e, i) => ["HSET", `nl:course:${made.id}:students`, emailKey(e), JSON.stringify({ e, s: NOW - 86_400 - i, l: NOW - i })]));
  await markLesson(made.id, emails[0], made.modules[0].lessons[0].id, true, ROOM, true);
  await setBlocked(await course.store(), made.id, emails[1], true);
  const pages: { status: number; body: { data: { email: string; lessons_done: number; lessons_total: number; blocked: boolean }[]; total: number; next: string | null } }[] = [];
  let cursor: string | null = "";
  let expected = 0;
  while (cursor !== null) {
    const before = await used(course);
    const res = await studentsRead(get(course.key, `/api/v1/students?product=${product.product.id}${cursor ? `&cursor=${cursor}` : ""}`));
    const body = await res.json();
    pages.push({ status: res.status, body });
    const rows = (body.data ?? []).length;
    expected += 1 + apiReadUnits(studentsPageWork(rows, 1));
    is(`page ${pages.length}: one request and the further ones its ${rows} students' progress costs`, (await used(course)) - before, 1 + apiReadUnits(studentsPageWork(rows, 1)));
    cursor = res.status === 200 ? body.next : null;
    if (pages.length > 10) break;
  }
  is("three pages, each answered", pages.map((p) => p.status), [200, 200, 200]);
  is("of at most a page's rows", pages.map((p) => p.body.data.length), [API_PAGE, API_PAGE, STUDENTS - 2 * API_PAGE]);
  is("every student once", new Set(pages.flatMap((p) => p.body.data.map((r) => r.email))).size, STUDENTS);
  is("with how many there are in all", pages.map((p) => p.body.total), [STUDENTS, STUDENTS, STUDENTS]);
  const rows = pages.flatMap((p) => p.body.data);
  is("progress and blocking as kept", [rows.find((r) => r.email === emails[0])?.lessons_done, rows.find((r) => r.email === emails[0])?.lessons_total, rows.find((r) => r.email === emails[1])?.blocked, rows.find((r) => r.email === emails[2])?.blocked], [1, 2, true, false]);
  is("a page of students costs more than one request", apiReadUnits(studentsPageWork(API_PAGE, 1)) > 0, true);
  is("all of it counted", await used(course), expected);

  part("Many blocked: asked one student at a time, the same answer");
  await redis.pipeline(Array.from({ length: 205 }, (_, i) => ["SADD", `nl:course:${made.id}:blocked`, emailKey(`gone${i}@example.com`)]));
  commands = [];
  const many = await studentsRead(get(course.key, `/api/v1/students?product=${product.product.id}`));
  const manyBody = await many.json();
  is("answered", many.status, 200);
  is("still blocked, read one by one", [manyBody.data.find((r: { email: string }) => r.email === emails[1])?.blocked, commands.some((c) => c[0] === "SISMEMBER"), commands.some((c) => c[0] === "SMEMBERS" && String(c[1]).endsWith(":blocked"))], [true, true, false]);

  part("A course's page with too few requests left: refused, its progress never read, nothing kept");
  await leaveOne(course);
  commands = [];
  const refused = await studentsRead(get(course.key, `/api/v1/students?product=${product.product.id}`));
  const refusedBody = await refused.json();
  is("429 monthly_limit, with no rows", [refused.status, refusedBody.error, refusedBody.data], [429, "monthly_limit", undefined]);
  is("it says how many the read takes", /This read takes [\d,]+ of your store's API requests, more than your store has left/.test(refusedBody.message), true);
  is("no student's lessons were read", commands.some((c) => c[0] === "SMEMBERS" && String(c[1]).includes(":done:")), false);
  const courseStore = await course.store();
  is("only the door's request is kept", await allowanceUsed(courseStore, "api"), allowanceFor(courseStore, "api"));

  part("Affiliates: the program counted, then what reading it costs taken, then read");
  const program = await paidStore(true);
  await setAffiliateSetting(program.owner, { ...NO_AFFILIATES, enabled: true, percent: 25 });
  const statsId = (await program.store()).statsId!;
  const AFFILIATES = 300;
  await redis.pipeline(
    Array.from({ length: AFFILIATES }, (_, i) => {
      const id = i.toString(16).padStart(12, "0");
      return ["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify({ id, email: `aff${i}@example.com`, code: `aff${i}`, status: "approved", appliedAt: Date.now() - 86_400_000, decidedAt: 1, note: "" })];
    }),
  );
  await redis.pipeline(Array.from({ length: AFFILIATES }, (_, i) => ["HSET", `nl:aff:${statsId}:clicks`, i.toString(16).padStart(12, "0"), "3"]));
  const sizes = await bookSizes(await program.store());
  is("counted: every affiliate and click, Stripe connected", [sizes?.kept, sizes?.entries, sizes?.people, sizes?.stripe], [true, 2 * AFFILIATES, AFFILIATES, true]);
  const bookUnits = apiReadUnits(bookWork(sizes!, BOOK_STRIPE_PAGES));
  is("a program this size costs more than one request", bookUnits > 1, true);
  let before = await used(program);
  stripe = [];
  const read = await affiliatesRead(get(program.key, "/api/v1/affiliates"));
  is("answered, every affiliate", [read.status, (await read.json()).data.length], [200, AFFILIATES]);
  is("one request and the further ones the program costs", (await used(program)) - before, 1 + bookUnits);
  is("Stripe was read for it", stripe.length > 0, true);

  part("The MCP tool reads the same program, at the same price");
  before = await used(program);
  const rpc = async () =>
    (await (await mcp(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${program.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_affiliates" } }) }))).json()) as { result?: { isError: boolean }; error?: { code: number; message: string } };
  const tool = await rpc();
  is("answered", tool.result?.isError, false);
  is("one request and the same further ones", (await used(program)) - before, 1 + bookUnits);

  part("Affiliates with too few requests left: refused, the program never read, nothing kept");
  await leaveOne(program);
  commands = [];
  stripe = [];
  const short = await affiliatesRead(get(program.key, "/api/v1/affiliates"));
  const shortBody = await short.json();
  is("429 monthly_limit, with no rows", [short.status, shortBody.error, shortBody.data], [429, "monthly_limit", undefined]);
  is("neither the program nor Stripe was read", [commands.some((c) => c[0] === "HGETALL"), stripe.length], [false, 0]);
  const programStore = await program.store();
  is("only the door's request is kept", await allowanceUsed(programStore, "api"), allowanceFor(programStore, "api"));
  // The MCP tool: the month is now used, so the door refuses it; with one left, the tool itself is refused the same way.
  await setSubscription(program.owner, { active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await leaveOne(program);
  commands = [];
  stripe = [];
  const toolShort = await rpc();
  is("the MCP tool is refused with the same sentence", [toolShort.error?.code, /This read takes [\d,]+ of your store's API requests/.test(toolShort.error?.message ?? "")], [-32001, true]);
  is("and reads nothing", [commands.some((c) => c[0] === "HGETALL"), stripe.length], [false, 0]);

  part("Bookings: what their most costs taken before Stripe is read");
  const calls = await paidStore(true);
  before = await used(calls);
  stripe = [];
  const booked = await bookingsRead(get(calls.key, "/api/v1/bookings"));
  is("answered", [booked.status, (await booked.json()).data], [200, []]);
  is("one request and the further ones five pages and every booking cost", (await used(calls)) - before, 1 + apiReadUnits(bookingsWork(true)));
  is("Stripe's checkouts were read", stripe.some((p) => p.endsWith("/checkout/sessions")), true);
  await leaveOne(calls);
  stripe = [];
  const noRoom = await bookingsRead(get(calls.key, "/api/v1/bookings"));
  const noRoomBody = await noRoom.json();
  is("with too few left: 429 monthly_limit, with no rows", [noRoom.status, noRoomBody.error, noRoomBody.data], [429, "monthly_limit", undefined]);
  is("and Stripe was never asked", stripe.length, 0);

  part("Bookings without Stripe connected: nothing to read, one request");
  const plain = await paidStore(false);
  before = await used(plain);
  const none = await bookingsRead(get(plain.key, "/api/v1/bookings"));
  is("answered with none", [none.status, (await none.json()).data], [200, []]);
  is("only the door's request", (await used(plain)) - before, 1);

  part("A ?fields= that cannot be read: 400 before anything more is taken or read, costing only the request");
  const fields = await paidStore(true);
  await setAffiliateSetting(fields.owner, { ...NO_AFFILIATES, enabled: true, percent: 25 });
  for (const path of ["/api/v1/students?product=p1&fields=Bad-Name", "/api/v1/affiliates?fields=,", "/api/v1/bookings?fields=a%20b"]) {
    const route = path.startsWith("/api/v1/students") ? studentsRead : path.startsWith("/api/v1/affiliates") ? affiliatesRead : bookingsRead;
    before = await used(fields);
    commands = [];
    stripe = [];
    const res = await route(get(fields.key, path));
    is(`${path}: 400 fields`, [res.status, (await res.json()).error], [400, "fields"]);
    is(`${path}: one request, nothing read`, [(await used(fields)) - before, commands.some((c) => ["HSCAN", "HGETALL", "HLEN", "SMEMBERS"].includes(String(c[0]))), stripe.length], [1, false, 0]);
  }
  // A field the rows never have is checked against each route's fixed list, before anything is taken or read too, rows or none.
  for (const [route, path] of [[studentsRead, `/api/v1/students?product=${product.product.id}&fields=email,nothing_here`], [affiliatesRead, "/api/v1/affiliates?fields=nothing_here"], [bookingsRead, "/api/v1/bookings?fields=nothing_here"]] as const) {
    const owner = route === studentsRead ? course : route === affiliatesRead ? program : fields;
    await freshMonth();
    before = await used(owner);
    commands = [];
    stripe = [];
    const res = await route(get(owner.key, path));
    is(`${path}: 400 unknown_field`, [res.status, (await res.json()).error], [400, "unknown_field"]);
    is(`${path}: one request, nothing read`, [(await used(owner)) - before, commands.some((c) => ["HSCAN", "HGETALL", "HLEN", "SMEMBERS", "SCARD"].includes(String(c[0]))), stripe.length], [1, false, 0]);
  }
  // The fixed lists are the rows' own fields.
  await freshMonth();
  const studentRows = await (await studentsRead(get(course.key, `/api/v1/students?product=${product.product.id}`))).json();
  is("students' fields are its list", Object.keys(studentRows.data[0]).sort(), [...STUDENT_FIELDS].sort());
  const affiliateRows = await (await affiliatesRead(get(program.key, "/api/v1/affiliates"))).json();
  is("affiliates' fields are its list", Object.keys(affiliateRows.data[0]).sort(), [...AFFILIATE_FIELDS].sort());
  is("bookings' list is what bookings sends", [...BOOKING_FIELDS].sort(), ["amount", "answers", "buyer_time_zone", "currency", "email", "ends_at", "id", "moved", "name", "product_id", "starts_at", "title"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
