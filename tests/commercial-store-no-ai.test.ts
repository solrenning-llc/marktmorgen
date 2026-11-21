/**
 * Owner, 20/11/2026 (decision 3 (a) to Claude 4, "Revisão comercial, trava 2"): a plan that publishes no AI right
 * (Store: no writing jobs, no visitor answers) needs no AI ceiling. The commercial review required every paid plan's
 * AI ceiling to cover at least the largest single request, so a Store ceiling of 0, which is what the automatic policy
 * gives it (lib/ai-spend-policy.ts), failed every review whatever its figures. A plan with AI rights still needs it.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_AI_SPEND_POLICY as policy } from './commercial-store-no-ai-policy';
import { commercialMarginReady, commercialPlansMayOpen, CURRENT_COMMERCIAL_MARGIN_REVIEW, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, BASE_PLAN_REVENUE_CEILINGS, type CommercialMarginReview } from '@/lib/commercial-margin';
import { AUTOMATIC_AI_STORE_MICRO_USD } from '@/lib/ai-spend-policy';
import { AI_MONTHLY } from '@/lib/ai-rules';
import { requiredAiStoreMicroUsd } from '@/lib/ai-entitlement-rules';
import { ANSWERS_MONTHLY } from '@/lib/answers-rules';
import { fundedCustomerWithAi, planPaymentDisputeFixture, zeroExposureFixture, zeroFixedCompanyFixture } from './margin-test-fixtures';
// The synthetic review names this month when it is made; only Date is stopped, so a run across 00:00 UTC on a month's
// last day cannot split the review's month from the policy's.
mock.timers.enable({ apis: ['Date'], now: Date.now() });
function review(): CommercialMarginReview {
  return { companyBase: zeroFixedCompanyFixture, planPaymentDisputes: planPaymentDisputeFixture(), priceAndRightsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, taxEvidence: 'TEST ONLY', costAndLimitEvidence: 'TEST ONLY', allocatedFixedCostsVerified: true, fundedExposure: zeroExposureFixture(), prepaidUsageEnforced: true,
    scenarios: Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key => { const gross = BASE_PLAN_REVENUE_CEILINGS[key] ?? 10000; return [key, fundedCustomerWithAi(gross, Math.floor(gross * .65), 12, key)]; })) };
}

test('Store publishes no AI right, and the automatic policy gives it an AI ceiling of 0', () => {
  assert.equal(AI_MONTHLY.creator, 0);
  assert.equal(ANSWERS_MONTHLY.creator, 0);
  assert.equal(AUTOMATIC_AI_STORE_MICRO_USD.creator, 0);
  assert.equal(policy.storeMicroUsd.creator, 0);
});

test('a plan with no AI right passes the review with an AI ceiling of 0', () => {
  assert.equal(commercialMarginReady(review()), true);
  // Nothing opens: the actual review stays absent, and a passing synthetic one alone opens nothing.
  assert.equal(CURRENT_COMMERCIAL_MARGIN_REVIEW, null);
  assert.equal(commercialMarginReady(), false);
  assert.equal(commercialPlansMayOpen(true, review()), false);
});

test('a plan with AI rights still needs a ceiling of at least one largest request', () => {
  const largest = Math.max(...Object.values(policy.requestMicroUsd));
  const saved = policy.storeMicroUsd.pro;
  try {
    policy.storeMicroUsd.pro = largest - 1;
    assert.equal(commercialMarginReady(review()), false);
  } finally {
    policy.storeMicroUsd.pro = saved;
  }
  assert.equal(commercialMarginReady(review()), true);
});

test('Studio and Scale are still held to every right funded in full, and Store needs nothing', () => {
  assert.equal(requiredAiStoreMicroUsd('creator', policy.requestMicroUsd), BigInt(0));
  for (const tier of ['pro', 'scale'] as const) {
    const required = requiredAiStoreMicroUsd(tier, policy.requestMicroUsd)!;
    assert.ok(required > BigInt(0));
    const saved = policy.storeMicroUsd[tier];
    try {
      policy.storeMicroUsd[tier] = Number(required) - 1;
      assert.equal(commercialMarginReady(review()), false, `${tier} one micro-dollar short of its rights`);
      policy.storeMicroUsd[tier] = Number(required);
      assert.equal(commercialMarginReady(review()), true, `${tier} at exactly its rights`);
    } finally {
      policy.storeMicroUsd[tier] = saved;
    }
  }
});
