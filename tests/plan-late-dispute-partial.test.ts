/** A lost dispute returns its own amount, never proof that a whole late payment was returned. Synthetic only. */
import assert from "node:assert/strict";
import test from "node:test";
import { refundLatePayments, LATE_REFUND_CALLS } from "@/lib/plan-late-refunds";

process.env.STRIPE_SECRET_KEY = "sk_test_x5_late_partial_dispute";
const invoice = "in_x5lostpartial01";
const charge = "ch_x5lostpartial01";
const intent = "pi_x5lostpartial01";
const subscription = "sub_x5lostpartial01";
let dispute: Record<string, unknown>;
let another = false;
let calls = 0;
const posts: string[] = [];
const fullDispute = (): Record<string, unknown> => ({ id: "du_x5lostpartial01", object: "dispute", charge, status: "lost", amount: 5_000, currency: "usd" });
const paid = (other = false) => ({
  object: "invoice", id: other ? "in_x5unaffected01" : invoice, subscription, status: "paid", created: 200,
  currency: "usd", amount_paid: 5_000, paid_out_of_band: false,
  charge: { object: "charge", id: other ? "ch_x5unaffected01" : charge, invoice: other ? "in_x5unaffected01" : invoice,
    payment_intent: other ? "pi_x5unaffected01" : intent, amount: 5_000, amount_refunded: 0, currency: "usd",
    disputed: !other, dispute: other ? null : dispute, balance_transaction: { amount: 5_000, currency: "usd" } },
});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "api.stripe.com");
  calls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoices") return Response.json({ object: "list", data: another ? [paid(), paid(true)] : [paid()], has_more: false });
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === "/refunds" && init?.method !== "POST") return Response.json({ object: "list", data: [], has_more: false });
  if (path === "/refunds") {
    const body = new URLSearchParams(String(init?.body));
    const payment = body.get("payment_intent") ?? "";
    posts.push(payment);
    assert.equal(payment, "pi_x5unaffected01", "a disputed charge is never refunded by guessing its remainder");
    return Response.json({ object: "refund", id: "re_x5unaffected01", payment_intent: payment, amount: 5_000, currency: "usd", status: "succeeded", metadata: {} });
  }
  throw new Error("unexpected synthetic route");
}) as typeof fetch;
function seed(): void { dispute = fullDispute(); another = false; calls = 0; posts.length = 0; }
async function run() {
  const out = await refundLatePayments("acct_x5synthetic", subscription, 100);
  assert.ok(calls <= LATE_REFUND_CALLS);
  return out;
}
test("a lost partial dispute stays owed and names the invoice the creator must reconcile", async () => {
  seed(); dispute.amount = 1_000;
  const out = await run();
  assert.deepEqual([out.state, out.disputed, out.given, out.short, posts], ["owed", 0, [], [invoice], []]);
});
test("the disputed remainder never blocks refunding a different late payment", async () => {
  seed(); dispute.amount = 1_000; another = true;
  const out = await run();
  assert.deepEqual([out.state, out.disputed, out.short, out.refunded, out.given.map(row => row.invoice), posts],
    ["owed", 0, [invoice], 1, ["in_x5unaffected01"], ["pi_x5unaffected01"]]);
});
for (const amount of [5_000, 5_100]) test(`a readable lost dispute covering ${amount} settles without a refund`, async () => {
  seed(); dispute.amount = amount;
  const out = await run();
  assert.deepEqual([out.state, out.disputed, out.short, posts], ["done", 1, [], []]);
});
const unreadable: [string, (row: Record<string, unknown>) => void][] = [
  ["missing amount", row => { delete row.amount; }],
  ["text amount", row => { row.amount = "5000"; }],
  ["zero amount", row => { row.amount = 0; }],
  ["negative amount", row => { row.amount = -5_000; }],
  ["fractional amount", row => { row.amount = 4_999.5; }],
  ["unsafe amount", row => { row.amount = Number.MAX_SAFE_INTEGER + 1; }],
  ["other currency", row => { row.currency = "eur"; }],
  ["missing currency", row => { delete row.currency; }],
  ["other charge", row => { row.charge = "ch_x5anothercharge"; }],
  ["missing charge", row => { delete row.charge; }],
];
for (const [label, change] of unreadable) test(`a lost dispute with ${label} never proves money returned`, async () => {
  seed(); change(dispute);
  await assert.rejects(run);
  assert.deepEqual(posts, []);
});
