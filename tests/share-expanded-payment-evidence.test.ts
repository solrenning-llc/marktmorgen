/** Permanent regression derived from Codex J ad2d3008, plus payment bindings and aggregate diagnostics. */
import assert from "node:assert/strict";
import test from "node:test";
import { settleFee, settleShares } from "@/lib/share-settle";
import { claimHandle, setStripeAccount, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const fee = { id: "fee_JExpanded0001", account: "acct_JExpanded0001", charge: "ch_JExpanded0001", amount: 625, refunded: 0, currency: "usd" };
const intentId = "pi_JExpanded0001";
type Options = { kind?: "intent" | "invoice" | "session"; patch?: Record<string, unknown>; chargePatch?: Record<string, unknown>; storeAccount?: string; diagnostic?: boolean; feeReplyPatch?: Record<string, unknown>; historical?: boolean };
async function run(options: Options = {}) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_j_expanded_only_a_stand_in";
  const now = Math.floor(Date.now() / 1000), owner = "j-expanded@example.test";
  assert.equal((await claimHandle(owner, "j-expanded", "Synthetic shop", "")).ok, true);
  assert.equal((await setStripeAccount(owner, options.storeAccount ?? fee.account, true)).ok, true);
  const subscribed = await setSubscription(owner, { customerId: "cus_JExpanded0001", subscriptionId: "sub_JExpanded0001", active: true, tier: "creator", cycle: "month", shared: true, trialEnds: now - 30 * 86400, period: paidPeriod() });
  assert.ok(subscribed);
  assert.equal(subscribed.subscriptionActive, true);
  const intent = { object: "payment_intent", id: intentId, currency: "usd", amount: 10000, amount_received: 10000, status: "succeeded", latest_charge: fee.charge, metadata: { share_bps: "625", share_base: "8000" }, ...(options.kind === "intent" ? options.patch : {}) };
  const invoice = { object: "invoice", id: "in_JExpanded0001", charge: fee.charge, payment_intent: intentId, total: 10000, amount_paid: 10000, paid: true, status: "paid", currency: "usd", created: now - 3600, subtotal: 8000, total_excluding_tax: 8000, subscription_details: { metadata: { store: "j-expanded", share_bps: "625" } }, ...options.patch };
  const session = { object: "checkout.session", id: "cs_test_JExpanded0001", payment_intent: intentId, currency: "usd", amount_total: 10000, total_details: { amount_tax: 2000, amount_shipping: 0 }, ...options.patch };
  if (options.kind === "session") delete (intent.metadata as { share_base?: string }).share_base;
  const charge = { object: "charge", id: fee.charge, currency: "usd", amount: 10000, amount_refunded: 0, disputed: false, invoice: options.kind === "invoice" ? invoice : null, payment_intent: intent, ...options.chargePatch };
  const previous = globalThis.fetch;
  const calls: { method: string; path: string; amount: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.stripe.com");
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, path: url.pathname, amount: body.get("amount") });
    const feeReply = { object: "application_fee", ...fee, amount_refunded: fee.refunded, ...options.feeReplyPatch };
    if (url.pathname === "/v1/application_fees") return Response.json({ object: "list", has_more: false, data: options.historical ? [] : [feeReply] });
    if (url.pathname === "/v1/application_fees/" + fee.id && method === "GET") return Response.json(feeReply);
    if (url.pathname === "/v1/events") return Response.json({ object: "list", has_more: false, data: options.historical ? [{ id: "evt_JExpanded0001", data: { object: { application_fee: fee.id } } }] : [] });
    if (url.pathname === "/v1/subscriptions/search") return Response.json({ object: "search_result", has_more: false, data: [] });
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
    const counts = options.diagnostic ? await settleShares(Date.now() + 60000, now, true) : null;
    if (!options.diagnostic) try { result = await settleFee(fee, now, true); } catch { rejected = true; }
    return { result, rejected, counts, posts: calls.filter(call => call.method === "POST") };
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
  const r = await run({ kind: "session", patch: { amount_total: 1000, total_details: { amount_tax: 0, amount_shipping: 0 }, ...patch } });
  assert.equal(r.posts.length, 0, "an unconfirmed or foreign session supplied the financial base for a fee-refund POST");
  assert.equal(r.rejected, true);
});

