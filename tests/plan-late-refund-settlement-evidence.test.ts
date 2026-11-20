/** A fully-refunded charge does not prove its refunds succeeded. Synthetic Stripe only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rememberPlan, settlePlans } from "@/lib/plans";
import { store as redis, redisPipeline } from "./redis-stub";
import { refundLatePayments, LATE_REFUND_CALLS } from "@/lib/plan-late-refunds";

process.env.STRIPE_SECRET_KEY = "sk_test_settlement_evidence_only";
const DAY = 86400, NOW = Math.floor(Date.now() / 1000), session = "cs_test_settlement001";
const invoice = "in_settlement001", intent = "pi_settlement001", subscription = "sub_settlement001";
type Row = Record<string, unknown>;
const refund = (id: string, amount: number, status = "succeeded", currency = "usd"): Row => ({ id, object: "refund", payment_intent: intent, amount, currency, status });
let rows: Row[] = [];
let expanded = true;
let calls = 0;
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
 const url = new URL(String(input));
 if (url.hostname !== "api.stripe.com") throw Error("unexpected synthetic host");
 calls++;
 if (init?.method === "POST") { posts++; throw Error("settlement evidence never authorizes another refund"); }
 const path = url.pathname.replace(/^\/v1/, "");
 if (path === `/checkout/sessions/${session}`) return Response.json({ id: session, status: "complete", subscription,
   metadata: { kind: "plan", plan_payments: "2", plan_interval: "month" } });
 if (path === `/subscriptions/${subscription}`) return Response.json({ id: subscription, status: "canceled",
   billing_cycle_anchor: NOW - 120 * DAY, trial_end: null, ended_at: NOW - DAY });
 const refunds = { object: "list", data: rows, has_more: false };
 if (path === "/invoices") return Response.json({ object: "list", has_more: false, data: [{
   id: invoice, object: "invoice", subscription, status: "paid", created: NOW - DAY, amount_paid: 5000,
   paid_out_of_band: false, currency: "usd", customer_email: "buyer@example.com",
   charge: { id: "ch_settlement001", object: "charge", payment_intent: intent, invoice,
     amount: 5000, amount_refunded: 5000, disputed: false, currency: "usd",
     balance_transaction: { amount: 5000, currency: "usd" }, ...(expanded ? { refunds } : {}) },
 }] });
 if (path === "/refunds") return Response.json(refunds);
 throw Error("unexpected synthetic path");
}) as typeof fetch;
const run = async () => {
 calls = 0;
 const answer = await refundLatePayments("acct_settlement001", subscription, 100);
 assert.ok(calls <= LATE_REFUND_CALLS);
 return answer;
};
for (const readExpanded of [true, false]) {
 for (const [name, evidence] of [
   ["empty", []],
   ["only failed", [refund("re_settlement001", 5000, "failed")]],
   ["short total", [refund("re_settlement001", 1000)]],
   ["duplicate identity", [refund("re_settlement001", 2500), refund("re_settlement001", 2500)]],
   ["another currency", [refund("re_settlement001", 5000, "succeeded", "eur")]],
 ] as [string, Row[]][]) {
   test(`full charge but ${name} refund evidence (expanded=${readExpanded}) stays undecided`, async () => {
     expanded = readExpanded; rows = evidence; posts = 0;
     await assert.rejects(run, /could not be read whole/);
     assert.equal(posts, 0);
     rows = [refund("re_settlement001", 2500), refund("re_settlement002", 2500)];
     const recovered = await run();
     assert.deepEqual([recovered.state, recovered.given.map(x => x.amount), posts], ["done", [5000], 0]);
   });
 }
 test(`confirmed split refunds settle once (expanded=${readExpanded})`, async () => {
   expanded = readExpanded; posts = 0;
   rows = [refund("re_settlement001", 2500), refund("re_settlement002", 2500)];
   const answer = await run();
   assert.deepEqual([answer.state, answer.given.map(x => x.amount), posts], ["done", [5000], 0]);
 });
 test(`a confirmed pending refund stays owed (expanded=${readExpanded})`, async () => {
   expanded = readExpanded; posts = 0; rows = [refund("re_settlement001", 5000, "pending")];
   const answer = await run();
   assert.deepEqual([answer.state, answer.given, posts], ["owed", [], 0]);
 });
}


test("the daily job retains the plan until full refund settlement is proven", async () => {
 redis.clear(); expanded = true; rows = [refund("re_settlement001", 5000, "failed")]; posts = 0;
 await rememberPlan("acct_settlement001", session);
 const inLine = async () => {
   const replies = await redisPipeline([["SMEMBERS", "nl:plans:pending"], ["ZRANGEBYSCORE", "nl:plans:retry", "-inf", "+inf"]]);
   return replies.some(row => Array.isArray(row) && row.some(x => String(x).includes(session)));
 };
 const first = await settlePlans();
 assert.deepEqual([first.done, first.failed, await inLine(), posts], [0, 1, true, 0]);
 rows = [refund("re_settlement001", 5000)];
 const realNow = Date.now;
 Date.now = () => realNow() + 2 * DAY * 1000;
 try {
   const recovered = await settlePlans();
   assert.deepEqual([recovered.done, await inLine(), posts], [1, false, 0]);
 } finally { Date.now = realNow; }
});
