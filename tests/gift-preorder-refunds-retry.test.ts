/**
 * Two residual gaps of the refund passes of gifts and pre-orders (CX-123
 * rule 24; r24 money inventory, item 1, after the pass cursor):
 *
 *   1. The anchor (the newest refund the last pass read whole) read in a shape
 *      that is not a time fell back to "one week ago", so refunds older than a
 *      week since the real anchor were never read. Now a run with an anchor in
 *      another shape does nothing, asks nothing of Stripe and leaves the anchor
 *      as it is (as lib/group-buy.ts does); a confirmed absent anchor still
 *      starts the first pass from a week back. The list below is still tried
 *      in that run: it does not depend on the anchor (review of #3302,
 *      Claude 5 LEVE 2).
 *   2. A row that can never be handled (a record that does not read, a course
 *      removal that always fails) would hold the anchor forever. A refund
 *      Stripe finished (succeeded) whose work could not be done goes on a
 *      short list of refunds to try again (nl:<job>:<store>:refunds:retry,
 *      refund id to payment, at most 100, kept as long as the records it could
 *      take back), the pass goes on in the same run, and the list is tried
 *      again first on every run; a row is let go only once handled. With the
 *      list full, or a write to it left unknown, the row holds the anchor at
 *      its time instead (lib's #3301 rule), read again by the next pass: never
 *      dropped in silence, and never holding the refunds behind it (review of
 *      #3302, Claude 5 MEDIUM 1; the rows not readable are in
 *      gift-preorder-refunds-cursor.test.ts). A refund not final yet is never
 *      put on the list (reviews of #3302, Claude 6 and Claude 5 LEVE 1; the
 *      owner's decision 18 of 9 November 2026): it holds the anchor and is
 *      read again with its status then, so one Stripe fails is never taken
 *      back. A refund not final yet read on an earlier page still holds the
 *      anchor when the pass ends.
 *   3. The list keeps only which refund it was, never whether it still gives
 *      the money back (review of #3302, Claude 2 MEDIUM; the owner's decision
 *      18 of 9 November 2026: access is taken back only on a full refund that
 *      succeeded, or a dispute lost). Each row is read again from Stripe
 *      (GET /refunds/{id}, its charge expanded, on the store's account) before
 *      anything is taken back: only a refund that succeeded on a charge
 *      refunded in full is taken back; one not final yet stays on the list; one
 *      Stripe failed or canceled, or whose charge is not refunded in full, is
 *      let go with nothing taken back; a read in another shape or one Stripe
 *      answers with an error leaves it on the list, nothing taken back. At most
 *      ten are read a run, from a place that moves on every five minutes.
 *
 * Checked through the real gift and pre-order journeys against a stand-in for
 * the creator's Stripe account that pages as Stripe does.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { confirmPreorder, revokeRefundedPreorders } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);

/** The store's refunds, newest first, as Stripe lists them. */
let refunds: Record<string, unknown>[] = [];
const refundCalls: URLSearchParams[] = [];
/** Every refund Stripe has, by id, as GET /refunds/{id} answers one no longer in `refunds` (list() writes each row here). */
const ledger = new Map<string, Record<string, unknown>>();
/** Each refund read again by itself: its id, the account asked and what was expanded. */
const rereads: { id: string; account: string; expand: string[] }[] = [];
/** Refunds Stripe answers with an error when read by themselves. */
const erring = new Set<string>();
const ACCOUNT = "acct_1TestRetryRef01";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") {
    refundCalls.push(url.searchParams);
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const from = after ? refunds.findIndex((row) => row.id === after) + 1 : 0;
    const data = refunds.slice(from, from + limit);
    return answer({ object: "list", data, has_more: from + limit < refunds.length });
  }
  const one = /^\/refunds\/([^/]+)$/.exec(path);
  if (one) {
    const id = decodeURIComponent(one[1]);
    rereads.push({ id, account: new Headers(init?.headers).get("Stripe-Account") ?? "", expand: url.searchParams.getAll("expand[]") });
    if (erring.has(id)) return answer({ error: { type: "api_error", message: "a stand-in error" } }, 500);
    const row = refunds.find((r) => r.id === id) ?? ledger.get(id);
    return row ? answer(row) : answer({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such refund" } }, 404);
  }
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** `count` full refunds, newest first, created from `newest` down; those at the indexes of `paid` paid with its payments. */
function list(tag: string, count: number, newest: number, paid: Record<number, string>): Record<string, unknown>[] {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `re_${tag}${String(i).padStart(6, "0")}`,
    object: "refund",
    created: newest - i,
    status: "succeeded",
    payment_intent: paid[i] ?? `pi_${tag}other${String(i).padStart(6, "0")}`,
    charge: { object: "charge", refunded: true },
  }));
  for (const row of rows) ledger.set(row.id, row);
  return rows;
}

