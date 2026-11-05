/** The actual review-request worker must retain unknown erasure checks for retry. */
import assert from "node:assert/strict";
import test from "node:test";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY, askMember, scheduleReviewAsk } from "@/lib/review-ask";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { suppressCommand } from "@/lib/suppression";
import { usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
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

const unknown: [string, unknown[] | "throw"][] = [
  ["empty", []], ["short", [0, null]], ["missing suppression", [0, null, undefined]],
  ["extra", [0, null, 0, 0]], ["null opt-out", [null, null, 0]],
  ["string opt-out", ["0", null, 0]], ["negative opt-out", [-1, null, 0]],
  ["null suppression", [0, null, null]], ["string suppression", [0, null, "0"]],
  ["object suppression", [0, null, {}]], ["false suppression", [0, null, false]],
  ["invalid contact", [0, "{", 0]], ["object contact", [0, {}, 0]],
  ["primitive contact", [0, '"contact"', 0]], ["array contact", [0, "[]", 0]],
  ["wrong opt-out field", [0, '{"unsub":"true"}', 0]],
  ["sparse", Object.assign(new Array(3), { 0: 0, 1: null })], ["transport failure", "throw"],
];
for (const [name, reply] of unknown) {
  test(`${name} recipient evidence retains the erased buyer's review request for retry`, async () => {
    const oldFetch = globalThis.fetch;
    const r = await setup();
    redis.run(suppressCommand(r.shop.listId!, person));
    const before = await usedThisMonth(r.shop.listId, windowId(r.shop));
    redis.pipeline = async commands => {
      if (commands.some(c => c[0] === "HEXISTS" && c[1] === `nl:erased:${r.shop.listId}`)) {
        if (reply === "throw") throw new Error("synthetic recipient read failure");
        return reply;
      }
      return r.original(commands);
    };
    try {
      const result = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
      assert.deepEqual(result, { sent: 0, dropped: 0, waiting: 1 });
      assert.equal(r.batches.length, 0);
      assert.equal(await usedThisMonth(r.shop.listId, windowId(r.shop)), before);
      assert.equal(redis.run(["GET", `nl:rev:ask:sent:${reference}`]), null, "no send claim is created");
      assert.deepEqual(redis.run(["ZRANGEBYSCORE", ASK_DUE_KEY, r.now + 1, r.now + 3600]), [r.member], "the same request remains due at the existing retry interval");
      redis.pipeline = r.original;
      const recovered = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 3601);
      assert.deepEqual(recovered, { sent: 0, dropped: 1, waiting: 0 });
      assert.equal(r.batches.length, 0, "confirmed erasure still excludes the buyer after recovery");
    } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
  });
}

test("complete evidence still sends a permitted buyer one review request", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  try {
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now), { sent: 1, dropped: 0, waiting: 0 });
    assert.deepEqual(r.batches.flat().flatMap(m => m.to), [person]);
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 1), { sent: 0, dropped: 0, waiting: 0 });
    assert.equal(r.batches.flat().length, 1);
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});
