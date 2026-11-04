import assert from "node:assert/strict";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setStripeAccount, setSubscription, setTax, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { NO_TAX } from "@/lib/tax";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "classic-checkout@example.test", ACCOUNT = "acct_1TestLoom00001";
const VERSION = "2025-09-30.clover";
type Captured = { headers: Headers; body: URLSearchParams };
async function world(interval: "month" | "year" | null, installment = false, taxDocs = false) {
  redis.clear();
  // Existing exact synthetic fixture credential; no real provider can run.
  process.env.STRIPE_SECRET_KEY = "sk_test_tax_journey_only";
  await claimHandle(OWNER, "classic-checkout", "Classic checkout regression", "");
  await ensureStatsId(OWNER); await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_ClassicOwner0001", subscriptionId: "sub_ClassicOwner0001", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Original membership", "Original description", "30", interval ? { interval, trialDays: 0, payments: 0 } : null);
  assert.ok(added.ok);
  await setProductLink(OWNER, added.product.id, "https://example.test/original-content");
  if (installment) await setProductExtras(OWNER, added.product.id, { plan: { payments: 3, interval: "month", amountCents: 1000 } });
  if (taxDocs) await setTax(OWNER, { ...NO_TAX, ids: true });
  const store = (await storeForEmail(OWNER))!, product = (await readProduct(store, added.product.id))!;
  const captured: Captured[] = [];
  let refuseTaxDocuments = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com", "the mock refuses every other endpoint");
    assert.equal(url.pathname, "/v1/checkout/sessions"); assert.equal(init?.method, "POST");
    const body = new URLSearchParams(String(init.body)), headers = new Headers(init.headers);
    captured.push({ body, headers });
    if (refuseTaxDocuments && body.has("tax_id_collection[enabled]")) {
      return Response.json({ error: { code: "parameter_unknown", message: "Unknown parameter: tax_id_collection" } }, { status: 400 });
    }
    return Response.json({ id: "cs_test_ClassicCheckout00000001", url: "https://checkout.stripe.com/c/pay/synthetic-classic" });
  };
  const open = () => createCheckout(store, product, "https://example.test", undefined, { digitalConsent: TEST_CONSENT, ...(installment ? { plan: true } : {}) });
  return { captured, open, retryTaxDocuments: () => { refuseTaxDocuments = true; } };
}
function subscriptionContract({ headers, body }: Captured, amount: string, interval: string) {
  assert.equal(headers.get("Stripe-Account"), ACCOUNT);
  assert.equal(headers.get("Stripe-Version"), VERSION);
  assert.equal(body.get("mode"), "subscription");
  assert.equal(body.get("subscription_data[billing_mode][type]"), "classic");
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), amount);
  assert.equal(body.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(body.get("line_items[0][price_data][recurring][interval]"), interval);
  assert.equal([...body.keys()].some(key => /application_fee|transfer_data|on_behalf_of/.test(key)), false);
}
for (const interval of ["month", "year"] as const) test(`${interval} membership sends explicit classic mode and pinned Stripe version`, async () => {
  const w = await world(interval); await w.open(); assert.equal(w.captured.length, 1);
  subscriptionContract(w.captured[0], "3000", interval);
});
test("a finite installment subscription has the same explicit billing contract", async () => {
  const w = await world(null, true); await w.open(); assert.equal(w.captured.length, 1);
  subscriptionContract(w.captured[0], "1000", "month");
  assert.equal(w.captured[0].body.get("subscription_data[metadata][plan_payments]"), "3");
});
test("an existing tax-document retry preserves classic mode and the pinned version on every POST", async () => {
  const w = await world("month", false, true); w.retryTaxDocuments(); await w.open(); assert.equal(w.captured.length, 2);
  for (const call of w.captured) subscriptionContract(call, "3000", "month");
  assert.equal(w.captured[0].body.has("tax_id_collection[enabled]"), true);
  assert.equal(w.captured[1].body.has("tax_id_collection[enabled]"), false);
});
test("an ordinary one-off sale keeps its payment contract", async () => {
  const w = await world(null); await w.open(); assert.equal(w.captured.length, 1);
  const { body, headers } = w.captured[0];
  assert.equal(body.get("mode"), "payment"); assert.equal(headers.get("Stripe-Account"), ACCOUNT);
  assert.equal(body.has("subscription_data[billing_mode][type]"), false);
  assert.equal(headers.get("Stripe-Version"), null);
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "3000");
});
