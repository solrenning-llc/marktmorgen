/** Permanent regression derived from Codex J ad2d3008, plus payment bindings and aggregate diagnostics. */
import assert from "node:assert/strict";
import test from "node:test";
import { settleFee, settleShares } from "@/lib/share-settle";
import { claimHandle, setStripeAccount, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const fee = { id: "fee_JExpanded0001", account: "acct_JExpanded0001", charge: "ch_JExpanded0001", amount: 625, refunded: 0, currency: "usd" };
const intentId = "pi_JExpanded0001";
type Options = { kind?: "intent" | "invoice" | "session"; patch?: Record<string, unknown>; chargePatch?: Record<string, unknown>; storeAccount?: string; diagnostic?: boolean; feeReplyPatch?: Record<string, unknown> };
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
    if (url.pathname === "/v1/application_fees") return Response.json({ object: "list", has_more: false, data: [{ object: "application_fee", ...fee, amount_refunded: fee.refunded, ...options.feeReplyPatch }] });
    if (url.pathname === "/v1/events") return Response.json({ object: "list", has_more: false, data: [] });
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


for(const [label,feeReplyPatch] of [
 ["missing fee kind",{object:undefined}], ["foreign fee kind",{object:"charge"}],
 ["foreign expanded account kind",{account:{object:"customer",id:fee.account}}],
 ["foreign expanded charge kind",{charge:{object:"invoice",id:fee.charge}}],
] as const) test(label+" must not authorize a refund",async()=>{
 const r=await run({diagnostic:true,feeReplyPatch});
 assert.equal(r.posts.length,0);assert.ok(r.counts);assert.equal(r.counts.complete,false);assert.equal(r.counts.listUnknown,1);
});
for(const feeReplyPatch of [{},{account:{object:"account",id:fee.account},charge:{object:"charge",id:fee.charge}}])test("confirmed application fee and references retain known settlement "+JSON.stringify(feeReplyPatch),async()=>{
 const r=await run({diagnostic:true,feeReplyPatch});
 assert.ok(r.counts);assert.deepEqual([r.counts.complete,r.counts.gaveBack,r.counts.cents,r.posts.length],[true,1,125,1]);
});
