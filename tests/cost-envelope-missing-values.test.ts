import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maximumPretaxCostCents, remainingResourceCostCents } from '../lib/cost-envelope';

test('a sparse cost list cannot authorize any budget', () => {
  assert.equal(remainingResourceCostCents(22000, 2750, new Array<number>(1)), null);
  assert.equal(remainingResourceCostCents(22000, 2750, [0, , 0] as number[]), null);
  const removed = [0, 0]; delete removed[0];
  assert.equal(remainingResourceCostCents(22000, 2750, removed), null);
});
test('a cost inherited through the array prototype is still missing evidence', () => {
  const costs = new Array<number>(1);
  Object.setPrototypeOf(costs, Object.assign(Object.create(Array.prototype), { 0: 0 }));
  assert.equal(remainingResourceCostCents(22000, 2750, costs), null);
});
test('explicit zero costs remain valid and ordinary cost sums stay exact', () => {
  const cap = maximumPretaxCostCents(22000, 2750)!;
  assert.equal(remainingResourceCostCents(22000, 2750, [0, 0]), cap);
  assert.equal(remainingResourceCostCents(22000, 2750, [100, 200]), cap - 300);
  assert.equal(remainingResourceCostCents(22000, 2750, [cap, 0]), 0);
  assert.equal(remainingResourceCostCents(22000, 2750, [cap, 1]), null);
});
test('malformed runtime input is denied rather than throwing or treating it as free', () => {
  for (const input of [null, undefined, { length: 1, 0: 0 }, '0', [undefined], [Infinity]]) {
    assert.equal(remainingResourceCostCents(22000, 2750, input as unknown as number[]), null);
  }
});

test('computed cost entries are refused without executing their getters', () => {
  let reads = 0;
  const costs = [0];
  Object.defineProperty(costs, 0, { get() { reads += 1; return 0; } });
  assert.equal(remainingResourceCostCents(22000, 2750, costs), null);
  assert.equal(reads, 0);
});

test('a Proxy cannot shorten the cost loop to skip an unknown entry',()=>{
 let reads=0;const costs=new Proxy([null],{get(target,key,receiver){if(key==='length')return ++reads===1?1:0;return Reflect.get(target,key,receiver);}});
 assert.equal(remainingResourceCostCents(10000,1538,costs),null);
 assert.equal(reads,0,'length is captured from its own data descriptor, never the get trap');
});
