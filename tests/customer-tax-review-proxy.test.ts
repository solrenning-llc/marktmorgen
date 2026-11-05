import assert from 'node:assert/strict';
import test from 'node:test';
import {captureCustomerTaxInput, customerTaxCeiling} from '../lib/customer-tax-review';
import {assessCustomerWorstCase} from '../lib/net-margin-rules';
import {txCustomerFixture} from './customer-tax-review-fixture';

const amounts = {revenueCents: 10_000, refundableCents: 0, pretaxCents: BigInt(10_000)};
const pair = (row: ReturnType<typeof txCustomerFixture>) => ({taxReview: row.taxReview, taxContext: row.taxContext});
function hiddenTax() {
  const row = txCustomerFixture();
  const target = {...row.taxReview!.components, unreviewedJurisdiction: null};
  row.taxReview!.components = new Proxy(target, {
    ownKeys: value => Reflect.ownKeys(value).filter(key => key !== 'unreviewedJurisdiction'),
  });
  return row;
}

test('the direct tax ceiling cannot discard an unpriced jurisdiction hidden by a Proxy', () => {
  const row = hiddenTax();
  assert.equal(customerTaxCeiling(row.taxReview, row.taxContext, amounts), null);
});

test('capturing fiscal inputs refuses the original Proxy before projecting tax components', () => {
  assert.equal(captureCustomerTaxInput(pair(hiddenTax())), null);
});

test('the real full-use assessor never approves a tax snapshot with a concealed unknown component', () => {
  assert.equal(assessCustomerWorstCase(hiddenTax()).reason, 'tax_review_unknown');
});

test('an unknown incoming exchange cannot disappear through a shortened Proxy array', () => {
  const row = txCustomerFixture();
  const exchanges = row.taxReview!.books[0].exchanges;
  row.taxReview!.books[0].exchanges = new Proxy([...exchanges, null], {
    ownKeys: () => ['0', 'length'],
    getOwnPropertyDescriptor(value, key) {
      const field = Reflect.getOwnPropertyDescriptor(value, key);
      return key === 'length' ? {...field!, value: 1} : field;
    },
  }) as typeof exchanges;
  assert.equal(customerTaxCeiling(row.taxReview, row.taxContext, amounts), null);
  assert.equal(captureCustomerTaxInput(pair(row)), null);
});

test('transparent and revoked fiscal Proxies provide no reviewed evidence', () => {
  const row = txCustomerFixture();
  for (const value of [
    new Proxy(pair(row), {}),
    {taxReview: new Proxy(row.taxReview!, {}), taxContext: row.taxContext},
    {taxReview: row.taxReview, taxContext: new Proxy(row.taxContext!, {})},
  ]) assert.equal(captureCustomerTaxInput(value), null);
  const revoked = Proxy.revocable(row.taxReview!, {});
  revoked.revoke();
  assert.equal(customerTaxCeiling(revoked.proxy, row.taxContext, amounts), null);
});

test('a trap cannot make native validation execute a getter on an earlier fiscal branch', () => {
  const row = txCustomerFixture();
  let reads = 0;
  row.taxReview!.components = new Proxy(row.taxReview!.components, {
    ownKeys(value) {
      Object.defineProperty(row.taxReview!.fx.usdToBrl.evidence, 'source', {
        enumerable: true, configurable: true, get() {reads++; throw new Error('must not execute');},
      });
      return Reflect.ownKeys(value);
    },
  });
  assert.equal(customerTaxCeiling(row.taxReview, row.taxContext, amounts), null);
  assert.equal(reads, 0);
});

test('ordinary frozen and null-prototype fiscal evidence preserves the exact tax and positive control', () => {
  for (const kind of ['plain', 'frozen', 'null-prototype']) {
    const row = txCustomerFixture();
    if (kind === 'frozen') Object.freeze(row.taxReview);
    if (kind === 'null-prototype') Object.setPrototypeOf(row.taxReview!, null);
    const captured = captureCustomerTaxInput(pair(row));
    assert.ok(captured, kind);
    assert.equal(customerTaxCeiling(captured.taxReview, captured.taxContext, amounts), 1538, kind);
    assert.equal(assessCustomerWorstCase(row).approved, true, kind);
  }
});
