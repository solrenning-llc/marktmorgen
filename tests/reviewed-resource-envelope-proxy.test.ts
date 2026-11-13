import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewedResourceEnvelope } from '../lib/reviewed-resource-envelope';
import type { CustomerWorstCase } from '../lib/net-margin-rules';
import { txCustomerFixture } from './customer-tax-review-fixture';

const denied = {
  approved: false,
  reason: 'unknown',
  remainingMicroUsd: null,
  affordableUnits: null,
} as const;

function review(): CustomerWorstCase {
  const value = txCustomerFixture(10_000, 0);
  value.taxesCeilingCents = 3_000;
  return value;
}

test('a cost Proxy cannot hide an unknown liability before provider allowance', () => {
  const value = review();
  const target = Object.assign(value.costCeilings, { unreviewedSupplier: null });
  value.costCeilings = new Proxy(target, {
    ownKeys(record) {
      return Reflect.ownKeys(record).filter(key => key !== 'unreviewedSupplier');
    },
  });

  assert.deepEqual(reviewedResourceEnvelope(value, 1, 1), denied);
});

test('a transparent cost Proxy is unknown without executing ordinary reads', () => {
  const value = review();
  let reads = 0;
  value.costCeilings = new Proxy(value.costCeilings, {
    get(target, key, receiver) {
      reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });

  assert.deepEqual(reviewedResourceEnvelope(value, 1, 1), denied);
  assert.equal(reads, 0);
});

test('plain frozen and null-prototype cost evidence keeps the exact allowance', () => {
  const expected = reviewedResourceEnvelope(review(), 1, 1);
  assert.deepEqual(expected, {
    approved: true,
    reason: 'within_reviewed_envelope',
    remainingMicroUsd: 69_990_000,
    affordableUnits: 69_990_000,
  });

  const frozen = review();
  frozen.costCeilings = Object.freeze({ ...frozen.costCeilings });
  assert.deepEqual(reviewedResourceEnvelope(frozen, 1, 1), expected);

  const nullPrototype = review();
  nullPrototype.costCeilings = Object.assign(Object.create(null), nullPrototype.costCeilings);
  assert.deepEqual(reviewedResourceEnvelope(nullPrototype, 1, 1), expected);
});
