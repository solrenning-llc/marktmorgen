import { test } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "@/lib/store";
import { readDisputePurchaseReview } from "@/lib/dispute-purchase-review";
import { state, reset } from "./dispute-review-world";

const store = { handle: "sample", stripeAccountId: "acct_fixture", tier: "creator", statsId: "statsfixture" } as unknown as Store;
function fixture(sessionId = "cs_fixture") {
  const charge = { object: "charge", id: "ch_fixture", paid: true, captured: true, amount: 1000, amount_captured: 1000, created: 200, currency: "usd", payment_intent: "pi_fixture", livemode: false };
  const session = { object: "checkout.session", id: sessionId, mode: "payment", status: "complete", payment_status: "paid", amount_total: 1000, created: 100, currency: "usd", livemode: false,
    metadata: { store: "old-handle", product: "a".repeat(32), title: "Provider-recorded synthetic title" },
    customer_details: { email: "buyer@example.test" },
    payment_intent: { object: "payment_intent", id: "pi_fixture", status: "succeeded", livemode: false, latest_charge: charge } };
  const dispute = { object: "dispute", id: "du_fixture", charge: "ch_fixture", payment_intent: "pi_fixture", amount: 500, currency: "usd", livemode: false, reason: "fraudulent",
    evidence_details: { due_by: 2000, past_due: false, submission_count: 0 } };
  return { dispute, listed: { object: "list", has_more: false, data: [session] } };
}
test("funding and each service allowance precede the two exact-account GETs", async () => {
  reset(); const f = fixture(); state.replies.push(f.dispute, f.listed);
  const result = await readDisputePurchaseReview(store, "du_fixture");
  assert.equal(result.ok, true);
  assert.deepEqual(state.events, ["fund", "allow:integration", "read", "allow:integration", "read"]);
  assert.ok(state.calls.every(call => call.method === "GET" && call.account === "acct_fixture" && call.timeout === 5000));
  const query = new URL("https://example.test" + state.calls[1].path).searchParams;
  assert.equal(query.get("payment_intent"), "pi_fixture");
  assert.equal(query.get("limit"), "2");
  assert.equal(query.get("expand[]"), "data.payment_intent.latest_charge");
  if (result.ok) { assert.equal(result.responseDeadline, 2000); assert.equal(result.submitted, false); assert.match(result.history, /have not been loaded/); }
});
test("missing funding or first allowance prevents every provider request", async () => {
  reset(); state.funded = false;
  assert.deepEqual(await readDisputePurchaseReview(store, "du_fixture"), { ok: false, reason: "funding" });
  assert.equal(state.calls.length, 0);
  reset(); state.allowances = [false];
  assert.deepEqual(await readDisputePurchaseReview(store, "du_fixture"), { ok: false, reason: "allowance" });
  assert.equal(state.calls.length, 0);
});
test("second allowance exhaustion stops before the second call", async () => {
  reset(); state.allowances = [true, false]; state.replies.push(fixture().dispute);
  assert.deepEqual(await readDisputePurchaseReview(store, "du_fixture"), { ok: false, reason: "allowance" });
  assert.equal(state.calls.length, 1);
});
test("invalid identifiers, different dispute and missing intent cannot scan purchases", async () => {
  reset(); assert.deepEqual(await readDisputePurchaseReview(store, "../other"), { ok: false, reason: "invalid" }); assert.deepEqual(state.events, []);
  for (const patch of [{ id: "du_other" }, { payment_intent: null }]) {
    reset(); state.replies.push({ ...fixture().dispute, ...patch });
    assert.equal((await readDisputePurchaseReview(store, "du_fixture")).ok, false);
    assert.equal(state.calls.length, 1);
  }
});
test("ambiguous lists, pagination, mixed mode and another charge fail closed", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.listed.data.push(f.listed.data[0]); },
    (f: ReturnType<typeof fixture>) => { f.listed.has_more = true; },
    (f: ReturnType<typeof fixture>) => { f.listed.data[0].livemode = true; },
    (f: ReturnType<typeof fixture>) => { f.dispute.charge = "ch_other"; },
  ]) {
    reset(); const f = fixture(); mutate(f); state.replies.push(f.dispute, f.listed);
    assert.deepEqual(await readDisputePurchaseReview(store, "du_fixture"), { ok: false, reason: "unavailable" });
    assert.equal(state.calls.length, 2);
  }
});
test("provider failure is private and does not consume an unused second call", async () => {
  reset(); state.replies.push(new Error("Synthetic private buyer detail"));
  assert.deepEqual(await readDisputePurchaseReview(store, "du_fixture"), { ok: false, reason: "unavailable" });
  assert.equal(state.calls.length, 1);
  assert.equal(state.events.filter(event => event === "allow:integration").length, 1);
});
test("unknown deadline and history remain unknown without inventing submission permission", async () => {
  reset(); const f = fixture(); Object.assign(f.dispute.evidence_details, { due_by: null, past_due: null, submission_count: null }); state.replies.push(f.dispute, f.listed);
  const result = await readDisputePurchaseReview(store, "du_fixture");
  assert.ok(result.ok);
  assert.equal(result.responseDeadline, null); assert.equal(result.pastDue, null); assert.equal(result.submissionCount, null); assert.equal(result.submitted, false);
});

// #4713: Stripe issues Checkout Session IDs as cs_test_... and cs_live_...; the review reads them like any other.
for (const id of ["cs_fixture", "cs_test_SyntheticFixture123", "cs_live_SyntheticFixture123"]) {
  test("dispute purchase review with checkout session id " + id, async () => {
    reset(); const f = fixture(id); state.replies.push(f.dispute, f.listed);
    const result = await readDisputePurchaseReview(store, "du_fixture");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.binding.purchase, id);
  });
}
