/**
 * One order's Redis call that throws never stops the other orders of the same
 * review-request run (lib/review-requests.ts sendReviewRequests, rule 30, the
 * siblings of the link write fixed in lot 2):
 *
 *   - an order dropped from the list whose ZREM throws stays on the list and is
 *     dropped by the next run; the run's other orders are still sent;
 *   - an order put back for later whose ZADD throws stays due at its old time,
 *     is sent once by the next run, and the run's other orders are still sent;
 *   - a reminder whose link was not stored and whose ZADD back on the list
 *     throws leaves the run's other reminders to be sent, and is never sent
 *     twice: when the ZADD landed it goes once in an hour;
 *   - a stop link whose write throws after the order was claimed lets the
 *     claim go and deletes the unsent review link, so the order is sent once an
 *     hour later, and the run's other orders are still sent;
 *   - a sent-mark read that throws puts that order an hour on, when it is sent
 *     once, and the run's other orders are still sent;
 *   - the write after a batch went that throws never makes the run throw: the
 *     emails went, are counted, and are never sent again.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY, askMember, scheduleReviewAsk } from "@/lib/review-ask";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const A = { reference: "cs_test_ReviewLoopA01", email: "review-loop-a@example.test", pi: "pi_ReviewLoopA01", charge: "ch_ReviewLoopA01" };
const B = { reference: "cs_test_ReviewLoopB02", email: "review-loop-b@example.test", pi: "pi_ReviewLoopB02", charge: "ch_ReviewLoopB02" };
const LINK = "nl:rev:link:";
const STOP = "nl:rev:stop:";
const sentKey = (reference: string) => `nl:rev:ask:sent:${reference}`;
type Commands = Parameters<typeof redis.pipeline>[0];

async function setup() {
  redis.clear();
  const owner = "review-loop-owner@example.test";
  const batches: { to: string | string[] }[][] = [];
  const stripeDown = new Set<string>();
  let productId = "";
  const now = Math.floor(Date.now() / 1000);
  const paidAt = now - 8 * 86400;
  process.env.STRIPE_SECRET_KEY = "sk_test_reviews_only_a_stand_in";
  // Existing allowlisted synthetic provider credential; never a live account.
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body)); batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    for (const order of [A, B]) {
      if (url.pathname !== `/v1/checkout/sessions/${order.reference}`) continue;
      if (stripeDown.delete(order.reference)) return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
      return Response.json({
        id: order.reference, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
        created: paidAt, amount_total: 2700, currency: "usd", customer_details: { email: order.email },
        metadata: { store: "reviewloop", product: productId },
        payment_intent: { id: order.pi, status: "succeeded", latest_charge: { id: order.charge, amount: 2700, amount_refunded: 0, disputed: false, refunded: false } },
      });
    }
    return Response.json({ object: "list", data: [], has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "reviewloop", "Review Loop", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_ReviewLoop", subscriptionId: "sub_ReviewLoop", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Review Loop", address: "1 Example St, Example City" });
  await setReviewAsk(owner, { days: 7, again: 7 } as Parameters<typeof setReviewAsk>[1]);
  const made = await addProduct(owner, "Review loop", "", "27", null);
  assert.ok(made.ok); productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/review");
  const shop = (await storeForEmail(owner))!;
  for (const order of [A, B]) assert.equal(await scheduleReviewAsk(shop, order.reference, paidAt), true);
  const member = (order: typeof A) => askMember({ statsId: shop.statsId!, handle: shop.handle, reference: order.reference, paidAt });
  const base = redis.pipeline.bind(redis);
  // MemoryRedis lacks ZADD XX: native Redis 7.4.2's existing-member update, as tests/review-request-erasure-evidence.test.ts.
  const original = async (commands: Commands) => {
    if (!commands.some(c => c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX")) return base(commands);
    const replies: unknown[] = [];
    for (const c of commands) {
      if (c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX" && c.length === 5) {
        if (redis.run(["ZSCORE", ASK_DUE_KEY, c[4]]) !== null) redis.run(["ZADD", ASK_DUE_KEY, c[3], c[4]]);
        replies.push(0);
      } else replies.push(...await base([c]));
    }
    return replies;
  };
  redis.pipeline = original;
  /** The first pipeline `matches` picks throws, after it was applied when `landed`; every other goes through. */
  const throwOnce = (matches: (commands: Commands) => boolean, landed = false) => {
    let thrown = 0;
    redis.pipeline = async (commands) => {
      if (thrown === 0 && matches(commands)) {
        thrown += 1;
        if (landed) await original(commands);
        throw new Error("Redis request failed with status 500");
      }
      return original(commands);
    };
    return () => thrown;
  };
  const sentTo = () => batches.flat().flatMap((m) => [m.to].flat());
  const run = (at: number) => sendReviewRequests(storeForHandle, Date.now() + 20000, at);
  const links = () => redis.keys().filter((key) => key.startsWith(LINK)).length;
  return { now, paidAt, member, original, base, throwOnce, sentTo, run, links, stripeDown };
}

