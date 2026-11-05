/** Independent #2360 review: real fee settlement/store readers, synthetic provider replies only. */
import assert from "node:assert/strict";
import test from "node:test";
import { settleFee } from "@/lib/share-settle";
import { claimHandle, setStripeAccount, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const fee = { id: "fee_JExpanded0001", account: "acct_JExpanded0001", charge: "ch_JExpanded0001", amount: 625, refunded: 0, currency: "usd" };
const intentId = "pi_JExpanded0001";
type Options = { kind?: "intent" | "invoice" | "session"; patch?: Record<string, unknown> };
async function run(options: Options = {}) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_j_expanded_only_a_stand_in";
  const now = Math.floor(Date.now() / 1000), owner = "j-expanded@example.test";
  assert.equal((await claimHandle(owner, "j-expanded", "Synthetic shop", "")).ok, true);
  assert.equal((await setStripeAccount(owner, fee.account, true)).ok, true);
  const subscribed = await setSubscription(owner, { customerId: "cus_JExpanded0001", subscriptionId: "sub_JExpanded0001", active: true, tier: "creator", cycle: "month", shared: true, trialEnds: now - 30 * 86400, period: paidPeriod() });
  assert.ok(subscribed);
  assert.equal(subscribed.subscriptionActive, true);
  const intent = { object: "payment_intent", id: intentId, metadata: { share_bps: "625", share_base: "8000" }, ...(options.kind === "intent" ? options.patch : {}) };
  const invoice = { object: "invoice", id: "in_JExpanded0001", currency: "usd", created: now - 3600, subtotal: 8000, total_excluding_tax: 8000, subscription_details: { metadata: { store: "j-expanded", share_bps: "625" } }, ...options.patch };
  const session = { object: "checkout.session", id: "cs_test_JExpanded0001", payment_intent: intentId, currency: "usd", amount_total: 8000, total_details: { amount_tax: 0, amount_shipping: 0 }, ...options.patch };
  if (options.kind === "session") delete (intent.metadata as { share_base?: string }).share_base;
  const charge = { object: "charge", id: fee.charge, currency: "usd", amount: 10000, amount_refunded: 0, disputed: false, invoice: options.kind === "invoice" ? invoice : null, payment_intent: intent };
  const previous = globalThis.fetch;
  const calls: { method: string; path: string; amount: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.stripe.com");
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, path: url.pathname, amount: body.get("amount") });
    if (url.pathname === "/v1/charges/" + fee.charge && method === "GET") return Response.json(charge);
    if (url.pathname === "/v1/checkout/sessions" && method === "GET") {
      assert.equal(url.searchParams.get("payment_intent"), intentId);
      return Response.json({ object: "list", data: [session], has_more: false });
    }
    if (url.pathname === "/v1/application_fees/" + fee.id + "/refunds" && method === "POST") return Response.json({ object: "fee_refund", id: "fr_JExpanded0001", fee: fee.id, currency: "usd", amount: Number(body.get("amount")) });
    throw Error("Unexpected synthetic endpoint");
  };
  try {
    let result: number | null = null, rejected = false;
    try { result = await settleFee(fee, now, true); } catch { rejected = true; }
    return { result, rejected, posts: calls.filter(call => call.method === "POST") };
  } finally { globalThis.fetch = previous; }
}

for (const kind of ["intent", "invoice", "session"] as const) test("confirmed " + kind + " evidence retains the exact known refund", async () => {
  const r = await run({ kind });
  assert.equal(r.rejected, false);
  assert.equal(r.result, 125);
  assert.deepEqual(r.posts, [{ method: "POST", path: "/v1/application_fees/" + fee.id + "/refunds", amount: "125" }]);
});

for (const kind of ["intent", "invoice"] as const) for (const [label, patch] of [["missing kind", { object: undefined }], ["foreign kind", { object: "charge" }], ["missing identity", { id: undefined }], ["foreign identity kind", { id: "cus_JExpanded0001" }]] as const) test("unknown " + kind + " resource cannot authorize money: " + label, async () => {
  const r = await run({ kind, patch });
  assert.equal(r.posts.length, 0, "unconfirmed expanded payment resource authorized a fee-refund POST");
  assert.equal(r.rejected, true);
});

for (const [label, patch] of [["missing kind", { object: undefined }], ["foreign kind", { object: "invoice" }], ["missing identity", { id: undefined }], ["foreign payment intent", { payment_intent: "pi_JForeign0001" }], ["missing payment intent", { payment_intent: undefined }]] as const) test("unconfirmed legacy session cannot authorize money: " + label, async () => {
  const r = await run({ kind: "session", patch: { amount_total: 1000, ...patch } });
  assert.equal(r.posts.length, 0, "an unconfirmed or foreign session supplied the financial base for a fee-refund POST");
  assert.equal(r.rejected, true);
});
