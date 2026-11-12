import assert from 'node:assert/strict';
import test from 'node:test';
import { takePlace, type Group } from '@/lib/group-buy';
import { addressHash, importedKey } from '@/lib/imported-purchases';
import type { Store } from '@/lib/store';
import { store as redis } from './redis-stub';

const group: Group = { id: 'grp_' + 'a'.repeat(24), s: 'stats_fixture', p: 'product_fixture', people: 2, at: 1, paid: 1 };
const shop = { sid: 'b'.repeat(32), statsId: group.s, handle: 'fixture', pastBuyers: true } as Store;
const email = 'buyer@example.test', token = 'c'.repeat(64);
const members = `nl:grp:${group.id}:m`, who = addressHash(email);
async function seed(mark: string) {
  redis.clear();
  await redis.pipeline([
    ['SET', `nl:grp:${group.id}`, JSON.stringify(group)],
    ['SET', `nl:grp:take:${token}`, JSON.stringify({ g: group.id, e: email })],
    ['HSET', members, who, mark],
    ['HSET', importedKey(group.s, email), group.p, JSON.stringify({ job: `group:${group.id}`, at: Math.floor(Date.now() / 1000), items: null })],
  ]);
}

for (const mark of ['{"d":1}', '{"e":"buyer@example.test","at":-1,"d":1}', '{"e":"buyer@example.test","at":"unknown","d":1}']) {
  test(`invalid completion evidence ${mark} cannot acknowledge a completed paid place`, async () => {
    await seed(mark);
    let result: unknown, threw = false, starts = 0;
    try { result = await takePlace({ store: shop, token, recordStart: async () => { starts += 1; } }); }
    catch { threw = true; }
    console.log(JSON.stringify({ mark, result, starts }));
    assert.equal(threw, true, 'Malformed completion evidence is unknown, not proof that enrollment and order accounting finished');
    assert.equal((await redis.pipeline([['HGET', members, who]]))[0], mark, 'Unknown completion evidence must stay available for recovery');
  });
}

test('a complete mark preserves the read-only already outcome', async () => {
  await seed(JSON.stringify({ e: email, at: 1, d: 1 }));
  let starts = 0;
  const result = await takePlace({ store: shop, token, recordStart: async () => { starts += 1; } });
  assert.equal(result.outcome, 'already');
  assert.equal(starts, 0);
});
