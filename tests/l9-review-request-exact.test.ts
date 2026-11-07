/**
 * CX-123 rule 24, lot L9: the review-request worker (lib/review-requests.ts) decides from the order's mark which email
 * is due and claims it before sending. A mark read in an unknown shape is never "not asked yet" (the order stays due
 * and nothing is sent), and a claim answered oddly that did not land sends nothing, while the next run sends it once.
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
async function setup() {
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
  await setReviewAsk(owner, { days: 7 });
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


/** The reply to the first command named `name` on the order's mark, without it reaching Redis. */
function withMarkReply(r: Awaited<ReturnType<typeof setup>>, name: string, reply: unknown[]): void {
  let used = false;
  redis.pipeline = async (commands) => {
    if (!used && commands[0]?.[0] === name && commands[0]?.[1] === `nl:rev:ask:sent:${reference}`) {
      used = true;
      return reply;
    }
    return r.original(commands);
  };
}

test("a mark read in an unknown shape sends nothing and keeps the order due", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  try {
    withMarkReply(r, "GET", [undefined]);
    await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    redis.pipeline = r.original;
    assert.equal(r.batches.flat().length, 0, "nothing sent on an unknown mark");
    assert.equal(redis.run(["ZSCORE", ASK_DUE_KEY, r.member]) !== null, true, "the order is still due, not dropped");
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now), { sent: 1, dropped: 0, waiting: 0 });
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});

test("a claim answered oddly that did not land sends nothing; the next run sends it once", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  try {
    withMarkReply(r, "SET", ["QUEUED"]);
    await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    redis.pipeline = r.original;
    assert.equal(r.batches.flat().length, 0, "nothing sent on a claim that is not ours");
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now), { sent: 1, dropped: 0, waiting: 0 });
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 1), { sent: 0, dropped: 0, waiting: 0 });
    assert.equal(r.batches.flat().length, 1);
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});
