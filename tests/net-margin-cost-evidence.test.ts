import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCustomerWorstCase, CUSTOMER_COST_CATEGORIES, type CustomerWorstCase } from '../lib/net-margin-rules';
import { txCustomerFixture } from './customer-tax-review-fixture';

const review = (): CustomerWorstCase => ({ ...txCustomerFixture(10000, 0), taxesCeilingCents: 3000 });
const unknown = (value: CustomerWorstCase) => {
 assert.deepEqual(assessCustomerWorstCase(value), { approved: false, reason: 'unknown', netCents: null, marginBps: null });
};

test('an additional cost cannot disappear from an otherwise profitable review', () => {
 for (const amount of [null, 0, 100000]) {
  const value = review();
  Object.assign(value.costCeilings, { unreviewedSupplier: amount });
  unknown(value);
 }
});

test('hidden and symbolic additional costs are not silently omitted', () => {
 for (const key of ['unreviewedSupplier', Symbol('unreviewedSupplier')]) {
  const value = review();
  Object.defineProperty(value.costCeilings, key, { value: 100000, enumerable: false });
  unknown(value);
 }
});

test('additional executable costs are rejected without running their getters or JSON hooks', () => {
 let calls = 0;
 for (const key of ['unreviewedSupplier', Symbol('unreviewedSupplier')]) {
  const value = review();
  Object.defineProperty(value.costCeilings, key, { enumerable: true, get() { calls++; throw Error('must not run'); } });
  unknown(value);
 }
 const value = review();
 Object.assign(value.costCeilings, { toJSON() { calls++; return review().costCeilings; } });
 unknown(value);
 assert.equal(calls, 0);
});

test('a derived cost record cannot carry an omitted inherited cost', () => {
 let calls = 0;
 for (const prototype of [{ unreviewedSupplier: 100000 }, Object.defineProperty({}, 'unreviewedSupplier', { get() { calls++; return 100000; } })]) {
  const value = review();
  Object.setPrototypeOf(value.costCeilings, prototype);
  unknown(value);
 }
 assert.equal(calls, 0);
});

test('every required cost is explicit enumerable data, with accessors never executed', () => {
 let calls = 0;
 for (const key of CUSTOMER_COST_CATEGORIES) {
  const missing = review(); delete missing.costCeilings[key]; unknown(missing);
  const hidden = review(); Object.defineProperty(hidden.costCeilings, key, { value: 0, enumerable: false }); unknown(hidden);
  const accessor = review(); Object.defineProperty(accessor.costCeilings, key, { enumerable: true, get() { calls++; return 0; } }); unknown(accessor);
 }
 assert.equal(calls, 0);
});

test('uninspectable cost evidence returns unknown rather than throwing', () => {
 for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
  const value = review();
  value.costCeilings = new Proxy(value.costCeilings, { [trap]() { throw Error('uninspectable evidence'); } });
  unknown(value);
 }
});

test('complete JSON, frozen and null-prototype costs keep the same exact net result', () => {
 const original = review(), expected = assessCustomerWorstCase(original);
 assert.equal(expected.approved, true);
 assert.equal(expected.netCents, 7000);
 for (const costs of [JSON.parse(JSON.stringify(original.costCeilings)), Object.freeze({ ...original.costCeilings }), Object.assign(Object.create(null), original.costCeilings)]) {
  assert.deepEqual(assessCustomerWorstCase({ ...review(), costCeilings: costs }), expected);
 }
 const costly = review(); costly.costCeilings.other = 100000;
 assert.equal(assessCustomerWorstCase(costly).approved, false);
});
