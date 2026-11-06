/**
 * Counters and counts read only in their exact shape (audit SG2, batch L3,
 * CX-123 rule 24): lib/auth.ts and lib/learn.ts.
 *
 * Each of these read a Redis reply with Number() or "|| 0", which turns null,
 * a short reply, text or a negative into a number that lets something through:
 *
 *   - withinRateLimit and withinAddressLimit (lib/auth.ts) read the hour's
 *     INCR of sign-in emails as "under the limit" when it was null, missing,
 *     negative or text, and a sign-in email went out. An unknown count is now
 *     "over the limit".
 *   - the sign-in route (app/api/auth/request) said "a lot of tries, wait an
 *     hour" when the count was unknown; it now says something went wrong on
 *     our side, try again in a moment (Claude 4, second review of #2717).
 *   - the address move (app/api/store/address) said "wait an hour" the same
 *     way; it now says it could not be sent, try again (Claude 4, return of
 *     the second review of #2717).
 *   - isFreshSession (lib/auth.ts) took EXISTS answered as text "1" as a fresh
 *     login. Only the whole 1 is now.
 *   - noteSignIn (lib/auth.ts) read an unknown SISMEMBER or SCARD as "a new
 *     browser, none before": the browser was noted and no email went out. An
 *     unknown SISMEMBER now notes nothing and sends nothing; a browser surely
 *     new (0) with an unknown count is told about once, in the doubt, and
 *     not noted (Claude 4, second review of #2717).
 *   - requestCourseLink (lib/learn.ts) read its two hourly counts the same
 *     way and emailed a course link. An unknown count is now "limited".
 *   - openCourseLink (lib/learn.ts) read the opens of an emailed link as
 *     under MAX_LINK_OPENS on the same replies, and opened it. An unknown
 *     count now opens nothing.
 *   - studentPage (lib/learn.ts) read an unknown HLEN as 0 students in all.
 *     It is now null, as for the other counts of that page.
 *   - runImport (lib/imports.ts) read an unknown LLEN of the rows still to
 *     bring in as 0, failed the import as "rows let go" and deleted them; read
 *     an unknown LLEN of the report as an empty report; read an unknown SCARD
 *     of the addresses to email as "nobody left" and finished the import, or
 *     started the mail ramp at 0; and read a batch (LINDEX) of another shape as
 *     empty, passed it over and at the end failed the import and deleted its
 *     rows (Claude 4, second review of #2717). Each now leaves the job as it
 *     was, to start again from the last saved place.
 *   - studentPage (lib/learn.ts) also read a page of rows of another shape
 *     (no list, an odd list, a row that is not a kept row) as fewer or no
 *     students, a done list of another shape as 0 lessons, and an unknown
 *     blocked list or answer as "not blocked" (Codex G, review 5793821629
 *     of #2717). Each is now null, the page unknown.
 *   - studentDates and lastSeenMany (lib/learn.ts) read an HGET or HMGET of
 *     another shape, or a kept row whose times are not whole numbers, as
 *     "never opened" (null or 0). Each now throws UnknownReplyError.
 *   - forgetLearnerPerson (lib/learn.ts) read an unknown SMEMBERS of the
 *     person's passes as "no passes", so their pass records were not deleted,
 *     and counted an unknown DEL or HDEL as 0 records removed. Both now throw,
 *     so the erasure says this part did not finish (lib/person-erasure.ts).
 *
 * The exact replies keep working as before.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { NextRequest } from "next/server";
import { POST as signInPost } from "@/app/api/auth/request/route";
import { POST as addressPost } from "@/app/api/store/address/route";
import { SESSION_COOKIE, isFreshSession, noteSignIn, openSession, withinAddressLimit, withinRateLimit } from "@/lib/auth";
import { forgetLearnerPerson, lastSeenMany, openCourseLink, requestCourseLink, studentDates, studentPage } from "@/lib/learn";
import { addRows, finishUpload, readJob, runImport, startImport } from "@/lib/imports";
import { UnknownReplyError } from "@/lib/redis-reply";
import { BLOCKED_READ_MAX } from "@/lib/api-read-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

/** Every email handed to the stand-in Resend; Stripe answers an empty list. */
const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const host = new URL(url).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    mails.push(Array.isArray(body.to) ? String(body.to[0]) : String(body.to ?? ""));
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

