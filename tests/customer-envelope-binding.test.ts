import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundCustomerEnvelope, type CustomerEnvelopeBinding } from '../lib/customer-envelope-binding';
import {txCustomerFixture} from './customer-tax-review-fixture';

function binding(): CustomerEnvelopeBinding {
  return { customerKey: 'store-a', termsSnapshot: 'current-terms', validFrom: 100, expiresAt: 200,
    review: { ...txCustomerFixture(10000,0), taxesCeilingCents:3000 } };
}
const run = (value: CustomerEnvelopeBinding | null, now = 150, customer = 'store-a', terms = 'current-terms') =>
  boundCustomerEnvelope(value, customer, terms, now, 10000, 1);

test('current customer and terms receive the existing conservative allowance', () => {
  const result = run(binding()); assert.equal(result.approved, true); assert.equal(result.affordableUnits, 6999);
});
test('another customer cannot reuse a funded review', () => {
  assert.equal(run(binding(), 150, 'store-b').reason, 'customer_mismatch');
  assert.equal(run(binding(), 150, ' ').approved, false);
});
test('changes to priced rights invalidate the previous allowance', () => {
  assert.equal(run(binding(), 150, 'store-a', 'new-terms').reason, 'terms_mismatch');
  assert.equal(run(binding(), 150, 'store-a', '').approved, false);
});
test('validity includes the start and excludes the expiry instant', () => {
  assert.equal(run(binding(), 99).reason, 'review_not_yet_valid');
  assert.equal(run(binding(), 100).approved, true);
  assert.equal(run(binding(), 199).approved, true);
  assert.equal(run(binding(), 200).reason, 'review_expired');
});
test('invalid clocks or validity intervals never authorize costs', () => {
  for (const n of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(run(binding(), n).approved, false);
    assert.equal(run({ ...binding(), validFrom: n }).approved, false);
    assert.equal(run({ ...binding(), expiresAt: n }).approved, false);
  }
  assert.equal(run({ ...binding(), expiresAt: 100 }).reason, 'invalid_validity');
});
test('absent binding or unknown tax review cannot create an allowance', () => {
  assert.equal(run(null).approved, false);
  assert.equal(run({ ...binding(), review: null }).approved, false);
  const value = binding(); value.review!.allTaxesReviewed = false;
  assert.equal(run(value).approved, false);
});
test('binding does not bypass provider unit validation or available capacity', () => {
  const value = binding();
  assert.equal(boundCustomerEnvelope(value, 'store-a', 'current-terms', 150, 0, 1).approved, false);
  assert.equal(boundCustomerEnvelope(value, 'store-a', 'current-terms', 150, 10000, 7000).approved, false);
});
test('computed or inherited binding fields are refused without executing getters', () => {
  let reads = 0;
  for (const key of ['customerKey', 'termsSnapshot', 'validFrom', 'expiresAt', 'review'] as const) {
    const value = binding(); const stored = value[key];
    Object.defineProperty(value, key, { get() { reads += 1; return stored; }, enumerable: true });
    assert.equal(run(value).approved, false);
  }
  assert.equal(run(Object.create(binding()) as CustomerEnvelopeBinding).approved, false);
  assert.equal(reads, 0);
});
test('non-string stored identity or terms never match', () => {
  assert.equal(run({ ...binding(), customerKey: ['store-a'] as unknown as string }).reason, 'customer_mismatch');
  assert.equal(run({ ...binding(), termsSnapshot: { toString: () => 'current-terms' } as unknown as string }).reason, 'terms_mismatch');
});