for (const [label, chargePatch] of [
 ["missing invoice evidence", { invoice: undefined }], ["invoice id without expansion", { invoice: "in_JExpanded0001" }],
 ["invalid invoice evidence", { invoice: false }], ["array invoice", { invoice: [] }],
 ["missing payment intent evidence", { payment_intent: undefined }], ["intent id without expansion", { payment_intent: intentId }],
 ["array payment intent", { payment_intent: [] }],
] as const) test("unknown expanded field is not confirmed absence: " + label, async () => {
 const r = await run({ chargePatch: { metadata: { share_bps: "625", share_base: "8000" }, ...chargePatch } });
 assert.equal(r.posts.length, 0); assert.equal(r.rejected, true);
});
for (const [label, patch] of [
 ["missing invoice charge", { charge: undefined }], ["null invoice charge", { charge: null }],
 ["foreign invoice charge", { charge: "ch_JForeign0001" }],
 ["wrong expanded invoice charge kind", { charge: { object: "customer", id: fee.charge } }],
] as const) test("invoice binds its payment to this fee: " + label, async () => {
 const r = await run({ kind: "invoice", patch }); assert.equal(r.posts.length, 0); assert.equal(r.rejected, true);
});
test("invoice store belongs to the fee's connected account", async () => {
 const r = await run({ kind: "invoice", storeAccount: "acct_JForeign0001" });
 assert.equal(r.posts.length, 0); assert.equal(r.rejected, true);
});
for (const [label, patch] of [
 ["missing latest charge", { latest_charge: undefined }], ["foreign latest charge", { latest_charge: "ch_JForeign0001" }],
 ["foreign expanded charge kind", { latest_charge: { object: "invoice", id: fee.charge } }],
 ["missing intent currency", { currency: undefined }], ["foreign intent currency", { currency: "eur" }],
 ["missing intent amount", { amount: undefined }], ["different intent amount", { amount: 1000 }],
] as const) test("intent binds its money to this charge: " + label, async () => {
 const r = await run({ kind: "intent", patch }); assert.equal(r.posts.length, 0); assert.equal(r.rejected, true);
});
for (const [label, patch] of [
 ["foreign identity kind", { id: "pi_JExpanded0001" }],
 ["foreign intent with coherent total", { payment_intent: "pi_JForeign0001" }],
 ["foreign expanded intent with coherent total", { payment_intent: { object: "payment_intent", id: "pi_JForeign0001" } }],
 ["unconfirmed expanded intent", { payment_intent: { id: intentId } }],
 ["foreign expanded intent kind", { payment_intent: { object: "invoice", id: intentId } }],
 ["different paid total", { amount_total: 1000, total_details: { amount_tax: 0, amount_shipping: 0 } }],
] as const) test("session binds its base to the queried payment: " + label, async () => {
 const r = await run({ kind: "session", patch }); assert.equal(r.posts.length, 0); assert.equal(r.rejected, true);
});
for (const options of [
 { kind: "intent", patch: { latest_charge: { object: "charge", id: fee.charge } } },
 { kind: "invoice", patch: { charge: { object: "charge", id: fee.charge } } },
 { kind: "session", patch: { payment_intent: { object: "payment_intent", id: intentId } } },
 { chargePatch: { invoice: null, payment_intent: null, metadata: { share_bps: "625", share_base: "8000" } } },
] satisfies Options[]) test("confirmed reference or explicit legacy absence retains its exact refund: " + JSON.stringify(options), async () => {
 const r = await run(options); assert.equal(r.rejected, false); assert.equal(r.result, 125); assert.equal(r.posts.length, 1);
});
for (const kind of ["intent", "invoice", "session"] as const) test("unknown " + kind + " appears in the owner's aggregate without a refund", async () => {
 const r = await run({ kind, patch: { object: "unknown" }, diagnostic: true });
 assert.ok(r.counts); assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1);
 assert.equal(r.counts.unknownAmounts, 1); assert.deepEqual(r.counts.unknownAmountFees, [fee.id]);
 assert.equal(r.posts.length, 0); assert.equal(r.counts.gaveBack, 0); assert.equal(r.counts.cents, 0);
});

// I2 self-audit: the application fee itself must confirm its resource identities.
for (const historical of [false, true]) for (const [label, feeReplyPatch] of [
 ["missing fee kind", { object: undefined }], ["foreign fee kind", { object: "charge" }],
 ["missing expanded account kind", { account: { id: fee.account } }],
 ["foreign expanded account kind", { account: { object: "customer", id: fee.account } }],
 ["missing expanded charge kind", { charge: { id: fee.charge } }],
 ["foreign expanded charge kind", { charge: { object: "invoice", id: fee.charge } }],
 ["null account", { account: null }], ["array account", { account: [] }],
 ["null charge", { charge: null }], ["array charge", { charge: [] }],
 ["foreign account id kind", { account: { object: "account", id: fee.charge } }],
 ["foreign charge id kind", { charge: { object: "charge", id: fee.account } }],
] as const) test("unconfirmed " + (historical ? "historical" : "recent") + " application fee resource cannot authorize money: " + label, async () => {
 const r = await run({ diagnostic: true, feeReplyPatch, historical });
 assert.equal(r.posts.length, 0);
 assert.ok(r.counts); assert.equal(r.counts.complete, false); assert.equal(r.counts.listUnknown, historical ? 0 : 1);
 if (historical) { assert.equal(r.counts.unknownAmounts, 1); assert.deepEqual(r.counts.unknownAmountFees, [fee.id]); }
 assert.equal(r.counts.gaveBack, 0); assert.equal(r.counts.cents, 0);
});
for (const historical of [false, true]) for (const feeReplyPatch of [
 {}, { account: { object: "account", id: fee.account }, charge: { object: "charge", id: fee.charge } },
]) test("confirmed " + (historical ? "historical" : "recent") + " application fee retains the exact known refund: " + JSON.stringify(feeReplyPatch), async () => {
 const r = await run({ diagnostic: true, feeReplyPatch, historical });
 assert.ok(r.counts);
 assert.deepEqual([r.counts.complete, r.counts.gaveBack, r.counts.cents, r.posts.length], [true, 1, 125, 1]);
});
