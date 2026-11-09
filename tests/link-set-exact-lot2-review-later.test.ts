/**
 * A review request whose call throws before the order was claimed is put back
 * for later, not left due at its old time (lib/review-requests.ts
 * sendReviewRequests, rule 30, lot 2 pre-review R4): a buyer's review that Redis
 * answers in an unknown shape moves the order an hour on (RETRY_SECONDS.stripe),
 * so it is not read again in Stripe on every five-minute run for up to fourteen
 * days, holding one of the run's MAX_ASKS_PER_RUN places; it is asked once the
 * hour is up, the run's other orders still go, and nothing goes twice.
 *
 * Stripe and the email sender are played by a stand-in for `fetch`; ids are synthetic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY, askMember, scheduleReviewAsk } from "@/lib/review-ask";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { reviewId } from "@/lib/reviews";
import { paidPeriod } from "./billing-period-fixture";

const A = { reference: "cs_test_ReviewLoopA01", email: "review-loop-a@example.test", pi: "pi_ReviewLoopA01", charge: "ch_ReviewLoopA01" };
const B = { reference: "cs_test_ReviewLoopB02", email: "review-loop-b@example.test", pi: "pi_ReviewLoopB02", charge: "ch_ReviewLoopB02" };
const LINK = "nl:rev:link:";
const hooks: { after: (() => void) | null } = { after: null };
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
      const batch = JSON.parse(String(init?.body)); batches.push(batch); hooks.after?.();
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

test("R4: a review read answered oddly for A puts A an hour on; Stripe reads A once; A goes after the hour, B now, each once", () => inWorld(async (w) => {
  let stripeA = 0;
  const f = globalThis.fetch;
  globalThis.fetch = (async (i: string | URL | Request, init?: RequestInit) => { if (String(i).includes(A.reference)) stripeA += 1; return f(i, init); }) as typeof fetch;
  const shop = (await storeForHandle("reviewloop"))!;
  let odd = true; let hit = 0;
  redis.pipeline = async (c: Commands) => {
    if (odd && c.length === 1 && c[0][0] === "HGET" && String(c[0][1]).startsWith(`nl:rev:${shop.statsId}:`) &&
      c[0][2] === reviewId(shop.statsId!, String(c[0][1]).split(":").pop()!, A.email)) { hit += 1; return [7]; }
    return w.original(c);
  };
  const first = await w.run(w.now);
  assert.equal(hit, 1, "A's review was read once, answered oddly");
  assert.equal(first.sent, 1, "B went in the same run");
  assert.equal(Number(redis.run(["ZSCORE", ASK_DUE_KEY, w.member(A)])), w.now + 3600, "A was put an hour on, not left due at its old time");
  for (const at of [w.now + 300, w.now + 600, w.now + 3000]) await w.run(at);
  assert.equal(stripeA, 1, "A is not read in Stripe again before the hour");
  assert.equal(hit, 1, "nor its review read again");
  odd = false;
  await w.run(w.now + 3601); await w.run(w.now + 3901);
  globalThis.fetch = f;
  assert.deepEqual(w.sentTo().sort(), [A.email, B.email].sort(), "each sent once");
}));