type Made = { pi: string; email: string; holds: () => Promise<boolean> };
type Job = {
  name: string;
  anchor: string;
  pass: string;
  retry: string;
  run: (dropStart?: (email: string, product: string) => Promise<void>) => Promise<number>;
  make: (n: number) => Promise<Made>;
};

const original = redis.pipeline;
const read = async (key: string) => (await original.call(redis, [["GET", key]]))[0];
const waiting = async (key: string) => {
  const flat = (await original.call(redis, [["HGETALL", key]]))[0] as string[];
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
};

async function anchors(job: Job, base: number): Promise<void> {
  const far = await job.make(1);
  // The real anchor is ten days back; the refund is nine days back, newer than the anchor and older than a week.
  const tenDays = String(NOW - 10 * 86_400);
  refunds = list(`${job.name}a`, 5, base, { 4: far.pi });
  refunds[4] = { ...refunds[4], created: NOW - 9 * 86_400 };
  for (const [label, kept] of [
    ["text that is not a time", "not a time"],
    ["an empty text", ""],
    ["a time with a fraction", "1790000000.5"],
  ] as const) {
    part(`${job.name}: an anchor kept as ${label} does nothing this run`);
    await original.call(redis, [["SET", job.anchor, kept]]);
    refundCalls.length = 0;
    is(`${job.name}, ${label}: nothing taken back`, await job.run(), 0);
    is(`${job.name}, ${label}: Stripe is not asked from a week back`, refundCalls.length, 0);
    is(`${job.name}, ${label}: the anchor is left as it is`, await read(job.anchor), kept);
    is(`${job.name}, ${label}: still held, for the run that reads the anchor`, await far.holds(), true);
  }

  part(`${job.name}: an anchor in another shape still tries the list again, which does not depend on it`);
  const listed = await job.make(11);
  const listedId = `re_${job.name}listed0001`;
  await original.call(redis, [["HSET", job.retry, listedId, listed.pi], ["SET", job.anchor, "not a time"]]);
  ledger.set(listedId, { id: listedId, object: "refund", created: NOW - 9 * 86_400, status: "succeeded", payment_intent: listed.pi, charge: { object: "charge", refunded: true } });
  refundCalls.length = 0;
  rereads.length = 0;
  is(`${job.name}: the refund on the list is taken back`, await job.run(), 1);
  is(`${job.name}: no longer held`, await listed.holds(), false);
  is(`${job.name}: and let go of the list`, await waiting(job.retry), {});
  is(`${job.name}: read again from Stripe first, by itself, on the store's account`, rereads, [{ id: listedId, account: ACCOUNT, expand: ["charge"] }]);
  is(`${job.name}: and no page of refunds asked of Stripe`, refundCalls.length, 0);
  is(`${job.name}: and the anchor left as it is`, await read(job.anchor), "not a time");

  part(`${job.name}: an anchor read as something other than text does nothing this run`);
  await original.call(redis, [["SET", job.anchor, tenDays]]);
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    return commands.length === 3 && commands[1][0] === "GET" && commands[1][1] === job.anchor ? [replies[0], 7, replies[2]] : replies;
  };
  refundCalls.length = 0;
  try {
    is(`${job.name}: an anchor read as a number takes nothing back`, await job.run(), 0);
  } finally {
    redis.pipeline = original;
  }
  is(`${job.name}: and asks nothing of Stripe`, refundCalls.length, 0);

  part(`${job.name}: control: the anchor read as a time reads from it, older than a week included`);
  refundCalls.length = 0;
  is(`${job.name}: the refund nine days back is taken back`, await job.run(), 1);
  is(`${job.name}: read from the anchor, not from a week back`, refundCalls[0]?.get("created[gte]"), String(NOW - 10 * 86_400 - 300));
  is(`${job.name}: no longer held`, await far.holds(), false);

  part(`${job.name}: control: a confirmed absent anchor starts the first pass from a week back`);
  await original.call(redis, [["DEL", job.anchor]]);
  refunds = list(`${job.name}b`, 2, base, {});
  refundCalls.length = 0;
  await job.run();
  const from = Number(refundCalls[0]?.get("created[gte]"));
  is(`${job.name}: read from a week back`, from >= NOW - 7 * 86_400 - 300 - 5 && from <= NOW - 7 * 86_400 - 300 + 60, true);
  is(`${job.name}: the anchor moves to the newest refund`, await read(job.anchor), String(base));
}

