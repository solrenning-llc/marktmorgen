/**
 * The review-request worker (lib/review-requests.ts, sendReviewRequests) when something throws after an order's first
 * email was claimed (webhooks/cron audit, Claude 1, 12/11/2026). The claim is a "sending:" mark kept 120 days; a
 * Redis failure while the email was being written (the review link, the stop link) or while its batch was reserved
 * left the whole run thrown with the mark in place, and the next run read "sending:" as asked already and dropped
 * the order: the review request never went. Now what the run claimed for an order it did not send is let go, and the
 * next run sends it, once. Setup as tests/l9-review-request-exact.test.ts; synthetic only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY, askMember, scheduleReviewAsk } from "@/lib/review-ask";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
const person = "review-person@example.test";
const reference = "cs_test_ReviewProof001";
async function setup(again = 0) {
  redis.clear();
  const owner = "review-owner@example.test";
  const batches: { to: string | string[] }[][] = [];
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
    if (url.pathname === `/v1/checkout/sessions/${reference}`) return Response.json({
      id: reference, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
      created: paidAt, amount_total: 2700, currency: "usd", customer_details: { email: person },
      metadata: { store: "reviewproof", product: productId },
      payment_intent: { id: "pi_ReviewProof001", status: "succeeded", latest_charge: { id: "ch_ReviewProof001", amount: 2700, amount_refunded: 0, disputed: false, refunded: false } },
    });
    return Response.json({ object: "list", data: [], has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "reviewproof", "Review Proof", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_ReviewProof", subscriptionId: "sub_ReviewProof", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Review Proof", address: "1 Example St, Example City" });
  await setReviewAsk(owner, again ? { days: 7, again } : { days: 7 });
  const made = await addProduct(owner, "Review evidence", "", "27", null);
  assert.ok(made.ok); productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/review");
  const shop = (await storeForEmail(owner))!;
  assert.equal(await scheduleReviewAsk(shop, reference, paidAt), true);
  const member = askMember({ statsId: shop.statsId!, handle: shop.handle, reference, paidAt });
  const base = redis.pipeline.bind(redis);
  // MemoryRedis lacks ZADD XX. Match native Redis 7.4.2's existing-member
  // update here, without changing the worker or weakening the retry assertion.
  const original: typeof redis.pipeline = async commands => {
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
  return { shop, now, member, batches, original, base };
}


test("a throw after the first email's claim never drops the order unsent", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  try {
    let claimed = false, thrown = false;
    redis.pipeline = async (commands) => {
      if (claimed && !thrown) { thrown = true; throw new Error("synthetic Redis timeout"); }
      const out = await r.original(commands);
      if (commands[0]?.[0] === "SET" && commands[0]?.[1] === `nl:rev:ask:sent:${reference}` && String(commands[0]?.[2]).startsWith("sending:")) claimed = true;
      return out;
    };
    const oldLog = console.error;
    console.error = () => {};
    const first = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now).catch(() => "threw" as const);
    console.error = oldLog;
    redis.pipeline = r.original;
    assert.equal(r.batches.flat().length, 0, "nothing was sent on the run that failed");
    assert.notEqual(first, "threw", "one order failing never throws the whole run away");
    assert.notEqual(redis.run(["ZSCORE", ASK_DUE_KEY, r.member]), null, "the order is still due");
    const second = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    assert.deepEqual(second, { sent: 1, dropped: 0, waiting: 0 }, "the next run sends it, never drops it");
    assert.equal(r.batches.flat().length, 1, "once");
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});

// Codex T on #4360: the undo itself fails too. A claim is written short (an hour) and stretched only just before its
// batch goes, so one a run could not let go of lapses on its own: the order waits, and is sent once after it lapses.
const SENT = `nl:rev:ask:sent:${reference}`;
const AGAIN = `${SENT}:again`;

test("a first whose claim cannot be let go of waits for it to lapse, never dropped", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  try {
    let claimed = false, failures = 0;
    redis.pipeline = async (commands) => {
      // The review link's write fails, and then the release of the claim fails too.
      if (claimed && failures < 2) { failures += 1; throw new Error("synthetic Redis timeout"); }
      const out = await r.original(commands);
      if (commands[0]?.[0] === "SET" && commands[0]?.[1] === SENT && String(commands[0]?.[2]).startsWith("sending:")) claimed = true;
      return out;
    };
    const oldLog = console.error;
    console.error = () => {};
    await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    console.error = oldLog;
    redis.pipeline = r.original;
    assert.equal(failures, 2, "both the preparation and the release failed");
    const ttl = Number(redis.run(["TTL", SENT]));
    assert.ok(ttl > 0 && ttl <= 3600, "the claim left behind lapses within the hour");
    const waiting = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    assert.equal(waiting.dropped, 0, "the next run does not drop the order on the stuck claim");
    assert.notEqual(redis.run(["ZSCORE", ASK_DUE_KEY, r.member]), null, "the order is still due");
    redis.run(["DEL", SENT]); // the claim lapses
    const after = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 3601);
    assert.equal(after.sent, 1, "once it lapsed, the order is sent");
    assert.equal(r.batches.flat().length, 1, "once");
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});

test("a reminder whose claim cannot be let go of stays on the list and is sent once it lapses", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup(3);
  try {
    const first = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    assert.equal(first.sent, 1, "the first goes");
    const later = r.now + 3 * 86400 + 60;
    let claimed = false, failures = 0;
    redis.pipeline = async (commands) => {
      if (claimed && failures < 2) { failures += 1; throw new Error("synthetic Redis timeout"); }
      const out = await r.original(commands);
      if (commands[0]?.[0] === "SET" && commands[0]?.[1] === AGAIN) claimed = true;
      return out;
    };
    const oldLog = console.error;
    console.error = () => {};
    await sendReviewRequests(storeForHandle, Date.now() + 20000, later);
    console.error = oldLog;
    redis.pipeline = r.original;
    assert.equal(failures, 2, "both the preparation and the release failed");
    assert.equal(r.batches.flat().length, 1, "nothing more was sent on that run");
    assert.notEqual(redis.run(["ZSCORE", ASK_DUE_KEY, r.member]), null, "the reminder is still on the list");
    const ttl = Number(redis.run(["TTL", AGAIN]));
    assert.ok(ttl > 0 && ttl <= 3600, "its claim lapses within the hour");
    redis.run(["DEL", AGAIN]); // the claim lapses
    const after = await sendReviewRequests(storeForHandle, Date.now() + 20000, later + 3601);
    assert.equal(after.sent, 1, "the reminder is sent");
    assert.equal(r.batches.flat().length, 2, "once");
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});
