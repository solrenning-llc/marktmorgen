/** CX-113: the live legacy receipt and Lua belong to the actual order envelope. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, partAverage, partPeak } from './store-data-registry';
import { COMMAND, DB_BYTE, ORDER_COST, ORDER_COMPUTE, ORDER_LIBRARY, ORDER_RENEWAL_STOP, PER_EMAIL } from './plan-cost-registry';
import { COMMIT_ORDER_CONFIRMATION, COUNT_STUCK_LEGACY_CHECKOUT } from '@/lib/orders';

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
  const folder = 'a'.repeat(32), receipt = 'oc1:' + 'a'.repeat(64);
  const wire = JSON.stringify([['EVAL', COMMIT_ORDER_CONFIRMATION, 6,
    'nl:orders:seen:' + folder, `nl:orders:n:${folder}:2026-11-01`,
    `nl:orders:open:${folder}`, `nl:orders:bytes:${folder}`,
    'nl:orders:folders:2026-11', `nl:store:folder-owner:${folder}`,
    receipt, '999999999', 1000000000, 1, folder, 'a'.repeat(320),
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 34560000]]);
  assert.ok(Buffer.byteLength(wire) + 32 <= 8192, 'the full serialized command and scalar reply fit the allocation');
  assert.ok(ORDER_COST - previousEnvelope + 1e-15 >= 23 * COMMAND + 8192 * DB_BYTE,
    'the live coefficient covers transfer as well as the Lua commands');
});

test("a stuck paid checkout's way out (Codex's MEDIUM on #3667) is inside the same order line: 27 commands, 10,240 bytes", () => {
  const previousEnvelope = 2 * PER_EMAIL + ORDER_COMPUTE + ORDER_LIBRARY + ORDER_RENEWAL_STOP;
  // The ordinary refusal before it and the stuck count, at their worst, with the owner at its longest and every
  // character escaped by JSON (\u0001 is six bytes): the two serialized requests plus a scalar reply each.
  const folder = 'a'.repeat(32), owner = '\u0001'.repeat(320);
  const ordinary = JSON.stringify([['EVAL', COMMIT_ORDER_CONFIRMATION, 6,
    'nl:orders:seen:' + folder, `nl:orders:n:${folder}:2026-11-01`,
    `nl:orders:open:${folder}`, `nl:orders:bytes:${folder}`,
    'nl:orders:folders:2026-11', `nl:store:folder-owner:${folder}`,
    'oc1:' + 'a'.repeat(64), '999999999', 1000000000, 1, folder, owner,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 34560000]]);
  const stuck = JSON.stringify([['EVAL', COUNT_STUCK_LEGACY_CHECKOUT, 4,
    'nl:orders:seen:' + folder, `nl:orders:n:${folder}:2026-11-01`,
    'nl:orders:folders:2026-11', `nl:store:folder-owner:${folder}`,
    'ocf:' + 'a'.repeat(64), folder, owner, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 34560000]]);
  assert.ok(Buffer.byteLength(ordinary) + Buffer.byteLength(stuck) + 2 * 32 <= 10_240,
    'both serialized commands and scalar replies fit the allocation');
  // 14 + 13 measured on real Redis (scripts/test_legacy_order_accounting_redis.py, stuck_main).
  assert.ok(ORDER_COST - previousEnvelope + 1e-15 >= 27 * COMMAND + 10_240 * DB_BYTE,
    'the live coefficient covers the stuck path as well as the ordinary commit');
});
