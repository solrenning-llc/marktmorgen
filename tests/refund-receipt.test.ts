import { refundCharge } from "@/lib/billing";
import { done, is, part } from "./check";

const INTENT = "pi_RefundReceipt0001";
const KEY = "refund-receipt-synthetic-only";
const requests: { url: string; method: string; headers: Headers; body: URLSearchParams }[] = [];
let receipt: unknown;
let status = 200;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url !== "https://api.stripe.com/v1/refunds") throw new Error("Unexpected synthetic refund URL");
  requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: new URLSearchParams(String(init?.body ?? "")) });
  return new Response(JSON.stringify(receipt), { status });
}) as typeof fetch;
const valid = () => ({ id: "re_RefundReceipt0001", object: "refund", status: "succeeded", payment_intent: INTENT, currency: "usd", amount: 3500 });

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_refund_receipt_only_a_stand_in";
  part("Actual refundCharge confirms a matching successful receipt");
  for (const cents of [3500, null]) {
    requests.length = 0;
    receipt = valid();
    is("matching successful receipt " + String(cents), await refundCharge(INTENT, cents, KEY), true);
    is("one existing POST only", requests.length, 1);
    const request = requests[0];
    is("platform transport is preserved", [request.method, request.headers.get("Stripe-Account"), request.headers.get("Authorization"), request.headers.get("Stripe-Version"), request.headers.get("Idempotency-Key")],
      ["POST", null, "Bearer sk_test_refund_receipt_only_a_stand_in", "2024-06-20", KEY]);
    is("exact requested amount, intent and reason", Object.fromEntries(request.body),
      cents === null ? { payment_intent: INTENT, reason: "requested_by_customer" } : { payment_intent: INTENT, reason: "requested_by_customer", amount: "3500" });
  }
  receipt = { ...valid(), payment_intent: { id: INTENT } };
  is("expanded matching intent is accepted", await refundCharge(INTENT, 3500, KEY), true);
  receipt = { ...valid(), id: "pyr_RefundReceipt0001" };
  is("a pyr_ receipt (a refund on some non-card methods) is a refund too", await refundCharge(INTENT, 3500, KEY), true);

  part("HTTP success alone never proves a completed refund");
  const cases: [string, unknown][] = [
    ["empty", {}], ["null", null], ["array", [valid()]], ["string", "ok"],
    ["id only", { id: "re_RefundReceipt0001" }],
    ["wrong object", { ...valid(), object: "payment_intent" }],
    ["missing id", { ...valid(), id: undefined }],
    ["wrong id", { ...valid(), id: "pi_NotARefund0001" }],
    ["near-miss id", { ...valid(), id: "py_RefundReceipt0001" }],
    ["short pyr_ id", { ...valid(), id: "pyr_short" }],
    ["pending", { ...valid(), status: "pending" }],
    ["requires action", { ...valid(), status: "requires_action" }],
    ["failed", { ...valid(), status: "failed" }],
    ["canceled", { ...valid(), status: "canceled" }],
    ["missing status", { ...valid(), status: undefined }],
    ["other intent", { ...valid(), payment_intent: "pi_AnotherPayment001" }],
    ["expanded other intent", { ...valid(), payment_intent: { id: "pi_AnotherPayment001" } }],
    ["missing intent", { ...valid(), payment_intent: null }],
    ["wrong currency", { ...valid(), currency: "eur" }],
    ["missing currency", { ...valid(), currency: undefined }],
    ["zero amount", { ...valid(), amount: 0 }],
    ["negative amount", { ...valid(), amount: -3500 }],
    ["fractional amount", { ...valid(), amount: 3500.5 }],
    ["string amount", { ...valid(), amount: "3500" }],
    ["unsafe amount", { ...valid(), amount: Number.MAX_SAFE_INTEGER + 1 }],
    ["different partial amount", { ...valid(), amount: 3499 }],
  ];
  for (const [label, response] of cases) {
    requests.length = 0;
    receipt = response;
    is(label + " is unconfirmed", await refundCharge(INTENT, 3500, KEY), false);
    is(label + " has no retry or extra lookup", requests.length, 1);
    is(label + " keeps the original idempotency key", requests[0].headers.get("Idempotency-Key"), KEY);
  }
  part("Invalid input incurs no request");
  for (const cents of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    requests.length = 0;
    is("invalid amount refused", await refundCharge(INTENT, cents, KEY), false);
    is("invalid amount never reaches provider", requests.length, 0);
  }
  requests.length = 0;
  is("invalid intent refused", await refundCharge("not-an-intent", 3500, KEY), false);
  is("invalid intent never reaches provider", requests.length, 0);
  receipt = { error: { message: "synthetic refusal" } }; status = 402;
  is("provider refusal stays unconfirmed", await refundCharge(INTENT, 3500, KEY), false);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
