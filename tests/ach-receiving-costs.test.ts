import assert from "node:assert/strict";
import { test } from "node:test";
import { ACH_DIRECT_DEBIT_FEES } from "@/lib/receiving-costs";

test("records the current official Stripe ACH fee schedule without guessing a two-day cap", () => {
  assert.deepEqual(ACH_DIRECT_DEBIT_FEES, {
    sourceUrl: "https://stripe.com/pricing/local-payment-methods",
    verifiedOn: "2026-11-11",
    standardRateBps: 80,
    standardCapCents: 500,
    twoDayRateBps: 120,
    twoDayCapCents: null,
    instantVerificationCents: 150,
    microdepositVerificationCents: 0,
    disputedPaymentCents: 1500,
    failedPaymentCents: 400,
  });
});
