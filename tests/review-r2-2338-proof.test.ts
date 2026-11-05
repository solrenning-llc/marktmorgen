/** Second financial review of #2338 (head 7f0279a5): local proof only.
 * Synthetic store, MemoryRedis, SES mail fixture; no network or real account.
 * Shows that an unknown/refused legacy accounting result does not stop the
 * confirmation email, and that the final "sent" mark then prevents any later
 * accounting, so the paid order stays uncounted for good.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setProductShipping, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { confirmPurchase, confirmationKey } from "@/lib/purchase-email";
import { ADMITTED_FIELD, admitOrders } from "@/lib/order-admission";
import { storeOrdersThisMonth } from "@/lib/orders";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";

process.env.NIMBUS_DATA_KEY = "SYNTHETIC_ONLY_CONFIRMATION_ORIGIN_KEY_2026";
globalThis.fetch = async () => { throw Error("No external service is allowed in this proof"); };

async function shop() {
  redis.clear();
  const owner = "r2-legacy@example.test";
  await claimHandle(owner, "r2-legacy", "R2 store", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_TestR2Legacy01", true);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: "cus_R2", subscriptionId: "sub_R2", active: true, tier: "creator", period: { start: now - 86_400, end: now + 20 * 86_400, renews: true } });
  const p = await addProduct(owner, "Guide", "g", "25", null);
  assert.ok(p.ok);
  await setProductShipping(owner, p.product.id, { cents: 500, region: "us", countries: ["US"], note: "Synthetic" });
  const store = (await storeForEmail(owner))!;
  return { store, product: p.product };
}

test("PROOF A: a lost/failed accounting EVAL still sends, marks sent, and the order is never counted", async () => {
  const { store, product } = await shop();
  const held = await admitOrders(store, 1, Date.now(), 1);
  assert.ok(held.ok);
  const folder = await storeFolder(storeRef(store));
  const session = { id: "cs_test_R2LostAccounting00001", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000), amount_total: 2500, currency: "usd",
    metadata: { store: store.handle, product: product.id, [ADMITTED_FIELD]: String(held.hour) },
    customer_details: { email: "r2-buyer@example.test" } };
  const original = redis.pipeline;
  let failed = 0;
  // Only the settlement EVAL fails (transient Redis error / unknown reply), before any effect.
  redis.pipeline = async (commands) => {
    if (commands.some(c => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:order-confirmation-settlement:v1"))) {
      failed += 1;
      throw Error("Synthetic Redis failure on the accounting EVAL");
    }
    return original(commands);
  };
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true);
    const first = await confirmPurchase(store, session.id, session as never);
    redis.pipeline = original; // Redis is healthy again.
    const second = await confirmPurchase(store, session.id, session as never);
    const seen = { first, second, failed, sesPosts: mail.calls.ses, mark: redis.run(["GET", confirmationKey(session.id)]),
      orders: await storeOrdersThisMonth(store), open: redis.run(["HGET", `nl:orders:open:${folder}`, String(held.hour)]) };
    console.log(`PROOF_A ${JSON.stringify(seen)}`);
    assert.equal(seen.first, "sent", "the email went although accounting was unknown");
    assert.equal(seen.second, "already", "the sent mark short-circuits before accounting");
    // The assertion the PR title implies; it FAILS on 7f0279a5:
    assert.equal(seen.orders, 1, "a paid legacy order must be counted (or the mail held) when accounting is unknown");
  } finally { redis.pipeline = original; mail.restore(); }
});

test("PROOF B: a settled checkout read without amount_total is mailed and never counted", async () => {
  const { store, product } = await shop();
  const held = await admitOrders(store, 1, Date.now(), 1);
  assert.ok(held.ok);
  const session = { id: "cs_test_R2NoAmount0000000001", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000), currency: "usd",
    metadata: { store: store.handle, product: product.id, [ADMITTED_FIELD]: String(held.hour) },
    customer_details: { email: "r2-buyer3@example.test" } };
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true);
    const first = await confirmPurchase(store, session.id, session as never);
    const second = await confirmPurchase(store, session.id, session as never);
    const seen = { first, second, orders: await storeOrdersThisMonth(store) };
    console.log(`PROOF_B ${JSON.stringify(seen)}`);
    assert.equal(seen.first, "sent");
    assert.equal(seen.orders, 1, "an unknown amount must not leave a mailed paid order uncounted");
  } finally { mail.restore(); }
});
