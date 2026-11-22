/** The new card pays only an invoice of the named customer and membership. Synthetic HTTP and Redis only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishCardUpdate, openKey } from "@/lib/card-update";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const ACCOUNT = "acct_TestCardOwner01";
const CUSTOMER = "cus_CardOwner001";
const SUB = "sub_CardOwner001";
const SESSION = "cs_test_cardOwnerPage000001";
const METHOD = "pm_CardOwner001";
const INVOICE = "in_CardOwner001";
const parent = (subscription: unknown = SUB) => ({ type: "subscription_details", subscription_details: { subscription } });
const base = { id: INVOICE, object: "invoice", status: "open", amount_due: 2900 };
let invoice: unknown;
let pays: { path: string; method: string | null; key: string | null }[] = [];
let sets = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://api.stripe.com", "only the synthetic Stripe routes are allowed");
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === `/checkout/sessions/${SESSION}` && method === "GET") {
    return ok({ id: SESSION, mode: "setup", status: "complete", customer: CUSTOMER, metadata: { kind: "card", store: "cardowner", subscription: SUB }, setup_intent: { status: "succeeded", payment_method: METHOD, metadata: { subscription: SUB } } });
  }
  if (path === `/subscriptions/${SUB}` && method === "GET") {
    return ok({ id: SUB, status: "past_due", customer: CUSTOMER, metadata: { store: "cardowner" }, latest_invoice: invoice });
  }
  if (path === `/subscriptions/${SUB}` && method === "POST") {
    sets += 1;
    return ok({ id: SUB, default_payment_method: METHOD });
  }
  if (path === `/invoices/${INVOICE}/pay` && method === "POST") {
    pays.push({ path, method: new URLSearchParams(String(init?.body)).get("payment_method"), key: new Headers(init?.headers).get("Idempotency-Key") });
    return ok({ id: INVOICE, status: "paid" });
  }
  throw new Error(`unexpected synthetic request: ${method} ${path}`);
}) as typeof fetch;

test("a completed card update never pays a foreign or unbound invoice", async (t) => {
  process.env.STRIPE_SECRET_KEY = "sk_test_card_owner_synthetic_only";
  redis.clear();
  const made = await claimHandle("owner@example.test", "cardowner", "Card Owner", "");
  assert.equal(made.ok, true);
  await setStripeAccount("owner@example.test", ACCOUNT, true);
  const store = await storeForEmail("owner@example.test");
  assert.ok(store);

  const rejected: [string, unknown][] = [
    ["another subscription, same customer, current API", { ...base, customer: CUSTOMER, parent: parent("sub_OtherOwner01") }],
    ["another subscription, same customer, legacy API", { ...base, customer: CUSTOMER, subscription: "sub_OtherOwner01" }],
    ["another customer", { ...base, customer: "cus_OtherOwner01", parent: parent() }],
    ["missing customer", { ...base, parent: parent() }],
    ["null customer", { ...base, customer: null, parent: parent() }],
    ["missing subscription relation", { ...base, customer: CUSTOMER }],
    ["manual invoice parent", { ...base, customer: CUSTOMER, parent: null }],
    ["missing parent discriminator", { ...base, customer: CUSTOMER, parent: { subscription_details: { subscription: SUB } } }],
    ["another parent kind", { ...base, customer: CUSTOMER, parent: { ...parent(), type: "quote_details" } }],
    ["conflicting legacy and current relations", { ...base, customer: CUSTOMER, subscription: "sub_OtherOwner01", parent: parent() }],
    ["current relation contradicts matching legacy", { ...base, customer: CUSTOMER, subscription: SUB, parent: parent("sub_OtherOwner01") }],
    ["expanded customer lacks identity", { ...base, customer: {}, parent: parent() }],
  ];
  for (const [label, row] of rejected) {
    await t.test(label, async () => {
      invoice = row; pays = []; sets = 0;
      await redis.pipeline([["SET", openKey(ACCOUNT, SUB), SESSION, "EX", 3600]]);
      const outcome = await finishCardUpdate(store, SESSION);
      assert.deepEqual(pays, [], "an unreadable or foreign invoice must cause no payment request");
      assert.equal(outcome, "updated", "the confirmed card update is still reported truthfully");
      assert.equal(sets, 1);
    });
  }
  for (const [label, row] of [
    ["current API", { ...base, customer: CUSTOMER, parent: parent() }],
    ["legacy API", { ...base, customer: CUSTOMER, subscription: SUB }],
    ["expanded identities", { ...base, customer: { id: CUSTOMER }, parent: parent({ id: SUB }) }],
    ["consistent legacy and current relations", { ...base, customer: CUSTOMER, subscription: SUB, parent: parent() }],
  ] as const) {
    await t.test(label, async () => {
      invoice = row; pays = []; sets = 0;
      await redis.pipeline([["SET", openKey(ACCOUNT, SUB), SESSION, "EX", 3600]]);
      assert.equal(await finishCardUpdate(store, SESSION), "paid");
      assert.deepEqual(pays, [{ path: `/invoices/${INVOICE}/pay`, method: METHOD, key: `nimbus-card-pay:${INVOICE}:${METHOD}` }]);
      assert.equal(sets, 1);
    });
  }
});
