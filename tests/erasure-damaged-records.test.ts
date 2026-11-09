/**
 * A damaged record never blocks a person's erasure for good (rule 30, siblings of the review fix on
 * claude5/reviews-recount-exact, ownRecord/deleteOwnReview). Synthetic data only.
 *
 * 1. lib/affiliate-leads.ts forgetLeadPerson: a lead under the person's own field (leadId, their one-way
 *    fingerprint) that does not read made every erasure throw, on every retry, with the address maybe still in it.
 *    Now its contents go: only the address comes off when the rest reads (an address of another type), and a lead
 *    that does not read at all keeps its id alone (so the person is never counted as a new lead, and the program's
 *    decisions still fail closed on a lead whose money is unknown). The log names the id, never the address. A reply
 *    that is not text is still unknown and throws (rule 24): nothing is deleted on it.
 * 2. lib/email-sync.ts forgetSyncPerson: one job record anywhere in the store's log that did not read made the
 *    erasure of EVERY person in the store throw before deleting anything. Now a record whose address can be read
 *    (whole, or from the start of a record cut short) is theirs or not by that address; one of theirs is deleted.
 *    One whose address cannot be read is never deleted (it may be another person's): what is certainly theirs is
 *    deleted, and the erasure is said incomplete (SyncJobUnreadError, as lib/assignment.ts forgetTasksPerson),
 *    never done. The person's copy (syncJobsOf) skips a damaged record that is known to be another person's.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { leadsKey } from "@/lib/affiliate-lead-rules";
import { forgetLeadPerson, leadId, leadOf, readLeads } from "@/lib/affiliate-leads";
import { forgetSyncPerson, syncJobsOf, QUEUE_KEY } from "@/lib/email-sync";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const real = redis.pipeline.bind(redis) as Pipeline;

/** Every line the code logs as an error, to check that a damaged record is named by its id, never by an address. */
const logged: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
};

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnknownReplyError) return "UnknownReplyError";
    if (error instanceof Error && error.name === "SyncJobUnreadError") return "SyncJobUnreadError";
    return `other: ${String(error)}`;
  }
}

/** Runs a call with the reply to every pipeline whose first command is `name` replaced. */
async function swapped<T>(name: string, reply: (real: unknown[]) => unknown, run: () => Promise<T>): Promise<unknown> {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const got = await real(commands);
    return (commands[0]?.[0] === name ? reply(got) : got) as unknown[];
  };
  try {
    return await outcome(run);
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = real;
  }
}

