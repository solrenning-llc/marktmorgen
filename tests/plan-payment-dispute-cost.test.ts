import test from "node:test";
import assert from "node:assert/strict";
import { PUBLISHED_PLAN_PRICES, type Tier, type Cycle } from "@/lib/plan";
import { assessPlanPaymentDisputeCosts, PLAN_PAYMENT_DISPUTE_KEYS, PLAN_PAYMENT_DISPUTE_COST_RULES } from "@/lib/plan-payment-dispute-cost-rules";
import { contractFundingConfiguration, canonicalFinancialSnapshot } from "@/lib/contract-funding-rules";
import { planPaymentDisputeFixture } from "./margin-test-fixtures";
import { contractFixture } from "./contract-funding-fixture";

test("every monthly and annual plan retains the full lost principal plus reviewed fees", () => {
  const review = planPaymentDisputeFixture();
  for (const key of PLAN_PAYMENT_DISPUTE_KEYS) review[key]!.maximumTotalFeesCents = 300;
  const assessed = assessPlanPaymentDisputeCosts(review);
  assert.ok(assessed);
  for (const key of PLAN_PAYMENT_DISPUTE_KEYS) {
    const [tier, cycle] = key.split("_") as [Tier, Cycle];
    assert.deepEqual(assessed[key], {
      principalCents: PUBLISHED_PLAN_PRICES[tier][cycle], feesCents: 300,
      lostPaymentWorstCaseCents: PUBLISHED_PLAN_PRICES[tier][cycle] + 300,
    }, key + ": no annual amortization or speculative tax credit");
  }
});
test("unknown, partial, coerced, unbounded and overflowed dispute costs never become zero", () => {
  assert.equal(assessPlanPaymentDisputeCosts(null), null);
  for (const key of PLAN_PAYMENT_DISPUTE_KEYS) {
    for (const field of ["maximumPaidPrincipalCents", "maximumTotalFeesCents", "evidence", "allContractPaymentsBounded", "liabilityTailReviewed"] as const) {
      const review = planPaymentDisputeFixture();
      delete (review[key]! as unknown as Record<string, unknown>)[field];
      assert.equal(assessPlanPaymentDisputeCosts(review), null, key + ":" + field);
    }
  }
  for (const invalid of [null, -1, 1.5, "0", Number.NaN, Number.POSITIVE_INFINITY]) {
    const review = planPaymentDisputeFixture();
    (review.creator_month! as unknown as Record<string, unknown>).maximumTotalFeesCents = invalid;
    assert.equal(assessPlanPaymentDisputeCosts(review), null);
  }
  const low = planPaymentDisputeFixture();
  low.creator_year!.maximumPaidPrincipalCents = PUBLISHED_PLAN_PRICES.creator.year - 1;
  assert.equal(assessPlanPaymentDisputeCosts(low), null);
  const overflow = planPaymentDisputeFixture();
  overflow.creator_year!.maximumPaidPrincipalCents = PLAN_PAYMENT_DISPUTE_COST_RULES.maxInteger;
  overflow.creator_year!.maximumTotalFeesCents = 1;
  assert.equal(assessPlanPaymentDisputeCosts(overflow), null);
  const unbounded = planPaymentDisputeFixture();
  unbounded.scale_year!.allContractPaymentsBounded = false;
  assert.equal(assessPlanPaymentDisputeCosts(unbounded), null);
});
test("review accessors and inherited assertions cannot fabricate a dispute ceiling", () => {
  let reads = 0;
  const review = planPaymentDisputeFixture();
  Object.defineProperty(review, "creator_month", { get() { reads++; return {}; } });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
  assert.equal(reads, 0);
  assert.equal(assessPlanPaymentDisputeCosts(Object.create(planPaymentDisputeFixture())), null);
  const row = planPaymentDisputeFixture();
  Object.defineProperty(row.creator_month!, "maximumTotalFeesCents", { get() { reads++; return 0; } });
  assert.equal(assessPlanPaymentDisputeCosts(row), null);
  assert.equal(reads, 0);
});
test("a funded contract reserves the reviewed principal and the already-expensed fee exactly once", () => {
  const f = contractFixture();
  const before = contractFundingConfiguration(f.policy, f.context, f.now);
  assert.ok(before);
  const key = "creator_year";
  f.review.planPaymentDisputes![key]!.maximumPaidPrincipalCents! += 100;
  f.review.planPaymentDisputes![key]!.maximumTotalFeesCents = 30;
  f.policy.financialSnapshot = canonicalFinancialSnapshot(f.review)!;
  assert.equal(contractFundingConfiguration(f.policy, f.context, f.now), null, "unrepresented fees cannot pass");
  f.review.scenarios.creator_year_full!.costCeilings.refundAndDisputeFees! += 30;
  f.policy.financialSnapshot = canonicalFinancialSnapshot(f.review)!;
  assert.equal(contractFundingConfiguration(f.policy, f.context, f.now), null, "the old cash reserve is insufficient");
  f.policy.reservedFundsCents += 130 * f.policy.fundedGrants[key];
  const after = contractFundingConfiguration(f.policy, f.context, f.now);
  assert.ok(after);
  assert.equal(after.grantCents[key], before.grantCents[key] + 130);
  for (const other of PLAN_PAYMENT_DISPUTE_KEYS.filter(k => k !== key)) assert.equal(after.grantCents[other], before.grantCents[other]);
  f.review.planPaymentDisputes![key]!.maximumTotalFeesCents = null;
  f.policy.financialSnapshot = canonicalFinancialSnapshot(f.review)!;
  assert.equal(contractFundingConfiguration(f.policy, f.context, f.now), null, "unknown fees never authorize a grant");
});
