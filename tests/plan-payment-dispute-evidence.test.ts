import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPlanPaymentDisputeCosts, PLAN_PAYMENT_DISPUTE_KEYS } from '../lib/plan-payment-dispute-cost-rules';
import { planPaymentDisputeFixture } from './margin-test-fixtures';
import { contractFixture } from './contract-funding-fixture';
import { canonicalFinancialSnapshot, contractFundingConfiguration } from '../lib/contract-funding-rules';

test('an unreviewed plan liability cannot be discarded from a complete dispute review', () => {
 for (const extra of [null, 0, 100000]) {
  const review = planPaymentDisputeFixture();
  Object.assign(review, { unreviewedPlan: extra });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
 }
 for (const key of ['unreviewedPlan', Symbol('unreviewedPlan')]) {
  const review = planPaymentDisputeFixture();
  Object.defineProperty(review, key, { value: null });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
 }
});

test('every plan refuses unknown, hidden or symbolic additional dispute costs', () => {
 for (const plan of PLAN_PAYMENT_DISPUTE_KEYS) {
  for (const extra of [null, 0, 100000]) {
   const review = planPaymentDisputeFixture();
   Object.assign(review[plan]!, { additionalFeesCents: extra });
   assert.equal(assessPlanPaymentDisputeCosts(review), null);
  }
  for (const key of ['additionalFeesCents', Symbol('additionalFeesCents')]) {
   const review = planPaymentDisputeFixture();
   Object.defineProperty(review[plan]!, key, { value: 100000 });
   assert.equal(assessPlanPaymentDisputeCosts(review), null);
  }
 }
});

test('a bound contract cannot discard unknown dispute fees even when its snapshot matches', () => {
 const fixture = contractFixture();
 assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));
 Object.assign(fixture.review.planPaymentDisputes!.creator_year!, { additionalFeesCents: null });
 fixture.policy.financialSnapshot = canonicalFinancialSnapshot(fixture.review)!;
 assert.equal(typeof fixture.policy.financialSnapshot, 'string');
 assert.equal(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now), null);
});

test('an executable additional liability is refused without invoking it', () => {
 let calls = 0;
 for (const target of ['review', ...PLAN_PAYMENT_DISPUTE_KEYS]) {
  const review = planPaymentDisputeFixture();
  const record = target === 'review' ? review : review[target as typeof PLAN_PAYMENT_DISPUTE_KEYS[number]]!;
  Object.defineProperty(record, 'additionalFeesCents', { enumerable: true, get() { calls++; throw Error('must not execute'); } });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
 }
 assert.equal(calls, 0);
});

test('required plan and cost fields must survive enumerable own-data serialization', () => {
 for (const plan of PLAN_PAYMENT_DISPUTE_KEYS) {
  const review = planPaymentDisputeFixture();
  Object.defineProperty(review, plan, { value: review[plan], enumerable: false });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
  for (const field of ['maximumPaidPrincipalCents', 'maximumTotalFeesCents', 'allContractPaymentsBounded', 'liabilityTailReviewed', 'evidence'] as const) {
   const row = planPaymentDisputeFixture();
   Object.defineProperty(row[plan]!, field, { value: row[plan]![field], enumerable: false });
   assert.equal(assessPlanPaymentDisputeCosts(row), null);
  }
 }
});

test('derived evidence cannot carry an inherited liability omitted from the snapshot', () => {
 for (const target of ['review', ...PLAN_PAYMENT_DISPUTE_KEYS]) {
  const review = planPaymentDisputeFixture();
  const record = target === 'review' ? review : review[target as typeof PLAN_PAYMENT_DISPUTE_KEYS[number]]!;
  Object.setPrototypeOf(record, { additionalFeesCents: null });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
 }
});

test('uninspectable evidence is unknown without escaping an exception', () => {
 for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
  const review = new Proxy(planPaymentDisputeFixture(), { [trap]() { throw Error('uninspectable'); } });
  assert.equal(assessPlanPaymentDisputeCosts(review), null);
 }
});

test('complete frozen and null-prototype evidence preserves every exact principal and fee', () => {
 const plain = planPaymentDisputeFixture();
 for (const plan of PLAN_PAYMENT_DISPUTE_KEYS) plain[plan]!.maximumTotalFeesCents = 300;
 const expected = assessPlanPaymentDisputeCosts(plain);
 assert.ok(expected);
 const frozen = Object.freeze(Object.fromEntries(PLAN_PAYMENT_DISPUTE_KEYS.map(plan => [plan, Object.freeze({ ...plain[plan]! })])));
 const noPrototype = Object.assign(Object.create(null), Object.fromEntries(PLAN_PAYMENT_DISPUTE_KEYS.map(plan => [plan, Object.assign(Object.create(null), plain[plan])])));
 for (const review of [JSON.parse(JSON.stringify(plain)), frozen, noPrototype]) assert.deepEqual(assessPlanPaymentDisputeCosts(review), expected);
});

test('the result cannot lose a plan to an inherited setter or substitute inherited fees', () => {
 const review = planPaymentDisputeFixture(), expected = assessPlanPaymentDisputeCosts(review);
 assert.ok(expected);
 const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'creator_month');
 let calls = 0;
 try {
  Object.defineProperty(Object.prototype, 'creator_month', { configurable: true, get() { calls++; return { principalCents: 0, feesCents: 0, lostPaymentWorstCaseCents: 0 }; }, set() { calls++; } });
  const assessed = assessPlanPaymentDisputeCosts(review);
  assert.ok(assessed);
  assert.equal(Object.hasOwn(assessed, 'creator_month'), true);
  assert.deepEqual(assessed.creator_month, expected.creator_month);
  assert.equal(calls, 0);
 } finally {
  if (prior) Object.defineProperty(Object.prototype, 'creator_month', prior);
  else Reflect.deleteProperty(Object.prototype, 'creator_month');
 }
});
