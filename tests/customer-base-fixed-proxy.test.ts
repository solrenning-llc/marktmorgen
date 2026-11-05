import assert from 'node:assert/strict';
import test from 'node:test';
import {assessMinimumCustomerBase, type CustomerBaseReview} from '../lib/customer-base-rules';
import {fundedCustomerScenario} from './margin-test-fixtures';

const units = () => [{months: 1 as const, scenario: fundedCustomerScenario(10000, 7000, 'creator_month_full')}];
const review = (): CustomerBaseReview => ({
 monthlyFixedCostsCeilingCents: 10000, monthlyFixedTaxesCeilingCents: 0,
 allFixedCostsBounded: true, allFixedTaxesReviewed: true,
 fixedCostsEvidence: 'TEST ONLY', fixedTaxEvidence: 'TEST ONLY', reviewedPayingCustomers: 2,
});
const unknown = {status: 'unknown', minimumCustomers: null, reviewedBaseSufficient: false};

test('a fixed review cannot hide an unpriced cost behind Proxy reflection', () => {
 for (const hidden of [null, 0, 100000]) {
  const target = {...review(), unreviewedSupplier: hidden};
  const supplied = new Proxy(target, {ownKeys: t => Reflect.ownKeys(t).filter(k => k !== 'unreviewedSupplier')});
  assert.deepEqual(assessMinimumCustomerBase(units(), supplied), unknown);
 }
});

test('transparent and revoked fixed-review Proxies supply no financial evidence', () => {
 assert.deepEqual(assessMinimumCustomerBase(units(), new Proxy(review(), {})), unknown);
 const supplied = Proxy.revocable(review(), {}); supplied.revoke();
 assert.deepEqual(assessMinimumCustomerBase(units(), supplied.proxy), unknown);
});

test('ordinary frozen and null-prototype fixed evidence keeps exact monthly and annual arithmetic', () => {
 const expected = {status: 'calculated', minimumCustomers: 2, reviewedBaseSufficient: true};
 for (const fixed of [review(), Object.freeze(review()), Object.assign(Object.create(null), review())]) {
  assert.deepEqual(assessMinimumCustomerBase(units(), fixed), expected);
  assert.deepEqual(assessMinimumCustomerBase([{months: 12, scenario: fundedCustomerScenario(22000, 15401, 'creator_year_full')}], {...fixed, monthlyFixedCostsCeilingCents: 18342, reviewedPayingCustomers: 15}),
   {status: 'calculated', minimumCustomers: 15, reviewedBaseSufficient: true});
 }
});

test('fixed-review accessors are rejected without executing supplied code', () => {
 for (const key of Object.keys(review())) {
  let reads = 0; const fixed = review();
  Object.defineProperty(fixed, key, {enumerable: true, get() {reads++; throw new Error('unreviewed code');}});
  assert.deepEqual(assessMinimumCustomerBase(units(), fixed), unknown);
  assert.equal(reads, 0);
 }
});
