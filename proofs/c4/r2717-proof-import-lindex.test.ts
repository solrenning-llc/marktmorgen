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
 *   - runImport (lib/imports.ts) read an unknown LLEN of the rows still to
 *     bring in as 0, failed the import as "rows let go" and deleted them; read
 *     an unknown LLEN of the report as an empty report; read an unknown SCARD
 *     of the addresses to email as "nobody left" and finished the import, or
 *     started the mail ramp at 0. Each now leaves the job as it was, to start
 *     again from the last saved place.
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
import { withinAddressLimit, withinRateLimit } from "@/lib/auth";
import { forgetLearnerPerson, lastSeenMany, openCourseLink, requestCourseLink, studentDates, studentPage } from "@/lib/learn";
import { addRows, finishUpload, readJob, runImport, startImport } from "@/lib/imports";
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

// ---- Proof for review of PR #2717: an unknown LINDEX shape in runImport (lib/imports.ts, the same function the PR
// hardens) is read as an empty batch: the batch is skipped, and at the end the import is FAILED "rows let go" and its
// rows are DELETED. This test asserts the safe outcome (left as it was, rows kept) and so FAILS today.
void (async () => {
  part("runImport: an unknown LINDEX shape must not skip a batch, fail the import or delete its rows");
  const owner = "r2717-lindex@example.com";
  const importer = await shop(owner, "r2717-lindex");
  const rows = [["2", "ada@sg2-l3.example", "Ada", "", "Subscribed"]];
  const input = { expected: rows.length, file: "contacts.csv", agreed: true, consentColumn: true, tags: [], source: "clickfunnels" as const };
  const started = await startImport(importer, owner, "contacts", input);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  const id = started.job.id;
  await addRows(importer, id, rows);
  await finishUpload(importer, id);
  rule = { when: (c) => c.length === 1 && c[0]?.[0] === "LINDEX" && String(c[0]?.[1]) === `nl:import:${id}:rows`, reply: [7] };
  const after = await outcome(() => runImport(id, Date.now() + 30_000));
  rule = null;
  const [kept] = await pipeline([["LLEN", `nl:import:${id}:rows`]]);
  is("LINDEX unknown: not failed, rows kept", [typeof after === "object" && after ? after.state : after, kept], ["queued", 1]);
  done();
})();
