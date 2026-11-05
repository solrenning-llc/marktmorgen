import assert from "node:assert/strict";
import { settleFee, settleShares } from "@/lib/share-settle";
import { COMMISSION_LIVE } from "@/lib/plan";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const fee = { id: "fee_Receipt0001", account: "acct_Receipt0001", charge: "ch_Receipt0001", amount: 500, refunded: 100, currency: "usd" };
const NOW = 1_800_000_000;
const calls: { path: string; method: string; headers: Headers; body: URLSearchParams }[] = [];
let receipt: unknown;
const good = () => ({ id: "fr_Receipt0001", object: "fee_refund", fee: fee.id, amount: 400, currency: "usd" });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error("Unexpected synthetic fee refund host");
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const body = new URLSearchParams(String(init?.body ?? ""));
  calls.push({ path: url.pathname, method, headers, body });
  if (method === "GET" && url.pathname === "/v1/application_fees") {
    return Response.json({ object: "list", data: [{ object: "application_fee", ...fee, amount_refunded: fee.refunded }], has_more: false });
  }
  if (method === "GET" && url.pathname === "/v1/charges/" + fee.charge) {
    return Response.json({ object: "charge", id: fee.charge, currency: "usd", amount: 10000, amount_refunded: 0, disputed: false, invoice: null, payment_intent: { object: "payment_intent", id: "pi_Receipt0001", currency: "usd", amount: 10000, latest_charge: fee.charge, metadata: { share_bps: "0", share_base: "10000" } } });
  }
  if (method === "POST" && url.pathname === "/v1/application_fees/" + fee.id + "/refunds") return Response.json(receipt);
  throw new Error("Unexpected synthetic fee refund operation");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_fee_refund_only_a_stand_in";
  part("The actual helper counts only matching application fee refund receipts");
  receipt = good();
  is("confirmed receipt counts the exact difference", await settleFee(fee, NOW, false), 400);
  is("one existing charge lookup and one refund only", calls.map(c => c.method + " " + c.path), ["GET /v1/charges/" + fee.charge, "POST /v1/application_fees/" + fee.id + "/refunds"]);
  is("lookup remains scoped to the creator at its pinned version", [calls[0].headers.get("Stripe-Account"), calls[0].headers.get("Stripe-Version")], [fee.account, "2024-06-20"]);
  const write = calls[1];
  const key = "share-back:" + fee.id + ":100:400";
  is("refund keeps platform scope and original idempotency", [write.headers.get("Stripe-Account"), write.headers.get("Authorization"), write.headers.get("Idempotency-Key"), Object.fromEntries(write.body)], [null, "Bearer sk_test_fee_refund_only_a_stand_in", key, { amount: "400" }]);
  receipt = { ...good(), fee: { id: fee.id } }; calls.length = 0;
  is("expanded matching fee is accepted", await settleFee(fee, NOW, false), 400);

  part("Unknown or mismatched receipts cannot inflate refunded counters");
  const cases: [string, unknown][] = [
    ["empty", {}], ["null", null], ["array", [good()]], ["string", "ok"],
    ["id only", { id: "fr_Receipt0001" }],
    ["wrong id type", { ...good(), id: "re_Receipt0001" }],
    ["missing id", { ...good(), id: undefined }],
    ["wrong object", { ...good(), object: "refund" }],
    ["missing fee", { ...good(), fee: null }],
    ["other fee", { ...good(), fee: "fee_Different0001" }],
    ["expanded other fee", { ...good(), fee: { id: "fee_Different0001" } }],
    ["wrong amount", { ...good(), amount: 399 }],
    ["string amount", { ...good(), amount: "400" }],
    ["fractional amount", { ...good(), amount: 400.5 }],
    ["wrong currency", { ...good(), currency: "eur" }],
    ["missing currency", { ...good(), currency: undefined }],
  ];
  for (const [label, value] of cases) {
    receipt = value; calls.length = 0;
    await assert.rejects(settleFee(fee, NOW, false), /receipt was not confirmed/);
    is(label + " has no retry or extra lookup", calls.length, 2);
    is(label + " keeps the original refund key", calls[1].headers.get("Idempotency-Key"), key);
  }
  part("The actual daily job reports an unconfirmed refund as failed");
  receipt = {}; calls.length = 0; redis.clear();
  const counted = await settleShares(Date.now() + 60000, NOW, false);
  is("failure is visible without invented refund counts", [counted.failed, counted.gaveBack, counted.cents, counted.complete], [1, 0, 0, false]);
  is("the job does not retry the uncertain refund", calls.filter(c => c.method === "POST").length, 1);

  part("Unknown currency and unsafe amounts never authorize a mutation");
  for (const currency of [undefined, "", "USD", "unknown"]) {
    calls.length = 0;
    await assert.rejects(settleFee({ ...fee, currency }, NOW, false), /currency is unknown/);
    is("unknown currency makes no provider call", calls.length, 0);
  }
  calls.length = 0;
  await assert.rejects(settleFee({ ...fee, amount: Number.MAX_SAFE_INTEGER + 1000 }, NOW, false), /amount is not a safe integer/);
  is("unsafe amount never reaches refund endpoint", calls.filter(c => c.method === "POST").length, 0);
  calls.length = 0;
  is("already returned fee incurs nothing", await settleFee({ ...fee, refunded: fee.amount }, NOW, false), 0);
  is("already returned fee makes no request", calls.length, 0);
  is("the actual commission switch stays off", COMMISSION_LIVE, false);
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
