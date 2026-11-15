import assert from 'node:assert/strict';
import test from 'node:test';
import { takePlace, type Group } from '@/lib/group-buy';
import { addressHash, importedKey, importedFor } from '@/lib/imported-purchases';
import type { Store } from '@/lib/store';
import { store as redis } from './redis-stub';

const email = 'buyer@example.test', token = 'c'.repeat(64);
const group: Group = { id: 'grp_' + 'a'.repeat(24), s: 'stats_fixture', p: 'product_fixture', people: 2, at: 1, paid: 1, h: Math.floor(Date.now() / 3_600_000) };
const shop = { sid: 'b'.repeat(32), statsId: group.s, handle: 'fixture', pastBuyers: true } as Store;
const members = `nl:grp:${group.id}:m`, who = addressHash(email), imported = importedKey(group.s, email);
const pipeline = redis.pipeline.bind(redis);

async function open(removeConcurrentGrant: boolean) {
  redis.clear();
  await pipeline([
    ['SET', `nl:grp:${group.id}`, JSON.stringify(group)],
    ['SET', `nl:grp:take:${token}`, JSON.stringify({ g: group.id, e: email })],
  ]);
  let intercepted = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const grantWrite = commands.some(c => c[0] === 'EVAL' && String(c[1]).includes('marktmorgen:order-write:v1') && c.includes(imported));
    if (!grantWrite) return pipeline(commands);
    intercepted += 1;
    // A concurrent valid grant wins HSETNX, then is revoked before the fallback read.
    await pipeline([['HSET', imported, group.p, JSON.stringify({ job: 'gift:fixture', at: 100, items: null })]]);
    const result = await pipeline(commands);
    if (removeConcurrentGrant) await pipeline([['HDEL', imported, group.p]]);
    return result;
  }) as typeof redis.pipeline;
  let result: Awaited<ReturnType<typeof takePlace>> | undefined, threw = false;
  try { result = await takePlace({ store: shop, token, recordStart: async () => { throw new Error('Unexpected delivery'); } }); }
  catch { threw = true; }
  finally { redis.pipeline = pipeline; }
  return { result, threw, intercepted, marked: (await pipeline([['HEXISTS', members, who]]))[0], visible: (await importedFor(shop, email)).length };
}

test('an absent fallback grant cannot certify ownership elsewhere or erase the pending place', async () => {
  const got = await open(true);
  console.log(JSON.stringify(got));
  assert.equal(got.intercepted, 1, 'The real grant HSETNX must be reached');
  assert.equal(got.visible, 0, 'The concurrent grant was actually revoked before the fallback HGET');
  assert.equal(got.threw, true, 'Explicit absence is not a valid grant authorizing has');
  assert.equal(got.marked, 1, 'A missing grant cannot free this pending paid place');
});

test('a valid concurrent grant retains the existing has outcome', async () => {
  const got = await open(false);
  assert.equal(got.intercepted, 1);
  assert.equal(got.result?.outcome, 'has');
  assert.equal(got.threw, false);
  assert.equal(got.marked, 0);
  assert.equal(got.visible, 1);
});