async function stuck(job: Job, base: number): Promise<void> {
  const row = (tag: string, i: number) => `re_${job.name}${tag}${String(i).padStart(6, "0")}`;
  const ttlOf = async () => (await original.call(redis, [["TTL", job.retry]]))[0] as number;

  part(`${job.name}: a row that can never be handled does not hold back the refunds behind it`);
  const blocked = await job.make(2);
  const behind = await job.make(3);
  // The row that cannot be handled on the first page, the refund behind it on the third.
  refunds = list(`${job.name}s`, 250, base, { 50: blocked.pi, 230: behind.pi });
  const refusing = async (email: string) => {
    if (email === blocked.email) throw new Error("the ledger never answers for this one");
  };
  is(`${job.name}: run 1 goes on past the row not handled and takes the one behind back`, await job.run(refusing), 1);
  is(`${job.name}: the refund behind it is no longer held`, await behind.holds(), false);
  is(`${job.name}: the row that could not be handled is still held`, await blocked.holds(), true);
  is(`${job.name}: and kept on the list to try again, refund to payment`, await waiting(job.retry), { [row("s", 50)]: blocked.pi });
  const ttl = await ttlOf();
  is(`${job.name}: the list is kept 400 days, as the records it could take back`, ttl > 399 * 86_400 && ttl <= 400 * 86_400, true);
  is(`${job.name}: read to its end, the anchor moves: the row on the list does not hold it`, await read(job.anchor), String(base));
  is(`${job.name}: and the pass is let go`, await read(job.pass), null);

  part(`${job.name}: the list is tried again first on every run, and a row is let go only once handled`);
  refunds = [];
  is(`${job.name}: still failing: nothing taken back`, await job.run(refusing), 0);
  is(`${job.name}: still on the list`, Object.keys(await waiting(job.retry)).length, 1);
  is(`${job.name}: handled now: taken back from the list`, await job.run(), 1);
  is(`${job.name}: no longer held`, await blocked.holds(), false);
  is(`${job.name}: and let go of the list`, await waiting(job.retry), {});

  part(`${job.name}: with the list full, the row holds the anchor, never the refunds behind it`);
  const again = await job.make(4);
  const later = await job.make(5);
  refunds = list(`${job.name}f`, 250, base + 900, { 50: again.pi, 230: later.pi });
  const refusingAgain = async (email: string) => {
    if (email === again.email) throw new Error("the ledger never answers for this one");
  };
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    return commands.length === 1 && commands[0][0] === "HLEN" && commands[0][1] === job.retry ? [100] : replies;
  };
  try {
    is(`${job.name}: the list full: the refund behind is taken back in the same run`, await job.run(refusingAgain), 1);
  } finally {
    redis.pipeline = original;
  }
  is(`${job.name}: the refund behind is no longer held`, await later.holds(), false);
  is(`${job.name}: nothing put on the list`, await waiting(job.retry), {});
  is(`${job.name}: the anchor waits at the row that could not be kept`, await read(job.anchor), String(base + 900 - 50));
  is(`${job.name}: still held`, await again.holds(), true);
  is(`${job.name}: the next pass reads it again and takes it back once it can be`, await job.run(), 1);
  is(`${job.name}: no longer held once handled`, await again.holds(), false);
  is(`${job.name}: the list is empty`, await waiting(job.retry), {});
  is(`${job.name}: the anchor moves to the newest refund`, await read(job.anchor), String(base + 900));

  part(`${job.name}: a write to the list left unknown holds the anchor at the row`);
  const third = await job.make(6);
  const last = await job.make(7);
  refunds = list(`${job.name}u`, 250, base + 1800, { 50: third.pi, 230: last.pi });
  const refusingThird = async (email: string) => {
    if (email === third.email) throw new Error("the ledger never answers for this one");
  };
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    return commands[0]?.[0] === "HSET" && commands[0][1] === job.retry ? replies.map(() => "OK?") : replies;
  };
  try {
    is(`${job.name}: unknown write: the refund behind is taken back in the same run`, await job.run(refusingThird), 1);
  } finally {
    redis.pipeline = original;
  }
  is(`${job.name}: the refund behind is no longer held`, await last.holds(), false);
  is(`${job.name}: unknown write: the anchor waits at the row`, await read(job.anchor), String(base + 1800 - 50));
  is(`${job.name}: the next pass, the write confirmed: nothing more to take back yet`, await job.run(refusingThird), 0);
  is(`${job.name}: the row is on the list for sure`, Object.keys(await waiting(job.retry)), [row("u", 50)]);
  is(`${job.name}: and the anchor moves past it`, await read(job.anchor), String(base + 1800));
  is(`${job.name}: handled at last`, await job.run(), 1);
  is(`${job.name}: and let go of the list`, await waiting(job.retry), {});

  part(`${job.name}: a refund not final yet holds the anchor while a row behind it goes on the list`);
  const slow = await job.make(8);
  const fourth = await job.make(9);
  refunds = list(`${job.name}h`, 250, base + 2700, { 20: slow.pi, 120: fourth.pi });
  // On the first page: pending, its charge not refunded in full yet (heldAt); on the second, a row never handled.
  refunds[20] = { ...refunds[20], status: "pending", charge: { object: "charge", refunded: false } };
  const refusingFourth = async (email: string) => {
    if (email === fourth.email) throw new Error("the ledger never answers for this one");
  };
  is(`${job.name}: run 1, nothing taken back`, await job.run(refusingFourth), 0);
  is(`${job.name}: the failing row moved to the list`, Object.keys(await waiting(job.retry)), [row("h", 120)]);
  is(`${job.name}: the pass ended, the anchor waits at the refund not final yet`, await read(job.anchor), String(base + 2700 - 20));
  is(`${job.name}: still held while it is pending`, await slow.holds(), true);
  refunds[20] = { ...refunds[20], status: "succeeded", charge: { object: "charge", refunded: true } };
  is(`${job.name}: once it goes through and the row can be handled, both are taken back`, await job.run(), 2);
  is(`${job.name}: neither is held`, [await slow.holds(), await fourth.holds()], [false, false]);
  is(`${job.name}: the list is empty again`, await waiting(job.retry), {});
  is(`${job.name}: the anchor moves to the newest refund`, await read(job.anchor), String(base + 2700));

  part(`${job.name}: a full refund not final yet whose work fails never goes on the list, and is never taken back once Stripe fails it`);
  const pend = await job.make(10);
  refunds = list(`${job.name}p`, 250, base + 3600, { 30: pend.pi });
  // A full refund still pending (rowGivesBack takes it as giving back): its work is tried, and fails.
  refunds[30] = { ...refunds[30], status: "pending" };
  const refusingPend = async (email: string) => {
    if (email === pend.email) throw new Error("the ledger never answers for this one");
  };
  for (let run = 1; run <= 3; run += 1) is(`${job.name}: run ${run}, nothing taken back`, await job.run(refusingPend), 0);
  is(`${job.name}: never put on the list, which would take it back as finished`, await waiting(job.retry), {});
  is(`${job.name}: the anchor waits at it, so it is read again with its status then`, await read(job.anchor), String(base + 3600 - 30));
  // Stripe fails the refund: no money went back.
  refunds[30] = { ...refunds[30], status: "failed", charge: { object: "charge", refunded: false } };
  is(`${job.name}: the work could be done now, but nothing is taken back: the refund failed`, await job.run(), 0);
  is(`${job.name}: still held: the buyer did not get the money back`, await pend.holds(), true);
  is(`${job.name}: and the anchor moves to the newest refund`, await read(job.anchor), String(base + 3600));
}