/** "rejected: <name>" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

/** The pipeline that counts a limit: [SET key 0 EX n NX, INCR key] on a key starting with `prefix`. */
const counter = (prefix: string) => (commands: (string | number)[][]) =>
  commands.length === 2 && commands[1]?.[0] === "INCR" && String(commands[1]?.[1]).startsWith(prefix);

/** Replies a limit's [SET NX, INCR] must never be read from. */
const BAD_COUNTERS: [string, unknown][] = [
  ["a count that is null", ["OK", null]],
  ["a count written as text", ["OK", "1"]],
  ["a fractional count", ["OK", 0.5]],
  ["a negative count", ["OK", -1]],
  ["a count that is an object", ["OK", { result: 1 }]],
  ["a count that is true", ["OK", true]],
  ["a reply missing the count", ["OK"]],
  ["a third, unasked-for reply", ["OK", 1, 1]],
  ["a reply that is not a list", { result: 1 }],
];

/** Replies a one-command count (HLEN, DEL, HDEL) must never be read from. */
const BAD_COUNTS: [string, unknown][] = [
  ["null", null],
  ["text", "5"],
  ["fractional", 0.5],
  ["negative", -1],
  ["an object", { result: 1 }],
  ["true", true],
];

async function shop(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await ensureListId(email);
  await setSubscription(email, { customerId: `cus_${handle.replace(/-/g, "")}`, subscriptionId: `sub_${handle.replace(/-/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(email))!;
}

void (async () => {
  part("withinRateLimit and withinAddressLimit: a sign-in email goes out only on a whole count under the limit");
  for (const [label, reply] of BAD_COUNTERS) {
    rule = { when: counter("nl:rl:signin:"), reply };
    is(`withinRateLimit, ${label}: over the limit`, await outcome(() => withinRateLimit("203.0.113.7")), false);
    rule = { when: counter("nl:rl:address:"), reply };
    is(`withinAddressLimit, ${label}: over the limit`, await outcome(() => withinAddressLimit("someone@sg2-l3.example")), false);
  }
  rule = { when: counter("nl:rl:signin:"), reply: ["OK", 5] };
  is("withinRateLimit: the fifth is still in", await withinRateLimit("203.0.113.7"), true);
  rule = { when: counter("nl:rl:signin:"), reply: ["OK", 6] };
  is("withinRateLimit: the sixth is over", await withinRateLimit("203.0.113.7"), false);
  rule = { when: counter("nl:rl:address:"), reply: [null, 8] };
  is("withinAddressLimit: a window already open (SET NX null) and the eighth is in", await withinAddressLimit("someone@sg2-l3.example"), true);
  rule = null;
  is("withinRateLimit: the real counter still lets the first in", await withinRateLimit("203.0.113.8"), true);
  is("withinAddressLimit: the real counter still lets the first in", await withinAddressLimit("first@sg2-l3.example"), true);

  part("The sign-in route: an unknown count is said as our side's trouble, never as too many tries");
  let net = 10;
  const ask = (email: string) => signInPost(new NextRequest("https://marktmorgen.com/api/auth/request", {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: "https://marktmorgen.com", "Content-Type": "application/json", "x-forwarded-for": `198.51.100.${net++}` },
    body: JSON.stringify({ email }),
  }));
  const answer = async (res: Response) => [res.status, ((await res.json()) as { error?: string }).error ?? "ok"];
  for (const [label, prefix] of [["the machine's count", "nl:rl:signin:"], ["the address's count", "nl:rl:address:"]] as [string, string][]) {
    rule = { when: counter(prefix), reply: ["OK", null] };
    is(`sign-in route, ${label} unknown: server_error, not rate_limited`, await answer(await ask("someone@sg2-l3.example")), [503, "server_error"]);
    rule = { when: counter(prefix), reply: ["OK", 99] };
    is(`sign-in route, ${label} over the limit: rate_limited`, await answer(await ask("someone@sg2-l3.example")), [429, "rate_limited"]);
  }
  rule = null;

  part("The address move: an unknown count is said as an error, never as too many tries");
  await claimHandle("mover@sg2-l3.example", "sg2-l3-mover", "Mover", "");
  const moverSession = await openSession("mover@sg2-l3.example");
  const move = async () => {
    const res = await addressPost(new NextRequest("https://marktmorgen.com/api/store/address", {
      method: "POST",
      headers: { Host: "marktmorgen.com", Origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE}=${moverSession}` },
      body: new URLSearchParams({ email: "new-home@sg2-l3.example" }),
    }));
    return new URL(res.headers.get("location") ?? "https://x/").searchParams.get("address");
  };
  rule = { when: counter("nl:rl:address:"), reply: ["OK", null] };
  is("address move, the address's count unknown: error, not limited", await move(), "error");
  rule = { when: counter("nl:rl:address:"), reply: ["OK", 99] };
  is("address move, past the limit: limited", await move(), "limited");
  rule = null;

  part("isFreshSession: only EXISTS's whole 1 is a fresh login");
  const sessionId = "b".repeat(64);
  const exists = (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "EXISTS" && String(commands[0]?.[1]).startsWith("nl:auth:fresh:");
  for (const [label, reply] of [["text", ["1"]], ["true", [true]], ["two", [2]], ["null", [null]], ["an empty reply", []], ["a second reply", [1, 1]], ["not a list", { result: 1 }]] as [string, unknown][]) {
    rule = { when: exists, reply };
    is(`isFreshSession, ${label}: not fresh`, await outcome(() => isFreshSession(sessionId)), false);
  }
  rule = { when: exists, reply: [1] };
  is("isFreshSession: 1 is fresh", await isFreshSession(sessionId), true);
  rule = { when: exists, reply: [0] };
  is("isFreshSession: 0 is not", await isFreshSession(sessionId), false);
  rule = null;

  part("noteSignIn: a browser is noted and told about only on exact replies; a new one in doubt is told about once");
  const devices = (commands: (string | number)[][]) => commands.length === 2 && commands[0]?.[0] === "SISMEMBER" && commands[1]?.[0] === "SCARD" && String(commands[0]?.[1]).startsWith("nl:auth:devices:");
  const noted: string[] = [];
  const watchSadd = (commands: (string | number)[][]) => {
    for (const c of commands) if (c[0] === "SADD" && String(c[1]).startsWith("nl:auth:devices:")) noted.push(String(c[2]));
  };
  const signIn = async (reply: unknown) => {
    rule = { when: devices, reply };
    const before = mails.length;
    noted.length = 0;
    const saved = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      watchSadd(commands);
      return saved(commands);
    }) as typeof redis.pipeline;
    const cookie = await outcome(() => noteSignIn("owner@sg2-l3.example", "c".repeat(64), "link", "Mozilla/5.0"));
    redis.pipeline = saved;
    rule = null;
    return { cookie: typeof cookie === "string" && cookie.startsWith("nl_device="), emails: mails.length - before, noted: noted.length };
  };
  for (const [label, reply] of [["text", ["0", 3]], ["two", [2, 3]], ["null", [null, 3]], ["true", [true, 3]], ["a reply one short", [0]], ["not a list", { result: 1 }]] as [string, unknown][]) {
    is(`noteSignIn, a SISMEMBER that is ${label}: the login goes on, nothing noted, no email`, await signIn(reply), { cookie: true, emails: 0, noted: 0 });
  }
  for (const [label, count] of [["null", null], ["text", "3"], ["negative", -1], ["fractional", 0.5]] as [string, unknown][]) {
    is(`noteSignIn, a new browser with a count that is ${label}: told about once, not noted`, await signIn([0, count]), { cookie: true, emails: 1, noted: 0 });
  }
  is("noteSignIn: the account's first browser is noted, no email", await signIn([0, 0]), { cookie: true, emails: 0, noted: 1 });
  is("noteSignIn: a new browser beside others is noted and told about", await signIn([0, 2]), { cookie: true, emails: 1, noted: 1 });
  is("noteSignIn: a browser already known is neither noted nor told about", await signIn([1, 2]), { cookie: true, emails: 0, noted: 0 });

  part("requestCourseLink: a course link is emailed only on whole counts under the limits");
  const store = await shop("sg2-l3-course@example.com", "sg2-l3-course");
  const product = { id: "p_course", title: "A course", course: { modules: [] } } as never;
  for (const [label, reply] of BAD_COUNTERS) {
    rule = { when: counter("nl:learn:rate:"), reply };
    const before = mails.length;
    is(`requestCourseLink, ${label}: limited`, await outcome(() => requestCourseLink({ store, product, email: "buyer@sg2-l3.example", ip: "203.0.113.9", origin: "https://marktmorgen.com" })), "limited");
    is(`requestCourseLink, ${label}: no email`, mails.length, before);
  }
  rule = null;
  is("requestCourseLink: the real counters still let a request in", await requestCourseLink({ store, product, email: "buyer@sg2-l3.example", ip: "203.0.113.10", origin: "https://marktmorgen.com" }), "sent");

  part("openCourseLink: an emailed link opens only on a whole count of opens under the limit");
  const token = "a".repeat(64);
  const grant = JSON.stringify({ e: "buyer@sg2-l3.example", k: "k", h: "sg2-l3-course", p: "p_course" });
  const opens = (commands: (string | number)[][]) => commands.length === 3 && commands[0]?.[0] === "GET" && commands[2]?.[0] === "INCR";
  for (const [label, reply] of BAD_COUNTERS) {
    const replies = Array.isArray(reply) ? [grant, ...reply] : reply;
    rule = { when: opens, reply: replies };
    is(`openCourseLink, ${label}: not opened`, await outcome(() => openCourseLink(token)), null);
  }
  rule = { when: opens, reply: [grant, "OK", 10] };
  is("openCourseLink: the tenth open still opens", (await openCourseLink(token))?.p, "p_course");
  rule = { when: opens, reply: [grant, null, 11] };
  is("openCourseLink: the eleventh does not", await openCourseLink(token), null);

  part("studentPage: an unknown number of students is never 0");
  const course = { id: "c_sg2l3", modules: [] } as never;
  const studentsPage = (commands: (string | number)[][]) => commands.length === 3 && commands[0]?.[0] === "HSCAN";
  for (const [label, total] of BAD_COUNTS) {
    rule = { when: studentsPage, reply: [["0", []], total, 0] };
    is(`studentPage, a total that is ${label}: unknown`, await outcome(() => studentPage(course, "0", 10, async () => true)), null);
  }
  rule = { when: studentsPage, reply: [["0", []], 0, 0] };
  is("studentPage: no students is 0", (await studentPage(course, "0", 10, async () => true))?.total, 0);
  rule = { when: studentsPage, reply: [["0", []], 3, 0] };
  is("studentPage: three is three", (await studentPage(course, "0", 10, async () => true))?.total, 3);
  rule = null;

  part("studentDates and lastSeenMany: a reply or a kept row of another shape is never \"never opened\"");
  const one = (name: string) => (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === name && String(commands[0]?.[1]).startsWith("nl:course:c_sg2l3:students");
  const goodRow = JSON.stringify({ e: "buyer@sg2-l3.example", s: 1_700_000_000, l: 1_700_000_500 });
  const BAD_ROWS: [string, unknown][] = [
    ["a reply that is a number", 7],
    ["a reply that is a list", [goodRow]],
    ["a reply that is true", true],
    ["a row that is not JSON", "{"],
    ["a row whose start is text", JSON.stringify({ e: "buyer@sg2-l3.example", s: "1700000000", l: 1_700_000_500 })],
    ["a row whose last visit is missing", JSON.stringify({ e: "buyer@sg2-l3.example", s: 1_700_000_000 })],
    ["a row whose start is negative", JSON.stringify({ e: "buyer@sg2-l3.example", s: -1, l: 1_700_000_500 })],
    ["a row that is a list", JSON.stringify([1, 2])],
  ];
  for (const [label, bad] of BAD_ROWS) {
    rule = { when: one("HGET"), reply: [bad] };
    is(`studentDates, ${label}: unknown`, await outcome(() => studentDates("c_sg2l3", "buyer@sg2-l3.example")), "rejected: UnknownReplyError");
    rule = { when: one("HMGET"), reply: [[bad]] };
    is(`lastSeenMany, ${label}: unknown`, await outcome(() => lastSeenMany("c_sg2l3", ["buyer@sg2-l3.example"])), "rejected: UnknownReplyError");
  }
  for (const [label, bad] of [["not a list", { result: [] }], ["a list one short", []], ["a list one too long", [null, null]], ["null", null]] as [string, unknown][]) {
    rule = { when: one("HMGET"), reply: [bad] };
    is(`lastSeenMany, an HMGET that is ${label}: unknown`, await outcome(() => lastSeenMany("c_sg2l3", ["buyer@sg2-l3.example"])), "rejected: UnknownReplyError");
  }
  rule = { when: one("HMGET"), reply: [] };
  is("lastSeenMany, a pipeline with no reply: unknown", await outcome(() => lastSeenMany("c_sg2l3", ["buyer@sg2-l3.example"])), "rejected: UnknownReplyError");
  rule = { when: one("HGET"), reply: [null] };
  is("studentDates: a student never seen is null", await studentDates("c_sg2l3", "buyer@sg2-l3.example"), null);
  rule = { when: one("HGET"), reply: [goodRow] };
  is("studentDates: a kept row is read", await studentDates("c_sg2l3", "buyer@sg2-l3.example"), { since: 1_700_000_000, lastSeen: 1_700_000_500 });
  rule = { when: one("HMGET"), reply: [[goodRow, null]] };
  is("lastSeenMany: one seen, one never", [...(await lastSeenMany("c_sg2l3", ["buyer@sg2-l3.example", "other@sg2-l3.example"])).values()], [1_700_000_500, 0]);
  rule = null;

  part("runImport: an unknown length or count leaves the import as it was");
  const owner = "sg2-l3-import@example.com";
  const importer = await shop(owner, "sg2-l3-import");
  const rows = [
    ["2", "ada@sg2-l3.example", "Ada", "", "Subscribed"],
    ["3", "not-an-address", "Bad", "", "Subscribed"],
  ];
  const input = { expected: rows.length, file: "contacts.csv", agreed: true, consentColumn: true, tags: [], source: "clickfunnels" as const };
  const started = await startImport(importer, owner, "contacts", input);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  const id = started.job.id;
  await addRows(importer, id, rows);
  await finishUpload(importer, id);
  const llen = (suffix: string) => (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "LLEN" && String(commands[0]?.[1]) === `nl:import:${id}:${suffix}`;
  for (const [label, bad] of BAD_COUNTS) {
    rule = { when: llen("rows"), reply: [bad] };
    const after = await outcome(() => runImport(id, Date.now() + 30_000));
    const [kept] = await pipeline([["LLEN", `nl:import:${id}:rows`]]);
    is(`runImport, the rows' length ${label}: not failed, rows kept`, [typeof after === "object" && after ? after.state : after, kept], ["queued", 1]);
  }
  rule = { when: llen("rows"), reply: [] };
  is("runImport, the rows' length missing: not failed", (await outcome(() => runImport(id, Date.now() + 30_000)) as { state?: string } | null)?.state, "queued");
  for (const [label, bad] of BAD_COUNTS) {
    rule = { when: llen("errors"), reply: [bad] };
    await outcome(() => runImport(id, Date.now() + 30_000));
    const job = await readJob(id);
    is(`runImport, the report's length ${label}: the step is not saved as done`, [job?.done, job?.counts.errors], [0, 0]);
  }
  const lindex = (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "LINDEX" && String(commands[0]?.[1]) === `nl:import:${id}:rows`;
  for (const [label, bad] of [
    ["a number", [7]],
    ["null", [null]],
    ["true", [true]],
    ["not JSON", ["{"]],
    ["JSON that is not a list", [JSON.stringify({ rows: [] })]],
    ["a list of rows that are not lists", [JSON.stringify(["a", "b"])]],
    ["a row holding a number", [JSON.stringify([["2", 7]])]],
    ["an empty reply", []],
    ["a second reply", [JSON.stringify([]), 1]],
  ] as [string, unknown][]) {
    rule = { when: lindex, reply: bad };
    for (let i = 0; i < 3; i += 1) await outcome(() => runImport(id, Date.now() + 30_000));
    const [kept] = await pipeline([["LLEN", `nl:import:${id}:rows`]]);
    const job = await readJob(id);
    is(`runImport, a batch that is ${label}: not passed over, not failed, rows kept`, [job?.state, job?.cursor.batch, job?.done, kept], ["queued", 0, 0, 1]);
  }
  rule = null;
  const finished = await runImport(id, Date.now() + 30_000);
  // A step left halfway may have written Ada already (as any step that fails after its writes): she is then counted
  // as already there, never twice.
  const c = finished?.counts;
  is("runImport: the real replies still bring the rows in and note the bad one", [finished?.state, (c?.added ?? 0) + (c?.already ?? 0) + (c?.contacts ?? 0), c?.errors, finished?.done], ["done", 1, 1, 2]);

  part("runImport: an unknown count of addresses to email never finishes the mailing");
  const mailing = { ...(await readJob(id))!, state: "mailing", finishedAt: undefined, options: { ...(await readJob(id))!.options, email: true } };
  await pipeline([["SET", `nl:import:${id}`, JSON.stringify(mailing), "EX", 3600], ["SADD", `nl:import:${id}:mail`, "ada@sg2-l3.example"], ["SADD", "nl:imports:active", id]]);
  const scard = (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "SCARD" && String(commands[0]?.[1]) === `nl:import:${id}:mail`;
  for (const [label, bad] of BAD_COUNTS) {
    rule = { when: scard, reply: [bad] };
    await outcome(() => runImport(id, Date.now() + 30_000));
    const [left] = await pipeline([["SCARD", `nl:import:${id}:mail`]]);
    is(`runImport, the addresses to email ${label}: still mailing, the address kept`, [(await readJob(id))?.state, left], ["mailing", 1]);
  }
  const row = (email: string) => JSON.stringify({ e: email, s: 1_700_000_000, l: 1_700_000_500 });
  const BAD_PAGES: [string, unknown][] = [
    ["rows that are null", ["0", null]],
    ["rows that are an object", ["0", { a: 1 }]],
    ["an odd list of rows", ["0", ["k1"]]],
    ["a row that is not JSON", ["0", ["k1", "{"]]],
    ["a row without its address", ["0", ["k1", JSON.stringify({ s: 1, l: 2 })]]],
    ["a row whose times are text", ["0", ["k1", JSON.stringify({ e: "a@sg2-l3.example", s: "1", l: 2 })]]],
    ["a row that is a number", ["0", ["k1", 7]]],
    ["a cursor that is a number", [0, ["k1", row("a@sg2-l3.example")]]],
    ["a third part", ["0", ["k1", row("a@sg2-l3.example")], "x"]],
  ];
  for (const [label, page] of BAD_PAGES) {
    rule = { when: studentsPage, reply: [page, 1, 0] };
    is(`studentPage, ${label}: unknown`, await outcome(() => studentPage(course, "0", 10, async () => true)), null);
  }
  // The second pipeline: each row's done list, then the blocked list (whole) or one answer a row.
  const second = (commands: (string | number)[][]) => commands.length >= 1 && commands[0]?.[0] === "SMEMBERS" && String(commands[0]?.[1]).startsWith("nl:course:c_sg2l3:done:");
  const pageOf = (emails: string[], blocked: number) => [["0", emails.flatMap((email, i) => [`k${i}`, row(email)])], emails.length, blocked];
  for (const [label, done, blocked] of [
    ["a done list that is null", [null, ["k"]], 1],
    ["a done list that is an object", [{ a: 1 }, ["k"]], 1],
    ["a done list holding a number", [[7], ["k"]], 1],
    ["a blocked list that is null", [[], null], 1],
    ["a blocked list that is an object", [[], { a: 1 }], 1],
    ["a blocked list holding a number", [[], [7]], 1],
    ["a reply one short", [[]], 1],
  ] as [string, unknown[], number][]) {
    let call = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (studentsPage(commands) || second(commands)) {
        call += 1;
        return (call === 1 ? pageOf(["blocked@sg2-l3.example"], blocked) : done) as unknown[];
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    is(`studentPage, ${label}: unknown, never "not blocked" or 0 lessons`, await outcome(() => studentPage(course, "0", 10, async () => true)), null);
  }
  // A page with no rows asks nothing more, whatever is blocked (Codex G, review 5793946540): an empty course with a
  // blocked student, and an exact page of no rows with a cursor that goes on, are read as they are.
  for (const [label, page, want] of [
    ["an empty course with one student blocked", ["0", []], { total: 0, next: "0", students: [] }],
    ["an empty page whose cursor goes on", ["37", []], { total: 0, next: "37", students: [] }],
  ] as [string, unknown[], unknown][]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (studentsPage(commands)) return [page, 0, 1] as unknown[];
      if (second(commands)) throw new Error("a second read was asked for a page with no rows");
      return pipeline(commands);
    }) as typeof redis.pipeline;
    is(`studentPage, ${label}: read as it is, nothing more asked`, await outcome(() => studentPage(course, "0", 10, async () => true)), want);
  }
  // Past BLOCKED_READ_MAX, one SISMEMBER a row: only 0 or 1.
  for (const [label, answer] of [["null", null], ["text", "1"], ["two", 2], ["true", true]] as [string, unknown][]) {
    let call = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (studentsPage(commands) || second(commands)) {
        call += 1;
        return (call === 1 ? pageOf(["blocked@sg2-l3.example"], BLOCKED_READ_MAX + 1) : [[], answer]) as unknown[];
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    is(`studentPage, past the whole list, a blocked answer that is ${label}: unknown`, await outcome(() => studentPage(course, "0", 10, async () => true)), null);
  }
  {
    let call = 0;
    const lessonCourse = { id: "c_sg2l3", modules: [{ id: "m1", title: "M", lessons: [{ id: "l1", title: "L" }] }] } as never;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (studentsPage(commands) || second(commands)) {
        call += 1;
        if (call === 1) return pageOf(["blocked@sg2-l3.example"], BLOCKED_READ_MAX + 1) as unknown[];
        return [["l1"], 1];
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    const ok = await studentPage(lessonCourse, "0", 10, async () => true);
    is("studentPage: exact replies still read a blocked student with a lesson done", ok && ok.students.map((st) => [st.email, st.done, st.blocked]), [["blocked@sg2-l3.example", 1, true]]);
  }
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (rule && rule.when(commands)) {
      if (rule.reply === "throw") throw new Error("the database did not answer");
      return rule.reply as unknown[];
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  rule = null;

  part("forgetLearnerPerson: a person's passes and records are said as removed only on exact replies");
  const courses = [{ courseId: "c_sg2l3", moduleIds: ["m1"] }];
  const passes = (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "SMEMBERS" && String(commands[0]?.[1]).startsWith("nl:learn:passes:");
  for (const [label, reply] of [["null", [null]], ["text", ["a".repeat(64)]], ["an object", [{ result: [] }]], ["an empty reply", []], ["a list holding a number", [[7]]]] as [string, unknown][]) {
    rule = { when: passes, reply };
    is(`forgetLearnerPerson, passes read as ${label}: did not finish`, await outcome(() => forgetLearnerPerson(store, "buyer@sg2-l3.example", courses)), "rejected: UnknownReplyError");
  }
  const removal = (commands: (string | number)[][]) => commands[0]?.[0] === "DEL" && commands.length === 2 && commands[1]?.[0] === "HDEL";
  for (const [label, bad] of BAD_COUNTS) {
    rule = { when: removal, reply: [bad, 1] };
    is(`forgetLearnerPerson, a DEL that is ${label}: did not finish`, await outcome(() => forgetLearnerPerson(store, "buyer@sg2-l3.example", courses)), "rejected: UnknownReplyError");
    rule = { when: removal, reply: [2, bad] };
    is(`forgetLearnerPerson, an HDEL that is ${label}: did not finish`, await outcome(() => forgetLearnerPerson(store, "buyer@sg2-l3.example", courses)), "rejected: UnknownReplyError");
  }
  rule = { when: removal, reply: [2] };
  is("forgetLearnerPerson, a reply missing the HDEL: did not finish", await outcome(() => forgetLearnerPerson(store, "buyer@sg2-l3.example", courses)), "rejected: UnknownReplyError");
  rule = { when: removal, reply: [3, 1] };
  is("forgetLearnerPerson: three keys and one row are four records", await forgetLearnerPerson(store, "buyer@sg2-l3.example", courses), 4);
  rule = null;
  const real = await forgetLearnerPerson(store, "nobody@sg2-l3.example", courses);
  // The in-memory stand-in keeps an empty set after SMEMBERS, so the real path may count it: only its shape is checked.
  is("forgetLearnerPerson: the real path still finishes with a whole count", Number.isSafeInteger(real) && real >= 0, true);
  is("UnknownReplyError is the shape error the erasure runner reports as not finished", new UnknownReplyError("x").name, "UnknownReplyError");

  done();
})();
