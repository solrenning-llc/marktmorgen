import assert from 'node:assert/strict';
import test from 'node:test';
import {maximumPretaxCostCents, remainingResourceCostCents} from '../lib/cost-envelope';

test('a Proxy cannot conceal an unknown or unaffordable cost through length and ownKeys', () => {
  for (const hidden of [null, undefined, 100_000]) {
    let reads = 0;
    const target = [100, hidden];
    const costs = new Proxy(target, {
      ownKeys: value => Reflect.ownKeys(value).filter(key => key !== '1'),
      getOwnPropertyDescriptor(value, key) {
        const field = Reflect.getOwnPropertyDescriptor(value, key);
        return key === 'length' ? {...field!, value: 1} : field;
      },
      get() { reads++; throw new Error('ordinary cost reads are not evidence'); },
    });
    assert.equal(remainingResourceCostCents(10_000, 0, costs as number[]), null);
    assert.equal(reads, 0);
  }
});

test('transparent and revoked cost-list Proxies never certify remaining allowance', () => {
  assert.equal(remainingResourceCostCents(10_000, 0, new Proxy([100], {})), null);
  const revoked = Proxy.revocable([100], {});
  revoked.revoke();
  assert.equal(remainingResourceCostCents(10_000, 0, revoked.proxy), null);
});

test('plain and frozen costs keep exact arithmetic, explicit zero and the whole net cent', () => {
  const maximum = maximumPretaxCostCents(10_000, 0)!;
  for (const costs of [[100, 200], Object.freeze([100, 200])]) {
    assert.equal(remainingResourceCostCents(10_000, 0, costs), maximum - 300);
  }
  assert.equal(remainingResourceCostCents(10_000, 0, [0]), maximum);
  assert.equal(remainingResourceCostCents(10_000, 0, [maximum]), 0);
  assert.equal(remainingResourceCostCents(10_000, 0, [maximum, 1]), null);
});

test('serialization rejection never executes an accessor introduced by a cost-list trap', () => {
  let reads = 0;
  const target = [100, 200];
  const costs = new Proxy(target, {
    ownKeys: () => ['0', 'length'],
    getOwnPropertyDescriptor(value, key) {
      if (key === '0') {
        Object.defineProperty(value, '1', {enumerable: true, configurable: true, get() {reads++; return 0;}});
      }
      const field = Reflect.getOwnPropertyDescriptor(value, key);
      return key === 'length' ? {...field!, value: 1} : field;
    },
  });
  assert.equal(remainingResourceCostCents(10_000, 0, costs), null);
  assert.equal(reads, 0);
});
