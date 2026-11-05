import assert from 'node:assert/strict';
import test from 'node:test';
import { takePlace, type Group } from '@/lib/group-buy';
import { addressHash, importedKey } from '@/lib/imported-purchases';
import type { Store } from '@/lib/store';
import { store as redis, advance } from './redis-stub';

test('cleanup cannot remove a successor hold acquired between its GET and DEL', async () => {
  const email = 'buyer@example.test', token = 'c'.repeat(64);
  const group: Group = { id: 'grp_' + 'a'.repeat(24), s: 'stats_fixture', p: 'product_fixture', people: 2, at: 1, paid: 1 };
  const shop = { sid: 'b'.repeat(32), statsId: group.s, handle: 'fixture', email: 'owner@example.test', pastBuyers: true } as Store;
  const who = addressHash(email), members = `nl:grp:${group.id}:m`, opening = `nl:grp:${group.id}:t:${who}`;
  const pipeline = redis.pipeline.bind(redis);
  redis.clear();
  await pipeline([
    ['SET', `nl:grp:${group.id}`, JSON.stringify(group)],
    ['SET', `nl:grp:take:${token}`, JSON.stringify({ g: group.id, e: email })],
    ['HSET', members, who, JSON.stringify({ e: email, at: Math.floor(Date.now() / 1000) })],
    ['HSET', importedKey(group.s, email), group.p, JSON.stringify({ job: `group:${group.id}`, at: Math.floor(Date.now() / 1000), items: null })],
  ]);
  let enterSuccessor!: () => void, releaseSuccessor!: () => void;
  const entered = new Promise<void>(r => { enterSuccessor = r; });
  const release = new Promise<void>(r => { releaseSuccessor = r; });
  let successor: Promise<Awaited<ReturnType<typeof takePlace>>> | undefined;
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const splitRelease = commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === opening;
    const atomicRelease = commands.some(c => c[0] === 'EVAL' && c.includes(opening) && String(c[1]).includes('GET') && String(c[1]).includes('DEL'));
    if (!raced && (splitRelease || atomicRelease)) {
      raced = true;
      // For split cleanup, GET already saw the old token. For atomic cleanup,
      // the successor acquires before the indivisible compare-and-delete.
      const result = splitRelease ? await pipeline(commands) : undefined;
      advance(31_000);
      successor = takePlace({ store: shop, token, recordStart: async () => { enterSuccessor(); await release; } });
      await entered;
      return splitRelease ? result : pipeline(commands);
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  let firstThrew = false, thirdStarted = false, successorHold: unknown;
  try {
    try { await takePlace({ store: shop, token, recordStart: async () => { throw new Error('First open interrupted before completion'); } }); }
    catch { firstThrew = true; }
    successorHold = (await pipeline([['GET', opening]]))[0];
    // The successor is still in recordStart. A third open must not enter.
    await takePlace({ store: shop, token, recordStart: async () => { thirdStarted = true; } }).catch(() => undefined);
  } finally {
    releaseSuccessor();
    await successor;
    redis.pipeline = pipeline;
  }
  console.log(JSON.stringify({ firstThrew, raced, successorHold, thirdStarted }));
  assert.equal(firstThrew, true);
  assert.equal(raced, true);
  assert.equal(thirdStarted, false, 'Cleanup must not let a third open enter while its successor is still completing the paid place');
  assert.equal(typeof successorHold, 'string', 'The successor hold must remain until its own completion');
});

test('a known live hold still prevents a second completion', async () => {
  redis.clear();
  const email = 'buyer@example.test', token = 'c'.repeat(64);
  const group: Group = { id: 'grp_' + 'a'.repeat(24), s: 'stats_fixture', p: 'product_fixture', people: 2, at: 1, paid: 1 };
  const opening = `nl:grp:${group.id}:t:${addressHash(email)}`;
  await redis.pipeline([
    ['SET', `nl:grp:${group.id}`, JSON.stringify(group)],
    ['SET', `nl:grp:take:${token}`, JSON.stringify({ g: group.id, e: email })],
    ['SET', opening, 'successor', 'EX', 30],
  ]);
  let starts = 0;
  await assert.rejects(takePlace({ store: { sid: 'b'.repeat(32), statsId: group.s, handle: 'fixture' } as Store, token, recordStart: async () => { starts += 1; } }));
  assert.equal(starts, 0);
  assert.equal((await redis.pipeline([['GET', opening]]))[0], 'successor');
});
