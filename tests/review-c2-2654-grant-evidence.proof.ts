import assert from 'node:assert/strict';
import test from 'node:test';
import { takePlace, type Group } from '@/lib/group-buy';
import { addressHash, importedKey, importedFor } from '@/lib/imported-purchases';
import type { Store } from '@/lib/store';
import { store as redis } from './redis-stub';

const group: Group = { id: 'grp_' + 'a'.repeat(24), s: 'stats_fixture', p: 'product_fixture', people: 2, at: 1, paid: 1 };
const shop = { sid: 'b'.repeat(32), statsId: group.s, handle: 'fixture', pastBuyers: true } as Store;
const email = 'buyer@example.test', token = 'c'.repeat(64);
const members = `nl:grp:${group.id}:m`, who = addressHash(email);
async function seed(raw: string) {
  redis.clear();
  await redis.pipeline([
    ['SET', `nl:grp:${group.id}`, JSON.stringify(group)],
    ['SET', `nl:grp:take:${token}`, JSON.stringify({ g: group.id, e: email })],
    ['HSET', members, who, JSON.stringify({ e: email, at: 1 })],
    ['HSET', importedKey(group.s, email), group.p, raw],
  ]);
}

for (const raw of ['{broken', 'null', '[]']) {
  test(`unknown grant ${raw} must preserve its pending place and refuse a completed outcome`, async () => {
    await seed(raw);
    let result: unknown, threw = false;
    try { result = await takePlace({ store: shop, token, recordStart: async () => { throw new Error('Unexpected delivery'); } }); }
    catch { threw = true; }
    const [marked] = await redis.pipeline([['HEXISTS', members, who]]);
    console.log(JSON.stringify({ raw, result, marked, visiblePurchases: (await importedFor(shop, email)).length }));
    assert.equal(threw, true, 'Malformed grant evidence is unknown, not ownership confirmed elsewhere');
    assert.equal(marked, 1, 'Unknown evidence must not free a pending paid place');
  });
}

test('a complete grant from another source preserves the existing has outcome', async () => {
  await seed(JSON.stringify({ job: 'gift:fixture', at: 100, items: null }));
  const result = await takePlace({ store: shop, token, recordStart: async () => { throw new Error('Unexpected delivery'); } });
  assert.equal(result.outcome, 'has');
  assert.equal((await redis.pipeline([['HEXISTS', members, who]]))[0], 0);
});
