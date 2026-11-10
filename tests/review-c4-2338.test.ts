/** Claude 4 review of #2338 (head 0e5c6f72): RED reproductions only.
 * Synthetic store, MemoryRedis and the SES mail fixture; no network, no
 * provider, no real account. Each case passes against main 126f6e0c's
 * lib/purchase-email.ts, lib/email.ts and lib/ses.ts.
 *  MEDIUM 1: a paid bundle order is delivered and never counted.
 *  MEDIUM 2: a paid pre-order is never counted.
 *  MEDIUM 3: an SES batch refused by the store's figure returns "sent".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductBundle, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { confirmPurchase } from "@/lib/purchase-email";
import { ADMITTED_FIELD, admitOrders } from "@/lib/order-admission";
import { storeOrdersThisMonth } from "@/lib/orders";
import { itemsHandedOver, orderDataBytes } from "@/lib/store-data-rules";
import { sendBatch } from "@/lib/email";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";

process.env.NIMBUS_DATA_KEY = "SYNTHETIC_ONLY_CONFIRMATION_ORIGIN_KEY_2026";
process.env.RESEND_API_KEY = "re_SYNTHETIC_C4_REVIEW_ONLY";
globalThis.fetch = async () => { throw Error("No external service is allowed in this proof"); };

async function shop() {
  redis.clear();
  const owner = "c4-legacy@example.test";
  await claimHandle(owner, "c4-legacy", "C4 store", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_TestC4Legacy01", true);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: "cus_C4", subscriptionId: "sub_C4", active: true, tier: "creator", period: { start: now - 86_400, end: now + 20 * 86_400, renews: true } });
  return owner;
}

test("MEDIUM 1: a paid bundle checkout admitted alone in its hour is counted once", async () => {
  const owner = await shop();
  const a = await addProduct(owner, "Part A", "a", "10", null), b = await addProduct(owner, "Part B", "b", "10", null), set = await addProduct(owner, "The set", "s", "15", null);
  assert.ok(a.ok && b.ok && set.ok);
  for (const x of [a, b]) assert.ok((await setProductLink(owner, x.product.id, `https://example.test/${x.product.id}`)).ok);
  assert.ok((await setProductBundle(owner, set.product.id, [a.product.id, b.product.id])).ok);
  const store = (await storeForEmail(owner))!, bundle = (await readProduct(store, set.product.id))!;
  // What ADMIT_ORDERS (lib/order-admission.ts:92-93) writes for a paid store:
  // store-checkout.ts holds itemsHandedOver([bundle]) items for this checkout.
  const folder = await storeFolder(storeRef(store)), hour = Math.floor(Date.now() / 3_600_000);
  redis.run(["HINCRBY", `nl:orders:open:${folder}`, String(hour), 1]);
  redis.run(["HINCRBY", `nl:orders:open:${folder}:b`, String(hour), orderDataBytes(itemsHandedOver([bundle]))]);
  const session = { id: "cs_test_C4BundleAlone0000001", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000), amount_total: 1500, currency: "usd",
    metadata: { store: store.handle, product: bundle.id, bundle: `${a.product.id},${b.product.id}`, [ADMITTED_FIELD]: String(hour) },
    customer_details: { email: "c4-bundle-buyer@example.test" } };
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true);
    const outcome = await confirmPurchase(store, session.id, session as never);
    const seen = { outcome, orders: await storeOrdersThisMonth(store),
      open: redis.run(["HGET", `nl:orders:open:${folder}`, String(hour)]), kept: redis.run(["HGET", `nl:orders:open:${folder}:b`, String(hour)]) };
    console.log(`MEDIUM1 ${JSON.stringify(seen)}`);
    assert.equal(seen.orders, 1, "the paid bundle order is counted");
  } finally { mail.restore(); }
});

test("MEDIUM 2: a paid pre-order checkout is counted once", async () => {
  const owner = await shop();
  const p = await addProduct(owner, "Soon book", "s", "25", null);
  assert.ok(p.ok);
  const store = (await storeForEmail(owner))!;
  const held = await admitOrders(store, 1, Date.now(), 1);
  assert.ok(held.ok);
  const session = { id: "cs_test_C4Preorder00000001", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 60, amount_total: 2500, currency: "usd", payment_intent: "pi_C4Preorder000001",
    metadata: { store: store.handle, product: p.product.id, preorder: "yes", [ADMITTED_FIELD]: String(held.hour) },
    customer_details: { email: "c4-preorder-buyer@example.test" } };
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true);
    const outcome = await confirmPurchase(store, session.id, session as never);
    const seen = { outcome, orders: await storeOrdersThisMonth(store) };
    console.log(`MEDIUM2 ${JSON.stringify(seen)}`);
    assert.equal(seen.orders, 1, "the paid pre-order is counted");
  } finally { mail.restore(); }
});

test("MEDIUM 3: an SES batch whose store figure is already used is refused, never \"sent\"", async () => {
  const shopRecord = { sid: "a".repeat(32), handle: "c4-proof", statsId: null, tier: "creator" as const, subscriptionActive: true, subscriptionId: null,
    trialEnds: 0, planEndedAt: "", cycle: "month" as const, period: paidPeriod() };
  const message = { from: "Shop <shop@example.test>", to: "buyer@example.test", subject: "Launch", text: "Body", html: "<p>Body</p>" };
  const mail = installSesMailFixture();
  try {
    redis.clear();
    mail.configure(); await mail.setReady(true);
    assert.equal((await takeAllowance(shopRecord, "email", allowanceFor(shopRecord, "email"))).ok, true, "fill the store's figure");
    const before = await allowanceUsed(shopRecord, "email"), sesBefore = mail.calls.ses;
    const outcome = await sendBatch([message, { ...message, to: "other@example.test" }], "C4_EXHAUSTED_BATCH", { by: "store", store: shopRecord, kind: "email" });
    const seen = { outcome, sesPosts: mail.calls.ses - sesBefore, resendPosts: mail.calls.resend, spent: (await allowanceUsed(shopRecord, "email")) - before };
    console.log(`MEDIUM3 ${JSON.stringify(seen)}`);
    assert.equal(seen.sesPosts, 0, "no SES POST");
    assert.equal(outcome, "refused", "nothing was sent: callers (waitlist, community events) must not record it as sent");
  } finally { mail.restore(); }
});
