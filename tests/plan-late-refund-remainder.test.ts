/** A successful partial late refund is not proof that the whole payment was given back. Synthetic provider only. */
import assert from "node:assert/strict";
import test from "node:test";
import { refundLatePayments, LATE_MARK, LATE_REFUND_CALLS } from "@/lib/plan-late-refunds";

process.env.STRIPE_SECRET_KEY = "sk_test_v_late_remainder_synthetic";
const invoice = "in_vremainder01", intent = "pi_vremainder01", subscription = "sub_vremainder01";
type Row = { id: string; object: string; payment_intent: string; amount: number; currency: string; status: string; metadata: Record<string, string> };
const row = (id: string, amount: number, status: string, ours = true): Row => ({ id, object: "refund", payment_intent: intent, amount, currency: "usd", status, metadata: ours ? { [LATE_MARK]: invoice } : {} });
let rows: Row[] = [], chargeRefunded = 0, answerStatus = "succeeded", calls = 0;
const posts: { key: string | null; amount: number }[] = [];
const keyed = new Map<string, Row>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected synthetic host");
  calls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoices") return Response.json({ object: "list", data: [{ object: "invoice", id: invoice, subscription, status: "paid", created: 200, currency: "usd", amount_paid: 5000, paid_out_of_band: false, charge: { object: "charge", id: "ch_vremainder01", invoice, payment_intent: intent, amount: 5000, amount_refunded: chargeRefunded, currency: "usd", disputed: false, balance_transaction: { amount: 5000, currency: "usd" }, refunds: { object: "list", data: rows, has_more: false } } }], has_more: false });
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100000, currency: "usd" }] });
  if (path === "/refunds" && init?.method === "POST") {
    const amount = Number(new URLSearchParams(String(init.body)).get("amount"));
    const key = new Headers(init.headers).get("idempotency-key");
    posts.push({ key, amount });
    const prior = key && keyed.get(key);
    if (prior) return Response.json(prior);
    const made = row(`re_vremainder${posts.length}`, amount, answerStatus);
    rows.unshift(made);
    chargeRefunded += amount;
    if (key) keyed.set(key, { ...made });
    return Response.json(made);
  }
  if (path === "/refunds") return Response.json({ object: "list", data: rows, has_more: false });
  throw new Error("Unexpected synthetic route");
}) as typeof fetch;
const run = async () => { calls = 0; const out = await refundLatePayments("acct_vsynthetic", subscription, 100); assert.ok(calls <= LATE_REFUND_CALLS); return out; };
function seed(): void {
  // An unrelated 1500 refund once pending has failed; the old routine had refunded the other 3500.
  rows = [row("re_voldpartial", 3500, "succeeded"), row("re_votherfailed", 1500, "failed", false)];
  chargeRefunded = 3500; answerStatus = "succeeded"; posts.length = 0; keyed.clear();
}

test("a prior partial refund leaves the remaining amount to return, once", async () => {
  seed();
  const first = await run();
  assert.deepEqual(posts.map(p => p.amount), [1500]);
  assert.equal(first.state, "done");
  assert.equal(first.given[0]?.amount, 5000);
  assert.notEqual(posts[0].key, `plan-late-refund:${invoice}`);
  // Another pass sees all successful pieces, including if the charge snapshot lags behind the refund list.
  chargeRefunded = 3500;
  assert.equal((await run()).state, "done");
  assert.equal(posts.length, 1);
});
test("a pending remainder stays owed; its confirmed failure advances only its retry key", async () => {
  seed(); answerStatus = "pending";
  const first = await run();
  assert.equal(first.state, "owed"); assert.deepEqual(first.given, []);
  assert.deepEqual(posts.map(p => p.amount), [1500]);
  const firstKey = posts[0].key;
  chargeRefunded = 3500;
  assert.equal((await run()).state, "owed"); assert.equal(posts.length, 1);
  rows.find(r => r.id === "re_vremainder1")!.status = "failed";
  answerStatus = "succeeded";
  assert.equal((await run()).state, "done");
  assert.deepEqual(posts.map(p => p.amount), [1500, 1500]);
  assert.notEqual(posts[1].key, firstKey);
});
test("another refund still pending never authorizes a second return of that part", async () => {
  seed(); rows[1].status = "pending";
  const out = await run();
  assert.equal(out.state, "owed"); assert.deepEqual(out.given, []); assert.deepEqual(posts, []);
});
test("a whole successful prior refund is enough even while the charge snapshot lags", async () => {
  seed(); rows = [row("re_vwholeprior", 5000, "succeeded")]; chargeRefunded = 0;
  const out = await run();
  assert.equal(out.state, "done"); assert.equal(out.given.length, 1); assert.deepEqual(posts, []);
});
test("confirmed external and own pieces together complete the payment", async () => {
  seed(); rows[1].status = "succeeded";
  assert.equal((await run()).state, "done"); assert.deepEqual(posts, []);
});
test("an unknown piece cannot authorize the remaining refund", async () => {
  seed(); rows[1].currency = "eur";
  await assert.rejects(run); assert.deepEqual(posts, []);
});

for (const status of ["pending", "requires_action"]) {
  test(`an external ${status} part without an own refund never settles the whole late payment`, async () => {
    seed();
    rows = [row("re_externalpending01", 1500, status, false)];
    chargeRefunded = 1500;
    const out = await run();
    assert.deepEqual([out.state, out.given, posts.map(p => p.amount)], ["owed", [], []]);
  });
}

test("a confirmed external part without an own refund still permits the remaining return", async () => {
  seed();
  rows = [row("re_externalsucceeded01", 1500, "succeeded", false)];
  chargeRefunded = 1500;
  const out = await run();
  assert.deepEqual([out.state, out.given.map(p => p.amount), posts.map(p => p.amount)], ["done", [5000], [3500]]);
});