async function leads(): Promise<void> {
  part("1. A person's own affiliate lead that does not read");
  const OWNER = "damaged-leads@example.com";
  await claimHandle(OWNER, "damagedleads", "Damaged Leads", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, `acct_1${"damagedleads".padEnd(15, "x")}`, true);
  await setSubscription(OWNER, { customerId: "cus_damagedleads", subscriptionId: "sub_damagedleads", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const statsId = store.statsId as string;
  const key = leadsKey(statsId);
  const email = "erase.lead@example.com";
  const theirs = leadId(statsId, email);
  const raw = async () => (await real([["HGET", key, theirs]]))[0];
  const put = async (value: string) => {
    await real([["DEL", key]]);
    await real([["HSET", key, theirs, value]]);
  };

  const damaged: [string, string][] = [
    ["broken JSON with the address in it", `{"id":"${theirs}","aff":"aaaaaaaaaaaa","email":"${email}","kind":`],
    ["text that is not JSON at all", `not a lead ${email}`],
    ["JSON that is not a lead", JSON.stringify({ email, note: "no id, no affiliate" })],
  ];
  for (const [what, value] of damaged) {
    await put(value);
    logged.length = 0;
    is(`${what}: the erasure finishes and counts it, never throws on every retry`, await outcome(() => forgetLeadPerson(store, email)), 1);
    const after = await raw();
    is(`${what}: the address is gone from the kept record`, typeof after === "string" && !after.includes(email) && !after.includes("erase.lead"), true);
    is(`${what}: its id stays, so the same person is never counted as a new lead`, (await real([["HEXISTS", key, theirs]]))[0], 1);
    is(`${what}: the program's decisions still fail closed on a lead whose amount is unknown`, await outcome(() => readLeads(store)), "UnknownReplyError");
    is(`${what}: the log names the lead's id, never the address`, [logged.some((l) => l.includes(theirs)), logged.some((l) => l.includes(email))], [true, false]);
    is(`${what}: a retry finds nothing left to forget`, await outcome(() => forgetLeadPerson(store, email)), 0);
    is(`${what}: the person's copy no longer fails on it`, await outcome(() => leadOf(store, email)), null);
  }

  const lead = {
    id: theirs, aff: "aaaaaaaaaaaa", kind: "signup", at: 1_700_000_000, end: 0, ref: "", pi: "", paid: 0, title: "",
    cents: 500, currency: "usd", hold: 7, daily: 10, budget: 1_000, state: "approved", d: 1_700_086_400, why: "",
  };
  await put(JSON.stringify({ ...lead, email: [email] }));
  is("an address of another type: the erasure finishes", await outcome(() => forgetLeadPerson(store, email)), 1);
  const read = async () => outcome(async () => (await readLeads(store)).map((l) => [l.id, l.email, l.cents, l.state]));
  is("only the address comes off: every money field is kept as it was, and the lead reads again", await read(), [[theirs, "", 500, "approved"]]);

  await put(JSON.stringify({ ...lead, email }));
  is("control: a healthy lead loses its address", [await outcome(() => forgetLeadPerson(store, email)), await read()], [1, [[theirs, "", 500, "approved"]]]);
  await put(`{"id":"${theirs}","email":"${email}",`);
  is("control: a reply that is not text is unknown, never a damaged record", await swapped("HGET", () => [42], () => forgetLeadPerson(store, email)), "UnknownReplyError");
  is("control: and nothing is written on it", await raw(), `{"id":"${theirs}","email":"${email}",`);
  is("control: a reply that is not a list is unknown", await swapped("HGET", () => "OK", () => forgetLeadPerson(store, email)), "UnknownReplyError");
  const other = leadId(statsId, "someone.else@example.com");
  await real([["DEL", key]]);
  await real([["HSET", key, other, `{"id":"${other}","email":"someone.else@example.com",`]]);
  is("another person's damaged lead is never touched by this erasure", [await outcome(() => forgetLeadPerson(store, email)), (await real([["HGET", key, other]]))[0]], [0, `{"id":"${other}","email":"someone.else@example.com",`]);
}

async function sync(): Promise<void> {
  part("2. A store's email-platform jobs, one of them damaged");
  const statsId = "erasedamagedsync00000000000001";
  const logKey = `nl:esync:log:${statsId}`;
  const jobKey = (id: string) => `nl:esync:j:${id}`;
  const theirs = "esj_aaaaaaaaaaaaaaaaaaaaaaaa";
  const other = "esj_bbbbbbbbbbbbbbbbbbbbbbbb";
  const third = "esj_dddddddddddddddddddddddd";
  const person = "Buyer@Example.test";
  const job = (id: string, email: string) => JSON.stringify({
    id, statsId, email, firstName: null, products: [], title: "Synthetic product", source: "purchase", attempts: 1,
    state: "retrying", next: 1, lastError: "", note: "", lastAt: 1, createdAt: 1,
  });
  const seed = (records: Record<string, string>) => {
    redis.clear();
    redis.run(["RPUSH", logKey, theirs, other, third]);
    for (const [id, value] of Object.entries(records)) redis.run(["SET", jobKey(id), value]);
    redis.run(["ZADD", QUEUE_KEY, 1, `${statsId}|${theirs}`, 2, `${statsId}|${other}`, 3, `${statsId}|${third}`]);
  };
  const kept = () => ({
    theirs: redis.run(["GET", jobKey(theirs)]) !== null,
    other: redis.run(["GET", jobKey(other)]) !== null,
    third: redis.run(["GET", jobKey(third)]) !== null,
    log: redis.run(["LRANGE", logKey, 0, -1]),
    queue: redis.run(["ZRANGEBYSCORE", QUEUE_KEY, "-inf", "+inf"]),
  });
  const healthy = () => ({ [theirs]: job(theirs, "buyer@example.test"), [third]: job(third, "third@example.test") });
  const theirsGone = { theirs: false, other: true, third: true, log: [other, third], queue: [`${statsId}|${other}`, `${statsId}|${third}`] };

  const unknownOwner: [string, string][] = [
    ["text that is not JSON", "{not json"],
    ["JSON that is not a job", "5"],
    ["a job without its address", JSON.stringify({ id: other, state: "queued" })],
    ["a record cut short before its address", `{"id":"${other}","statsId":"${statsId}","ema`],
  ];
  for (const [what, value] of unknownOwner) {
    seed({ ...healthy(), [other]: value });
    logged.length = 0;
    is(`another job with ${what}: their own job is deleted all the same, and the erasure is said incomplete`, await outcome(() => forgetSyncPerson(statsId, person)), "SyncJobUnreadError");
    is(`another job with ${what}: only their job goes; the damaged one, maybe another person's, is never deleted`, kept(), theirsGone);
    is(`another job with ${what}: the log names its id, never an address`, [logged.some((l) => l.includes(other)), logged.some((l) => /@example\.test/i.test(l))], [true, false]);
    is(`another job with ${what}: a retry deletes nothing more and still says incomplete, never done`, await outcome(() => forgetSyncPerson(statsId, person)), "SyncJobUnreadError");
    seed({ ...healthy(), [other]: value });
    is(`another job with ${what}: the copy still throws, never a copy that may miss a part`, await outcome(() => syncJobsOf(statsId, person)), "UnknownReplyError");
  }

  const knownOther: [string, string][] = [
    ["a record cut short after another person's address", `{"id":"${other}","statsId":"${statsId}","email":"someone@example.test","firstName":nu`],
    ["another person's address in a record that is not a job", JSON.stringify({ email: "someone@example.test" })],
  ];
  for (const [what, value] of knownOther) {
    seed({ ...healthy(), [other]: value });
    is(`${what}: never blocks this person's erasure, which finishes`, await outcome(() => forgetSyncPerson(statsId, person)), 1);
    is(`${what}: their job goes, the other person's damaged record is left alone`, kept(), theirsGone);
    seed({ ...healthy(), [other]: value });
    is(`${what}: never blocks this person's copy`, await swapped("NONE", (r) => r, async () => ((await syncJobsOf(statsId, person)) as { id: string }[]).map((r) => r.id)), [theirs]);
  }

  const theirsDamaged: [string, string][] = [
    ["their own record cut short after their address", `{"id":"${theirs}","statsId":"${statsId}","email":"buyer@example.test","firstName":nu`],
    ["their own address in a record that is not a job", JSON.stringify({ email: "buyer@example.test", products: "x" })],
  ];
  for (const [what, value] of theirsDamaged) {
    seed({ [theirs]: value, [other]: job(other, "someone@example.test"), [third]: job(third, "third@example.test") });
    logged.length = 0;
    is(`${what}: deleted for them and counted, the erasure finishes`, await outcome(() => forgetSyncPerson(statsId, person)), 1);
    is(`${what}: only it goes`, kept(), theirsGone);
    is(`${what}: the log names its id, never an address`, [logged.some((l) => l.includes(theirs)), logged.some((l) => /@example\.test/i.test(l))], [true, false]);
  }

  part("Controls");
  seed({ ...healthy(), [other]: job(other, "someone@example.test") });
  is("control: a healthy log erases their job alone", [await outcome(() => forgetSyncPerson(statsId, person)), kept()], [1, theirsGone]);
  seed({ ...healthy(), [other]: "{not json" });
  is("control: a record that is not text is an unknown reply, nothing deleted", await swapped("GET", (r) => [r[0], 42, r[2]], () => forgetSyncPerson(statsId, person)), "UnknownReplyError");
  is("control: and every job is kept", kept().theirs, true);
  seed({ ...healthy(), [other]: "{not json" });
  is("control: a GET batch cut short is unknown, nothing deleted", [await swapped("GET", (r) => r.slice(0, 2), () => forgetSyncPerson(statsId, person)), kept().theirs], ["UnknownReplyError", true]);
  seed({ [other]: "{not json", [third]: job(third, "third@example.test") });
  is("control: with nothing of theirs, a damaged job of unknown owner still says incomplete, with nothing written", await outcome(() => forgetSyncPerson(statsId, person)), "SyncJobUnreadError");
  is("control: and nothing was deleted", [kept().other, kept().third, kept().log], [true, true, [theirs, other, third]]);
}

async function main(): Promise<void> {
  redis.clear();
  await leads();
  await sync();
  console.error = consoleError;
  done();
}

void main();
