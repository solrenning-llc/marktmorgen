/**
 * j-mail-2 (Claude 3 cloud J, email audit): a review request whose sending was not confirmed (the provider may have
 * taken it, then its answer was lost) is tried again later. It must go under the same key as before, so the provider
 * that already took it writes to nobody twice (lib/email.ts sendBatch: "the key makes a retry of the same batch write
 * to nobody twice"). The key was the hash of every reference in the run's batch, so another order of the same store
 * coming due in between changed it, and the buyer already written to got the email again.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY } from "@/lib/review-ask";
import { scheduleReviewAsk } from "@/lib/review-ask";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const orders = [
  { reference: "cs_test_ReviewKeyFirst01", email: "first-buyer@example.test" },
  { reference: "cs_test_ReviewKeySecond1", email: "second-buyer@example.test" },
];

test("a review request retried after a lost answer goes under its own key, never to the same buyer twice", async () => {
  const oldFetch = globalThis.fetch;
  const oldPipeline = redis.pipeline;
  redis.clear();
  const owner = "review-key-owner@example.test";
  const now = Math.floor(Date.now() / 1000);
  // The first order is due now; the second comes due before the first one's retry, so both meet in that run.
  const paid = [now - 7 * DAY - 60, now - 7 * DAY + 900];
  const delivered: string[] = [];
  const answers = new Map<string, Response>();
  let posts = 0;
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_reviews_only_a_stand_in";
  // Existing allowlisted synthetic provider credential; never a live account.
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      // As Resend: a key it has seen is answered as then, and nothing is sent again under it.
      const key = (init?.headers as Record<string, string>)["Idempotency-Key"] ?? "";
      const seen = answers.get(key);
      if (seen) return seen.clone();
      const batch = JSON.parse(String(init?.body)) as { to: string | string[] }[];
      for (const m of batch) delivered.push(...[m.to].flat());
      posts += 1;
      const taken = Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${posts}_${i}` })) });
      if (key) answers.set(key, taken.clone());
      // The first post is taken, and its answer is lost on the way back.
      return posts === 1 ? Response.json({ message: "synthetic server error after acceptance" }, { status: 500 }) : taken;
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const i = orders.findIndex((o) => url.pathname === `/v1/checkout/sessions/${o.reference}`);
    if (i >= 0) return Response.json({
      id: orders[i].reference, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
      created: paid[i], amount_total: 2700, currency: "usd", customer_details: { email: orders[i].email },
      metadata: { store: "reviewkey", product: productId },
      payment_intent: { id: `pi_ReviewKey00${i}`, status: "succeeded", latest_charge: { id: `ch_ReviewKey00${i}`, amount: 2700, amount_refunded: 0, disputed: false, refunded: false } },
    });
    return Response.json({ object: "list", data: [], has_more: false });
  }) as typeof fetch;
  try {
    await claimHandle(owner, "reviewkey", "Review Key", "");
    await ensureStatsId(owner); await ensureListId(owner);
    await setStripeAccount(owner, "acct_1TestHarbor0001", true);
    await setSubscription(owner, { customerId: "cus_ReviewKey", subscriptionId: "sub_ReviewKey", active: true, tier: "pro", period: paidPeriod() });
    await setMailSettings(owner, { fromName: "Review Key", address: "1 Example St, Example City" });
    await setReviewAsk(owner, { days: 7 });
    const made = await addProduct(owner, "Review key evidence", "", "27", null);
    assert.ok(made.ok); productId = made.product.id;
    await setProductLink(owner, productId, "https://example.com/review");
    const shop = (await storeForEmail(owner))!;
    for (let i = 0; i < orders.length; i++) assert.equal(await scheduleReviewAsk(shop, orders[i].reference, paid[i]), true);

    const first = await sendReviewRequests(storeForHandle, Date.now() + 20_000, now);
    assert.deepEqual(delivered, [orders[0].email], "the first run wrote to the first buyer, and lost the answer");
    assert.equal(first.sent, 0, "a lost answer is not counted as sent");

    // Half an hour later the retry meets the second order, now due too.
    const later = await sendReviewRequests(storeForHandle, Date.now() + 20_000, now + 1_801);
    assert.deepEqual(later.sent, 2, "both requests are confirmed in the retry");
    assert.deepEqual(delivered.filter((to) => to === orders[0].email).length, 1, "the first buyer is written to once, never twice");
    assert.deepEqual(delivered.filter((to) => to === orders[1].email).length, 1, "the second buyer once");
    assert.equal(redis.run(["ZCARD", ASK_DUE_KEY]), 0, "nothing left due: no reminder chosen");
  } finally { redis.pipeline = oldPipeline; globalThis.fetch = oldFetch; }
});
