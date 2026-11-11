/**
 * Proof, findings L1 and L2 of the Claude 4 team's review of #2998
 * (lib/welcome-offer-send.ts, forgetWelcomePerson, the erasure part for the
 * welcome offer, lib/person-erasure.ts).
 *
 * L2: the erasure found a person's waiting reminder by a ZSCAN of the global
 * "nl:wo:due" queue of every store. On real Redis each ZSCAN call walks about
 * COUNT entries whatever the MATCH, so one person's erasure cost one command
 * per thousand reminders of every store, uncounted in tests/plan-cost-registry.ts.
 * The in-memory stand-in ignores MATCH and COUNT, so the scan here pages as
 * real Redis does.
 * Expected: the reminder is found from the person's own mark (it keeps the
 * reminder's hour), in at most two reads of the queue, however long it is.
 *
 * L1 (CX-123 rule 24): a member that names the person's hash but does not read
 * as a reminder this module wrote was taken as "not this person", so the part
 * said 0 and finished while the address stayed in the queue.
 * Expected: rejected with UnknownReplyError, so the part is said as not finished.
 */
import { createHash } from "node:crypto";
import { forgetWelcomePerson, scheduleReminder } from "@/lib/welcome-offer-send";
import { readClaimFull, recordLead, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_only_a_stand_in";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const sent: { text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    sent.push({ text: (JSON.parse(String(init?.body)) as { text: string }).text });
    return json({ id: "email_1" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const DUE = "nl:wo:due";
const OWNER = "owner@example.com";
const LEAD = "lead@example.com";
const OTHER_STATS = "9a0c4f2e7d1b48e6a5c3f0b2d4e6a8c0";
const HOUR = 3600;
/** The mark scheduleReminder takes: the reminder's hour, then a claim value (lib/claim-mark.ts). */
const markOf = (when: number) => `due:${when}:1730000000000.123456789`;
const hash = (email: string) => createHash("sha256").update(`welcome:${email.toLowerCase()}`).digest("hex").slice(0, 32);

// Real Redis ZSCAN: each call walks COUNT entries of the whole set and only then applies MATCH.
let counting = false;
let commands: string[] = [];
let bad: { command: string; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (sentCommands: (string | number)[][]) => {
  if (counting) commands.push(...sentCommands.map((c) => String(c[0])));
  if (bad && sentCommands.length === 1 && sentCommands[0]?.[0] === bad.command) return bad.reply as unknown[];
  if (sentCommands.length === 1 && sentCommands[0]?.[0] === "ZSCAN") {
    const [, key, cursor, , pattern, , count] = sentCommands[0];
    const [all] = (await pipeline([["ZRANGEBYSCORE", String(key), "-inf", "+inf", "WITHSCORES"]])) as string[][];
    const from = Number(cursor);
    const page = all.slice(2 * from, 2 * (from + Number(count)));
    const needle = String(pattern).replace(/^\*|\*$/g, "");
    const flat: string[] = [];
    for (let i = 0; i < page.length; i += 2) if (page[i].includes(needle)) flat.push(page[i], page[i + 1]);
    const next = from + Number(count) >= all.length / 2 ? "0" : String(from + Number(count));
    return [[next, flat]];
  }
  return pipeline(sentCommands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function queued(): Promise<string[]> {
  const [all] = await pipeline([["ZRANGEBYSCORE", DUE, "-inf", "+inf"]]);
  return all as string[];
}

async function fill(n: number, score: (i: number) => number): Promise<void> {
  for (let start = 0; start < n; start += 1000) {
    const batch: (string | number)[][] = [];
    for (let i = start; i < Math.min(n, start + 1000); i += 1) {
      const e = `other${i}@example.com`;
      batch.push(["ZADD", DUE, String(score(i)), JSON.stringify({ s: "sid-other", i: OTHER_STATS, h: hash(e), e, t: `tok-${i}` })]);
    }
    await pipeline(batch);
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWelcome002", true);
  await setSubscription(OWNER, { customerId: "cus_Welcome0002", subscriptionId: "sub_Welcome0002", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, free.product.id))!;
  const result = await requestCopy({ store, product, email: LEAD, consent: true, ip: "10.0.0.9", origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  const token = /token=([0-9a-f]{64})/.exec(sent[sent.length - 1].text)?.[1] ?? "";
  const claim = (await readClaimFull(token))!;
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  await recordLead(store, claim, "Pantry Guide");
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const h = hash(LEAD);
  const markKey = `nl:wo:r:${statsId}:${h}`;
  const startKey = `nl:wo:start:${statsId}:${h}`;

  part("L2: one person's erasure does not walk every store's queue");
  is("the reminder is set", await scheduleReminder(store, claim, token, asked + HOUR), true);
  await fill(20_000, (i) => asked + 2 * HOUR + i);
  const mine = (await queued()).filter((m) => m.includes(h));
  is("it waits in the queue with the address", mine.length === 1 && mine[0].includes(LEAD), true);
  counting = true;
  commands = [];
  const removed = await forgetWelcomePerson(statsId, "Lead@Example.com");
  counting = false;
  const reads = commands.filter((c) => c === "ZSCAN" || c === "ZRANGEBYSCORE").length;
  is("with 20,000 reminders of another store, at most two reads of the queue", reads <= 2 ? "at most two" : `${reads} reads`, "at most two");
  is("and at most five commands in all", commands.length <= 5 ? "at most five" : `${commands.length} commands`, "at most five");
  const left = await queued();
  is("the person's reminder is out of the queue", left.filter((m) => m.includes(h)), []);
  is("every other store's reminder stays", left.length, 20_000);
  is("the receipt counts the two marks and the reminder", removed, 3);

  part("L2: many reminders at the very same second still find the person's");
  await pipeline([["DEL", DUE]]);
  const when = asked + 30 * HOUR;
  await fill(1_500, () => when);
  const member = JSON.stringify({ s: store.sid, i: statsId, h, e: LEAD, t: "tok-same-second" });
  await pipeline([["ZADD", DUE, String(when), member], ["SET", markKey, markOf(when)], ["SET", startKey, "1"]]);
  is("found behind 1,500 others at its second", await forgetWelcomePerson(statsId, LEAD), 3);
  is("and taken out, the others staying", [(await queued()).includes(member), (await queued()).length], [false, 1_500]);

  part("L1: a member naming the person that is not a reminder rejects");
  for (const [label, mark] of [["from the mark's hour", markOf(when)], ["from a mark of \"1\", written before marks kept the hour", "1"], ["from a bare claim value, written before marks kept the hour", "1730000000000.123456789"]] as const) {
    await pipeline([["DEL", DUE]]);
    await pipeline([["ZADD", DUE, String(when), `not json ${h}`], ["SET", markKey, mark], ["SET", startKey, "1"]]);
    is(`a corrupt member, ${label}: the part is not finished`, await outcome(() => forgetWelcomePerson(statsId, LEAD)), "rejected: UnknownReplyError");
    await pipeline([["DEL", DUE]]);
    await pipeline([["ZADD", DUE, String(when), JSON.stringify({ i: 7, h, e: LEAD })], ["SET", markKey, mark], ["SET", startKey, "1"]]);
    is(`a member of another shape, ${label}: the part is not finished`, await outcome(() => forgetWelcomePerson(statsId, LEAD)), "rejected: UnknownReplyError");
  }

  part("Rule 24 on the mark and the read of the queue");
  for (const [label, mark] of [["text", "soon"], ["a fraction", "12.5"], ["negative", "-3"], ["empty", ""], ["an hour of text", "due:soon:1730000000000.123456789"], ["an hour without its claim", `due:${when}`]] as const) {
    await pipeline([["DEL", DUE]]);
    await pipeline([["ZADD", DUE, String(when), member], ["SET", markKey, mark], ["SET", startKey, "1"]]);
    is(`a mark of ${label}: the part is not finished`, await outcome(() => forgetWelcomePerson(statsId, LEAD)), "rejected: UnknownReplyError");
  }
  const READ_BAD: [string, unknown][] = [
    ["null", [null]],
    ["not a list", ["x"]],
    ["a member not text", [[1]]],
    ["no reply", []],
  ];
  for (const [label, reply] of READ_BAD) {
    await pipeline([["DEL", DUE]]);
    await pipeline([["ZADD", DUE, String(when), member], ["SET", markKey, markOf(when)], ["SET", startKey, "1"]]);
    bad = { command: "ZRANGEBYSCORE", reply };
    is(`the read of the queue at the mark's hour answered ${label}: the part is not finished`, await outcome(() => forgetWelcomePerson(statsId, LEAD)), "rejected: UnknownReplyError");
    bad = null;
  }
  const MARK_BAD: [string, unknown][] = [
    ["a number", [5]],
    ["no reply", []],
    ["two replies", ["1", "2"]],
  ];
  for (const [label, reply] of MARK_BAD) {
    await pipeline([["SET", markKey, markOf(when)], ["SET", startKey, "1"]]);
    bad = { command: "GET", reply };
    is(`the read of the mark answered ${label}: the part is not finished`, await outcome(() => forgetWelcomePerson(statsId, LEAD)), "rejected: UnknownReplyError");
    bad = null;
  }
  await pipeline([["DEL", DUE, markKey, startKey]]);
  counting = true;
  commands = [];
  const none = await forgetWelcomePerson(statsId, LEAD);
  counting = false;
  is("no mark: nothing waits, nothing read from the queue", [none, commands.filter((c) => c === "ZSCAN" || c === "ZRANGEBYSCORE").length], [0, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
