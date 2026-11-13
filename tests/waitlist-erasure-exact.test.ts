/**
 * Defect #4383 (Codex L): erasing a person from the store's waitlists reads
 * each product's HDEL exactly. One reply per product, each the integer 0 or
 * 1; a short, sparse or off-shape answer is unknown (rule 24) and throws
 * UnknownReplyError, so the erasure is never reported complete while an
 * entry holding the address may still be there to be copied into a launch.
 * Synthetic records only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {forgetWaitlistPerson} from '@/lib/waitlist';
import {UnknownReplyError} from '@/lib/redis-reply';
import {store as redis} from './redis-stub';

const sid = 'abcdef0124';
const products = ['p1', 'p2'];
const address = 'erased-waitlist@example.test';
type Batch = (string | number)[][];

async function seed() {
  redis.clear();
  for (const p of products) await redis.pipeline([['HSET', `nl:wl:${sid}:${p}`, address, JSON.stringify({at: 1, ok: 1, c: false})]]);
}

/** Answers the first all-HDEL batch with `shaped(original replies)`; every other batch as Redis would. */
function shapeHdel(shaped: (replies: unknown[]) => unknown) {
  const original = redis.pipeline.bind(redis);
  let hit = false;
  (redis as unknown as {pipeline: unknown}).pipeline = async (batch: Batch) => {
    const replies = (await original(batch)) as unknown[];
    if (!hit && batch.length && batch.every((c) => c[0] === 'HDEL')) {
      hit = true;
      return shaped(replies);
    }
    return replies;
  };
  return {restore: () => ((redis as unknown as {pipeline: unknown}).pipeline = original), hit: () => hit};
}

const cases: [string, (r: unknown[]) => unknown][] = [
  ['one reply short', (r) => r.slice(0, 1)],
  ['a hole where a reply should be', (r) => { const s = r.slice(); delete s[1]; return s; }],
  ['a reply as text', (r) => [r[0], '1']],
  ['a reply of two', (r) => [r[0], 2]],
  ['a reply that is null', (r) => [r[0], null]],
  ['not a list at all', () => null],
];

for (const [what, shaped] of cases) {
  test(`waitlist erasure with ${what}: unknown, never complete`, async () => {
    await seed();
    const patch = shapeHdel(shaped);
    let outcome: unknown;
    try {
      outcome = await forgetWaitlistPerson(sid, products, address).then((n) => n, (e: unknown) => e);
    } finally {
      patch.restore();
    }
    assert.equal(patch.hit(), true, 'the HDEL batch was sent');
    assert.ok(outcome instanceof UnknownReplyError, `an unknown deletion throws, not ${JSON.stringify(outcome)}`);
  });
}

test('waitlist erasure read whole: each entry counted once', async () => {
  await seed();
  assert.equal(await forgetWaitlistPerson(sid, products, address), 2);
  assert.equal(await forgetWaitlistPerson(sid, products, address), 0, 'nothing left the second time');
});
