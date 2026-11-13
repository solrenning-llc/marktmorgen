/**
 * chargeNow (lib/billing.ts), the one-off charge AI captions are paid with, took the payment intent from the
 * POST /invoices/{id}/pay reply without checking the reply was this invoice (rule 30). A reply for another invoice,
 * paid by another payment, was recorded as the captions payment, and any later refund of the captions went to that
 * other payment while the real charge was never given back. Found by Claude 3 (nuvem E)'s money audit, 13/11/2026.
 *
 * Now the invoice made and the invoice paid are taken only when they are this customer's, under this charge's mark,
 * for this amount; anything else is "error", so the caller reads Stripe's invoice list (orderCharge) for the truth.
 * Synthetic: a stand-in for our own Stripe account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeNow } from "@/lib/billing";

process.env.STRIPE_SECRET_KEY = "sk_test_charge_now_own_reply_only";
const CUSTOMER = "cus_TestChargeOwn01";
const MARK = "cap-own-reply-1";

function standIn(payReply: (invoice: string) => Record<string, unknown>, made?: Record<string, unknown>) {
  const voids: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path.startsWith("/subscriptions/")) return json({ id: "sub_TestChargeOwn01", object: "subscription", default_payment_method: "pm_TestChargeOwn01" });
    if (path === "/invoices" && method === "POST") return json(made ?? { id: "in_TestOwn000001", object: "invoice", customer: CUSTOMER, metadata: { mark: MARK } });
    if (path === "/invoiceitems" && method === "POST") return json({ id: "ii_TestOwn000001", object: "invoiceitem" });
    const finalize = path.match(/^\/invoices\/(in_\w+)\/finalize$/);
    if (finalize) return json({ id: finalize[1], object: "invoice", status: "open" });
    const paid = path.match(/^\/invoices\/(in_\w+)\/pay$/);
    if (paid) return json(payReply(paid[1]));
    const voided = path.match(/^\/invoices\/(in_\w+)\/void$/);
    if (voided) {
      voids.push(voided[1]);
      return json({ error: { message: "This invoice is paid." } }, 400);
    }
    return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  }) as typeof fetch;
  return voids;
}

const charge = () => chargeNow({ customerId: CUSTOMER, subscriptionId: "sub_TestChargeOwn01", cents: 3_500, description: "AI captions", mark: MARK, idempotencyKey: "nl-own-reply" });
const own = (invoice: string) => ({ id: invoice, object: "invoice", customer: CUSTOMER, status: "paid", total: 3_500, amount_paid: 3_500, payment_intent: "pi_TestOwn000001", metadata: { mark: MARK } });

test("control: this invoice's own paid reply is taken", async () => {
  standIn(own);
  assert.deepEqual(await charge(), { ok: true, invoiceId: "in_TestOwn000001", paymentIntent: "pi_TestOwn000001" });
});

for (const [what, reply] of [
  ["another invoice", (invoice: string) => ({ ...own(invoice), id: "in_TestOther00001", payment_intent: "pi_TestOther00001" })],
  ["another customer", (invoice: string) => ({ ...own(invoice), customer: "cus_TestSomeoneElse", payment_intent: "pi_TestOther00001" })],
  ["another charge's mark", (invoice: string) => ({ ...own(invoice), metadata: { mark: "someone-else" }, payment_intent: "pi_TestOther00001" })],
  ["another amount", (invoice: string) => ({ ...own(invoice), total: 900, payment_intent: "pi_TestOther00001" })],
] as [string, (invoice: string) => Record<string, unknown>][]) {
  test(`a /pay reply naming ${what} is never taken as this charge's payment`, async () => {
    standIn(reply);
    const quiet = console.error;
    console.error = () => {};
    try {
      const result = await charge();
      assert.deepEqual(result, { ok: false, reason: "error" });
    } finally {
      console.error = quiet;
    }
  });
}

test("an invoice made for another customer is never filled, paid or voided", async () => {
  const voids = standIn(own, { id: "in_TestOther00002", object: "invoice", customer: "cus_TestSomeoneElse", metadata: { mark: MARK } });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await charge(), { ok: false, reason: "error" });
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(voids, []);
});
