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
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** `count` full refunds, newest first, created from `newest` down; those at the indexes of `paid` paid with its payments. */
function list(tag: string, count: number, newest: number, paid: Record<number, string>): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `re_${tag}${String(i).padStart(6, "0")}`,
    object: "refund",
    created: newest - i,
    status: "succeeded",
    payment_intent: paid[i] ?? `pi_${tag}other${String(i).padStart(6, "0")}`,
    charge: { object: "charge", refunded: true },
  }));
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
  refundCalls.length = 0;
  is(`${job.name}: the refund on the list is taken back`, await job.run(), 1);
  is(`${job.name}: no longer held`, await listed.holds(), false);
  is(`${job.name}: and let go of the list`, await waiting(job.retry), {});
  is(`${job.name}: still nothing asked of Stripe`, refundCalls.length, 0);
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
  await anchors(pre, NOW - 5_000);
  await stuck(pre, NOW - 4_000);

  done();
}

void main();
