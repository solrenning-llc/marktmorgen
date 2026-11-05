/** CX-113: the live legacy receipt and Lua belong to the actual order envelope. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, partAverage, partPeak } from './store-data-registry';
import { COMMAND, ORDER_COST, ORDER_COMPUTE, ORDER_LIBRARY, ORDER_RENEWAL_STOP, PER_EMAIL } from './plan-cost-registry';

test('the live 45-day receipt allocation covers the real Redis 7.4.12 measurement', () => {
  const family = FAMILIES['nl:orders:seen:@lib/orders.ts'];
  const part = family.parts?.find(p => 'per' in p && p.per === 'order');
  assert.ok(part && 'per' in part);
  // Native counterpart uses the exact 47-byte production key and 68-byte
  // receipt, including Redis overhead. This is a counterexample to MARK160,
  // not an invoice or a claim about all Redis implementations.
  const measuredMemoryBytes = 168;
  assert.ok(part.bytes >= measuredMemoryBytes, `live allocation ${part.bytes} < measured ${measuredMemoryBytes}`);
  assert.equal(part.days, 45);
  for (const tier of ['creator', 'pro', 'scale'] as const) {
    assert.ok(partAverage(part, tier) > 0);
    assert.ok(partPeak(part, tier) >= partAverage(part, tier));
  }
});

test('every order includes the 23 billed commands of its first atomic accounting', () => {
  const previousEnvelope = 2 * PER_EMAIL + ORDER_COMPUTE + ORDER_LIBRARY + ORDER_RENEWAL_STOP;
  assert.ok(ORDER_COST - previousEnvelope + 1e-15 >= 23 * COMMAND,
    'the live order coefficient still excludes atomic legacy accounting');
});
