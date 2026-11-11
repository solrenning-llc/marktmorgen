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
    microdepositVerificationCents: null,
    disputedPaymentCents: 1500,
    failedPaymentCents: 400,
  });
});

test("a fee the official page does not publish is unknown (null), never zero", () => {
  // stripe.com/pricing/local-payment-methods, ACH Direct Debit, read 2026-11-11 (Claude 4 cloud B and cloud H): the
  // page lists 0.8% with a $5.00 cap, 1.2% for two-day settlement, $1.50 per instant bank account validation, $15.00
  // for disputed payments and $4.00 for failed payments, and says nothing about micro-deposit verification or a
  // two-day cap. Rule 24: an unknown cost never becomes zero.
  assert.equal(ACH_DIRECT_DEBIT_FEES.microdepositVerificationCents, null);
  assert.equal(ACH_DIRECT_DEBIT_FEES.twoDayCapCents, null);
});