/**
 * A refund on the list read again before anything is taken back (review of #3302, Claude 2 MEDIUM, probes P1 and P3;
 * the owner's decision 18 of 9 November 2026). Each part starts from a confirmed absent anchor, so its rows are read.
 */
async function stale(job: Job, base: number): Promise<void> {
  const row = (tag: string, i: number) => `re_${job.name}${tag}${String(i).padStart(6, "0")}`;
  const refusing = (who: string) => async (email: string) => {
    if (email === who) throw new Error("the ledger never answers for this one");
  };
  /** A refund whose work fails once and goes on the list; then Stripe lists nothing newer, and reads it as `now` says. */
  const listedThen = async (tag: string, n: number, first: Record<string, unknown> = {}): Promise<{ made: Made; id: string; says: (now: Record<string, unknown>) => void }> => {
    await original.call(redis, [["DEL", job.anchor], ["DEL", job.pass]]);
    const made = await job.make(n);
    refunds = list(`${job.name}${tag}`, 3, base, { 1: made.pi });
    refunds[1] = { ...refunds[1], ...first };
    const id = row(tag, 1);
    is(`${job.name} ${tag}: run 1, its work fails: nothing taken back`, await job.run(refusing(made.email)), 0);
    is(`${job.name} ${tag}: on the list to try again`, await waiting(job.retry), { [id]: made.pi });
    const kept = refunds[1];
    refunds = [];
    return { made, id, says: (now) => void ledger.set(id, { ...kept, ...now }) };
  };

  part(`${job.name}: a full refund on the list that Stripe then fails is never taken back (probe P1)`);
  const p1 = await listedThen("x", 30);
  p1.says({ status: "failed", charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  rereads.length = 0;
  is(`${job.name} P1: the work could be done now, but nothing is taken back: the refund failed`, await job.run(), 0);
  is(`${job.name} P1: still held: the buyer did not get the money back`, await p1.made.holds(), true);
  is(`${job.name} P1: let go of the list`, await waiting(job.retry), {});
  is(`${job.name} P1: read again once, on the store's account, with its charge`, rereads, [{ id: p1.id, account: ACCOUNT, expand: ["charge"] }]);

  part(`${job.name}: a part refund on a charge marked refunded, whose other part then fails, is never taken back (probe P3)`);
  const p3 = await listedThen("y", 31, { amount: 1500, charge: { object: "charge", refunded: true, amount: 2500, amount_refunded: 2500 } });
  p3.says({ charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 1500 } });
  is(`${job.name} P3: nothing taken back: the charge is no longer refunded in full`, await job.run(), 0);
  is(`${job.name} P3: still held`, await p3.made.holds(), true);
  is(`${job.name} P3: let go of the list`, await waiting(job.retry), {});

  part(`${job.name}: a refund on the list that Stripe cancels is let go, nothing taken back`);
  const off = await listedThen("c", 32);
  off.says({ status: "canceled", charge: { object: "charge", refunded: false } });
  is(`${job.name} canceled: nothing taken back`, await job.run(), 0);
  is(`${job.name} canceled: still held`, await off.made.holds(), true);
  is(`${job.name} canceled: let go of the list`, await waiting(job.retry), {});

  part(`${job.name}: a refund on the list Stripe reads as not final yet stays on it, and is taken back once it succeeds`);
  const slow = await listedThen("z", 33);
  for (const status of ["pending", "requires_action"]) {
    slow.says({ status });
    is(`${job.name} ${status}: nothing taken back`, await job.run(), 0);
    is(`${job.name} ${status}: still held`, await slow.made.holds(), true);
    is(`${job.name} ${status}: still on the list`, await waiting(job.retry), { [slow.id]: slow.made.pi });
  }
  slow.says({ status: "succeeded" });
  is(`${job.name}: succeeded on a charge refunded in full: taken back`, await job.run(), 1);
  is(`${job.name}: no longer held`, await slow.made.holds(), false);
  is(`${job.name}: and let go of the list`, await waiting(job.retry), {});

  part(`${job.name}: a refund on the list read in another shape, or answered with an error, stays on it, nothing taken back`);
  const odd = await listedThen("o", 34);
  const good = { status: "succeeded", charge: { object: "charge", refunded: true } };
  for (const [label, now] of [
    ["a status Stripe does not give", { ...good, status: "done" }],
    ["its charge not expanded", { ...good, charge: "ch_NotExpanded000001" }],
    ["no charge", { ...good, charge: null }],
    ["a charge with no refunded flag", { ...good, charge: { object: "charge", amount: 2500, amount_refunded: 2500 } }],
    ["another refund's id", { ...good, id: "re_SomeoneElse000001" }],
    ["another payment", { ...good, payment_intent: "pi_SomeoneElse000001" }],
    ["another object", { ...good, object: "charge" }],
  ] as const) {
    odd.says(now);
    is(`${job.name}, ${label}: nothing taken back`, await job.run(), 0);
    is(`${job.name}, ${label}: still held`, await odd.made.holds(), true);
    is(`${job.name}, ${label}: still on the list`, await waiting(job.retry), { [odd.id]: odd.made.pi });
  }
  odd.says(good);
  erring.add(odd.id);
  is(`${job.name}, Stripe answers with an error: nothing taken back`, await job.run(), 0);
  is(`${job.name}, Stripe answers with an error: still on the list`, await waiting(job.retry), { [odd.id]: odd.made.pi });
  erring.delete(odd.id);
  ledger.delete(odd.id);
  is(`${job.name}, Stripe has no such refund: nothing taken back`, await job.run(), 0);
  is(`${job.name}, Stripe has no such refund: still on the list`, await waiting(job.retry), { [odd.id]: odd.made.pi });
  odd.says(good);
  is(`${job.name}: control: read in its shape, succeeded and refunded in full: taken back`, await job.run(), 1);
  is(`${job.name}: control: no longer held`, await odd.made.holds(), false);
  is(`${job.name}: control: let go of the list`, await waiting(job.retry), {});

  part(`${job.name}: at most ten refunds on the list are read again a run, from a place that moves on every five minutes`);
  await original.call(redis, [["DEL", job.anchor], ["DEL", job.pass]]);
  refunds = [];
  const many = Array.from({ length: 25 }, (_, i) => ({ id: row("m", i), pi: `pi_${job.name}many${String(i).padStart(6, "0")}` }));
  await original.call(redis, [["HSET", job.retry, ...many.flatMap((m) => [m.id, m.pi])]]);
  for (const m of many) ledger.set(m.id, { id: m.id, object: "refund", created: base, status: "pending", payment_intent: m.pi, charge: { object: "charge", refunded: true } });
  const realNow = Date.now;
  const seen = new Set<string>();
  try {
    for (let slot = 0; slot < 3; slot += 1) {
      const at = realNow() + slot * 300_000;
      Date.now = () => at;
      rereads.length = 0;
      await job.run();
      is(`${job.name}, five minutes x ${slot}: ten read again`, rereads.length, 10);
      for (const r of rereads) seen.add(r.id);
    }
    is(`${job.name}: in three runs every one on the list was read again`, seen.size, 25);
    is(`${job.name}: none let go while not final yet`, Object.keys(await waiting(job.retry)).length, 25);
    for (const m of many) ledger.set(m.id, { ...ledger.get(m.id), status: "succeeded" });
    const left: number[] = [];
    for (let slot = 3; slot < 6; slot += 1) {
      const at = realNow() + slot * 300_000;
      Date.now = () => at;
      await job.run();
      left.push(Object.keys(await waiting(job.retry)).length);
    }
    is(`${job.name}: handled ten a run, until the list is empty`, left, [15, 5, 0]);
  } finally {
    Date.now = realNow;
  }
}

/**
 * The place the list is read again from moves with this store's own visits, never with the clock (focal review of
 * #3302, comment 6786660350, MEDIUM): with the start taken from the time, a store the sweep reaches every ten minutes
 * read the same ten rows of a list of twenty on every visit, so when those ten could never be handled (a refund from an
 * earlier account Stripe no longer finds, a course removal that always fails), the refunds put on the list after them
 * stayed with the buyer forever. Twenty rows: the ten that are always kept first (in the order they were put on the
 * list and by id), then ten full refunds Stripe finished of real gifts or pre-orders; six visits.
 */
async function rotation(job: Job, base: number): Promise<void> {
  const realNow = Date.now;
  // Visits on whole ten-minute marks, so a start taken from the clock is the same on every one of them.
  const first = Math.floor(realNow() / 600_000) * 600_000 + 600_000 + 1_000;
  const cases = [
    { label: "visited every five minutes (control), ten rows from an earlier account first", every: 300_000, tag: "q", good: 40, failing: 0 },
    { label: "visited every ten minutes, ten rows from an earlier account first", every: 600_000, tag: "r", good: 50, failing: 0 },
    { label: "visited every ten minutes, ten rows whose course removal always fails first", every: 600_000, tag: "t", good: 60, failing: 70 },
  ];
  for (const c of cases) {
    part(`${job.name}: ${c.label}: every refund on the list is read again, whatever the time of the visits`);
    await original.call(redis, [["DEL", job.anchor], ["DEL", job.pass], ["DEL", job.retry]]);
    refunds = [];
    const stuckIds = Array.from({ length: 10 }, (_, i) => `re_${job.name}${c.tag}A${String(i).padStart(6, "0")}`);
    const goodIds = Array.from({ length: 10 }, (_, i) => `re_${job.name}${c.tag}B${String(i).padStart(6, "0")}`);
    const good: Made[] = [];
    for (let i = 0; i < 10; i += 1) good.push(await job.make(c.good + i));
    const never = new Set<string>();
    const stuckPis: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      if (c.failing) {
        const made = await job.make(c.failing + i);
        never.add(made.email);
        stuckPis.push(made.pi);
        ledger.set(stuckIds[i], { id: stuckIds[i], object: "refund", created: base, status: "succeeded", payment_intent: made.pi, charge: { object: "charge", refunded: true } });
      } else {
        // A refund from an earlier account: the store's account has no such refund (404), so it is kept on every read.
        stuckPis.push(`pi_${job.name}${c.tag}gone${String(i).padStart(6, "0")}`);
        ledger.delete(stuckIds[i]);
      }
    }
    for (let i = 0; i < 10; i += 1) {
      ledger.set(goodIds[i], { id: goodIds[i], object: "refund", created: base, status: "succeeded", payment_intent: good[i].pi, charge: { object: "charge", refunded: true } });
    }
    await original.call(redis, [["HSET", job.retry, ...stuckIds.flatMap((id, i) => [id, stuckPis[i]]), ...goodIds.flatMap((id, i) => [id, good[i].pi])]]);
    const refusing = async (email: string) => {
      if (never.has(email)) throw new Error("the ledger never answers for this one");
    };
    const readAgain = new Set<string>();
    try {
      for (let visit = 0; visit < 6; visit += 1) {
        const at = first + visit * c.every;
        Date.now = () => at;
        rereads.length = 0;
        await job.run(refusing);
        for (const r of rereads) readAgain.add(r.id);
        is(`${job.name} ${c.tag}, visit ${visit + 1}: at most ten read again`, rereads.length <= 10, true);
      }
    } finally {
      Date.now = realNow;
    }
    const held: boolean[] = [];
    for (const g of good) held.push(await g.holds());
    is(`${job.name} ${c.tag}: no refund behind the rows always kept is left with the buyer`, held.filter(Boolean).length, 0);
    is(`${job.name} ${c.tag}: every refund on the list was read again`, goodIds.filter((id) => !readAgain.has(id)).length + stuckIds.filter((id) => !readAgain.has(id)).length, 0);
    is(`${job.name} ${c.tag}: the rows always kept stay on the list, nothing taken back for them`, Object.keys(await waiting(job.retry)).sort(), [...stuckIds].sort());
    await original.call(redis, [["DEL", job.retry]]);
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_refund_retry_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_refund_retry_only";

  await claimHandle("owner@retry.example", "retryshop", "Retry Shop", "");
  await ensureStatsId("owner@retry.example");
  await setStripeAccount("owner@retry.example", "acct_1TestRetryRef01", true);
  await setSubscription("owner@retry.example", { customerId: "cus_RetryOwner01", subscriptionId: "sub_RetryOwner01", active: true, period: paidPeriod() });
  const made = await addProduct("owner@retry.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@retry.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@retry.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = {
    base: "https://marktmorgen.com/@retryshop",
    from: '"Retry Shop" <hello@marktmorgen.com>',
    ordersLink: async (email: string) => `https://marktmorgen.com/@retryshop/orders?for=${encodeURIComponent(email)}`,
    recordStart: async () => {},
  };
  const holds = async (email: string) => (await importedFor((await storeForEmail("owner@retry.example")) as Store, email)).length > 0;
  const fine = async () => {};

  const gift: Job = {
    name: "gift",
    anchor: `nl:gift:${store.statsId}:refunds`,
    pass: `nl:gift:${store.statsId}:refunds:pass`,
    retry: `nl:gift:${store.statsId}:refunds:retry`,
    run: (dropStart = fine) => revokeRefundedGifts(store, Date.now() + 60_000, dropStart),
    make: async (n) => {
      const to = `friend${n}@retry.example`;
      const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
      if (!started.ok) throw new Error("no gift");
      const pi = `pi_retrygift${String(n).padStart(8, "0")}`;
      const given = await deliverGift({
        store,
        session: { id: `cs_test_retrygift${String(n).padStart(8, "0")}`, created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: "retryshop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@retry.example" } } as never,
        product: product as Listing,
        base: deps.base,
        from: deps.from,
        recordStart: async () => {},
        ordersLink: async () => null,
      });
      if (given !== "given") throw new Error(`gift ${n} not given: ${given}`);
      return { pi, email: to, holds: () => holds(to) };
    },
  };
  const pre: Job = {
    name: "pre",
    anchor: `nl:pre:${store.statsId}:refunds`,
    pass: `nl:pre:${store.statsId}:refunds:pass`,
    retry: `nl:pre:${store.statsId}:refunds:retry`,
    run: (dropStart = fine) => revokeRefundedPreorders(store, Date.now() + 60_000, dropStart),
    make: async (n) => {
      const email = `buyer${n}@retry.example`;
      const pi = `pi_retrypre${String(n).padStart(8, "0")}`;
      const session = {
        id: `cs_test_retrypre${String(n).padStart(8, "0")}`,
        created: NOW - 600,
        status: "complete",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        payment_intent: pi,
        metadata: { store: "retryshop", product: product.id, preorder: "yes" },
        customer_details: { email },
      };
      const given = await confirmPreorder(store, session as never, product, deps);
      if (given !== "given") throw new Error(`pre-order ${n} not given: ${given}`);
      return { pi, email, holds: () => holds(email) };
    },
  };

  await anchors(gift, NOW - 10_000);
  await stuck(gift, NOW - 9_000);
  await stale(gift, NOW - 20_000);
  await rotation(gift, NOW - 30_000);
  await anchors(pre, NOW - 5_000);
  await stuck(pre, NOW - 4_000);
  await stale(pre, NOW - 20_000);
  await rotation(pre, NOW - 30_000);

  done();
}

void main();
