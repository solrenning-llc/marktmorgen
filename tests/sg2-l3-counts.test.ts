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
 *   - requestCourseLink (lib/learn.ts) read its two hourly counts the same
 *     way and emailed a course link. An unknown count is now "limited".
 *   - openCourseLink (lib/learn.ts) read the opens of an emailed link as
 *     under MAX_LINK_OPENS on the same replies, and opened it. An unknown
 *     count now opens nothing.
 *   - studentPage (lib/learn.ts) read an unknown HLEN as 0 students in all.
 *     It is now null, as for the other counts of that page.
 *   - forgetLearnerPerson (lib/learn.ts) read an unknown SMEMBERS of the
 *     person's passes as "no passes", so their pass records were not deleted,
 *     and counted an unknown DEL or HDEL as 0 records removed. Both now throw,
 *     so the erasure says this part did not finish (lib/person-erasure.ts).
 *
 * The exact replies keep working as before.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { withinAddressLimit, withinRateLimit } from "@/lib/auth";
import { forgetLearnerPerson, openCourseLink, requestCourseLink, studentPage } from "@/lib/learn";
import { UnknownReplyError } from "@/lib/redis-reply";
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