type World = Awaited<ReturnType<typeof setup>>;

async function inWorld(work: (w: World) => Promise<void>): Promise<void> {
  const oldFetch = globalThis.fetch;
  const w = await setup();
  try {
    await work(w);
  } finally {
    redis.pipeline = w.base;
    globalThis.fetch = oldFetch;
  }
}

test("a drop whose ZREM throws leaves the order for the next run, and the run's orders are still sent", () => inWorld(async (w) => {
  // An unreadable member, first on the list, so it is dropped before the orders are looked at.
  redis.run(["ZADD", ASK_DUE_KEY, 1, "junk"]);
  const thrown = w.throwOnce((c) => c[0]?.[0] === "ZREM" && c[0]?.[2] === "junk");
  const first = await w.run(w.now);
  redis.pipeline = w.original;
  assert.equal(thrown(), 1, "the drop threw");
  assert.equal(first.sent, 2, "both orders are sent in the same run");
  assert.deepEqual(w.sentTo().sort(), [A.email, B.email].sort());
  assert.notEqual(redis.run(["ZSCORE", ASK_DUE_KEY, "junk"]), null, "the member it could not drop stays on the list");
  const second = await w.run(w.now + 60);
  assert.equal(second.dropped, 1, "the next run drops it");
  assert.equal(redis.run(["ZSCORE", ASK_DUE_KEY, "junk"]), null);
  assert.equal(w.sentTo().length, 2, "nothing is sent twice");
}));

test("a later whose ZADD throws leaves the order due, the run's other order is sent, and it goes once next run", () => inWorld(async (w) => {
  w.stripeDown.add(A.reference);
  const thrown = w.throwOnce((c) => c.some((x) => x[0] === "ZADD" && x[2] === "XX" && x[4] === w.member(A)));
  const first = await w.run(w.now);
  redis.pipeline = w.original;
  assert.equal(thrown(), 1, "the later threw");
  assert.equal(first.sent, 1);
  assert.deepEqual(w.sentTo(), [B.email], "the other order is sent in the same run");
  assert.equal(redis.run(["GET", sentKey(A.reference)]), null, "nothing is held for the order that waits");
  const second = await w.run(w.now + 60);
  assert.equal(second.sent, 1);
  assert.deepEqual(w.sentTo().sort(), [A.email, B.email].sort(), "each order asked once");
}));

