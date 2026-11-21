import assert from "node:assert/strict";
import { test } from "node:test";
import * as checkout from "@/lib/instant-pay";

type Notice = { amount_total?: unknown; payment_intent?: unknown };
const paymentIntentForDelivery = (checkout as unknown as {
  paymentIntentForDelivery?: (notice: Notice) => string | null;
}).paymentIntentForDelivery;

test("delivery distinguishes a known zero total from an unverified receipt", () => {
  assert.equal(typeof paymentIntentForDelivery, "function");
  assert.equal(paymentIntentForDelivery?.({ amount_total: 0, payment_intent: null }), "");
  assert.equal(paymentIntentForDelivery?.({ amount_total: 0 }), "");
  assert.equal(paymentIntentForDelivery?.({}), null);
  assert.equal(paymentIntentForDelivery?.({ amount_total: "0" }), null);
});

test("delivery reads bare or expanded processor references exactly", () => {
  const id = "pi_Synthetic12345";
  assert.equal(paymentIntentForDelivery?.({ amount_total: 2900, payment_intent: id }), id);
  assert.equal(paymentIntentForDelivery?.({ amount_total: 2900, payment_intent: { id } }), id);
  assert.equal(paymentIntentForDelivery?.({ amount_total: 2900, payment_intent: { id: 1 } }), null);
});