for (const landed of [true, false]) {
  test(`a reminder whose link was not stored and whose ZADD back throws${landed ? " (it landed)" : ""} stops no other reminder and is never sent twice`, () => inWorld(async (w) => {
    assert.equal((await w.run(w.now)).sent, 2, "both firsts go");
    const due = Number(redis.run(["ZSCORE", ASK_DUE_KEY, w.member(A)]));
    assert.ok(due > w.now, "the reminders are on the list");
    let odd = 0;
    let thrown = 0;
    redis.pipeline = async (commands) => {
      if (odd === 0 && commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith(LINK) && String(commands[0][2]).includes(A.reference)) {
        odd += 1;
        return [];
      }
      if (thrown === 0 && commands.length === 1 && commands[0][0] === "ZADD" && commands[0].length === 4 && commands[0][3] === w.member(A)) {
        thrown += 1;
        if (landed) await w.original(commands);
        throw new Error("Redis request failed with status 500");
      }
      return w.original(commands);
    };
    const second = await w.run(due);
    redis.pipeline = w.original;
    assert.equal(odd, 1, "the reminder's link was not stored");
    assert.equal(thrown, 1, "putting it back threw");
    assert.equal(second.sent, 1);
    assert.deepEqual(w.sentTo().filter((to) => to === B.email).length, 2, "the other reminder is sent in the same run");
    await w.run(due + 3601);
    const toA = w.sentTo().filter((to) => to === A.email).length;
    if (landed) assert.equal(toA, 2, "back on the list, its reminder goes once");
    else assert.ok(toA <= 2, "never sent twice");
    assert.equal(w.sentTo().filter((to) => to === B.email).length, 2, "the other reminder is never sent again");
  }));
}

for (const landed of [true, false]) {
  test(`a stop link whose write throws${landed ? " (it landed)" : ""} lets the claim go, leaves no link, and stops no other order`, () => inWorld(async (w) => {
    const thrown = w.throwOnce((c) => {
      // Written through the store's room (lib/order-data.ts), as one script that carries the key and the grant.
      const sent = JSON.stringify(c);
      return sent.includes(STOP) && sent.includes(A.email);
    }, landed);
    const first = await w.run(w.now);
    redis.pipeline = w.original;
    assert.equal(thrown(), 1, "the stop link's write threw");
    assert.equal(first.sent, 1);
    assert.deepEqual(w.sentTo(), [B.email], "the other order is sent in the same run");
    assert.equal(redis.run(["GET", sentKey(A.reference)]), null, "the claim is let go");
    assert.equal(w.links(), 1, "only the sent order's link is kept");
    assert.deepEqual(redis.run(["ZRANGEBYSCORE", ASK_DUE_KEY, w.now + 1, w.now + 3600]), [w.member(A)], "still due, an hour later");
    assert.equal((await w.run(w.now + 3601)).sent, 1);
    assert.deepEqual(w.sentTo().sort(), [A.email, B.email].sort(), "each order asked once");
    assert.equal(w.links(), 2, "each with its one link");
  }));
}

test("a sent-mark read that throws puts that order an hour on, and the run's other order is sent", () => inWorld(async (w) => {
  const thrown = w.throwOnce((c) => c.length === 1 && c[0][0] === "GET" && String(c[0][1]).startsWith("nl:rev:ask:sent:"));
  const first = await w.run(w.now);
  redis.pipeline = w.original;
  assert.equal(thrown(), 1, "one read threw");
  assert.equal(first.sent, 1, "the other order is sent in the same run");
  // Altered 2026-11-09 (rule 23, lot 2 pre-review R4): an order whose call throws before its claim is put an hour on
  // (RETRY_SECONDS.stripe), not left due for the next five-minute run, so it is not read again on every run.
  assert.equal((await w.run(w.now + 60)).sent, 0, "the one left waits the hour");
  assert.equal((await w.run(w.now + 3601)).sent, 1, "the one left goes once the hour is up");
  assert.deepEqual(w.sentTo().sort(), [A.email, B.email].sort(), "each order asked once");
}));

test("the write after a batch went that throws never makes the run throw, and nothing is sent again", () => inWorld(async (w) => {
  const thrown = w.throwOnce((c) => c.some((x) => x[0] === "SET" && String(x[1]).startsWith("nl:rev:ask:sent:") && String(x[2]).startsWith("sent:")));
  const first = await w.run(w.now);
  redis.pipeline = w.original;
  assert.equal(thrown(), 1, "the write after the batch threw");
  assert.equal(first.sent, 2, "the emails that went are counted");
  await w.run(w.now + 60);
  await w.run(w.now + 3601);
  assert.deepEqual(w.sentTo().sort(), [A.email, B.email].sort(), "never sent twice");
}));
