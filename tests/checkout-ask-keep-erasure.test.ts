/**
 * #4290 (Codex X7): an ask already past its limits when the person's erasure runs must not write their address after
 * the erasure finished. The erasure writes the person's print first and then takes their asks (ASK_FORGET), so the
 * ask's own write checks that print in the same step as its two ZADDs. Synthetic store and addresses only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { askIndexKey, askReminder, forgetAskPerson } from '@/lib/checkout-ask';
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { readListing } from '@/lib/catalog';
import { suppressCommand } from '@/lib/suppression';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';

const QUEUE = 'nl:recover:asks';
const PERSON = 'keep-race@example.test';
const OTHER = 'keep-other@example.test';

async function fixture() {
  redis.clear();
  process.env.RESEND_API_KEY = 're_test_keep_race_fixture';
  process.env.STRIPE_SECRET_KEY = 'sk_test_keep_race_fixture';
  globalThis.fetch = async () => { throw Error('no external provider in this regression'); };
  const owner = 'keep-race-owner@example.test';
  await claimHandle(owner, 'askkeeprace', 'Synthetic Store', '');
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, 'acct_1TestKeepRace01', true);
  await setSubscription(owner, { customerId: 'cus_keeprace', subscriptionId: 'sub_keeprace', active: true, tier: 'pro', period: paidPeriod() });
  await setRecovery(owner, { enabled: true, address: 'Synthetic fixture address', asks: true });
  const made = await addProduct(owner, 'Fixture', '', '12', null); assert.ok(made.ok);
  await setProductLink(owner, made.product.id, 'https://example.test/fixture');
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, made.product.id))!;
  return { shop, product };
}

const waitingFor = (email: string) => (redis.run(['ZRANGEBYSCORE', QUEUE, '-inf', '+inf']) as string[]).filter((m) => m.includes(email)).length;

test('an ask in flight when the erasure runs never writes the address after the erasure finished', async () => {
  const { shop, product } = await fixture();
  const index = askIndexKey(shop.statsId!, PERSON);
  const real = redis.pipeline.bind(redis);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atWrite = new Promise<void>((resolve) => { reached = resolve; });
  let paused = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const write = commands.some((c) => (c[0] === 'ZADD' && c[1] === QUEUE) || (c[0] === 'EVAL' && String(c[1]).startsWith('-- marktmorgen:ask-keep:')));
    if (!paused && write) { paused = true; reached(); await held; }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    const asking = askReminder({ store: shop, product, email: PERSON, ip: '203.0.113.71' });
    await atWrite;
    // The erasure: the person's print first, then their asks (lib/person-erasure.ts erasePerson).
    await real([suppressCommand(shop.listId!, PERSON)]);
    assert.equal(await forgetAskPerson(shop.statsId!, PERSON), 0);
    release();
    assert.notEqual(await asking, 'asked', 'an ask the erasure overtook is not said kept');
  } finally {
    release(); redis.pipeline = real;
  }
  assert.deepEqual([waitingFor(PERSON), Number(redis.run(['ZCARD', index]))], [0, 0], 'no address in the queue or the index after the erasure');
});

test('an ask written before the print is taken by the erasure, and another person keeps theirs', async () => {
  const { shop, product } = await fixture();
  assert.equal(await askReminder({ store: shop, product, email: PERSON, ip: '203.0.113.72' }), 'asked');
  assert.equal(await askReminder({ store: shop, product, email: OTHER, ip: '203.0.113.73' }), 'asked');
  await redis.pipeline([suppressCommand(shop.listId!, PERSON)]);
  assert.equal(await forgetAskPerson(shop.statsId!, PERSON), 1);
  assert.deepEqual([waitingFor(PERSON), waitingFor(OTHER)], [0, 1]);
  assert.notEqual(await askReminder({ store: shop, product, email: PERSON, ip: '203.0.113.74' }), 'asked', 'an erased address asking again is not kept');
  assert.equal(waitingFor(PERSON), 0);
});

test('a write whose reply is not exact is never said kept', async () => {
  const { shop, product } = await fixture();
  const real = redis.pipeline.bind(redis);
  for (const reply of [[], [null], ['OK'], [2], [{}]]) {
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.some((c) => c[0] === 'EVAL' && String(c[1]).startsWith('-- marktmorgen:ask-keep:')) ? reply : real(commands)) as typeof redis.pipeline;
    try {
      assert.notEqual(await askReminder({ store: shop, product, email: `odd-${reply.length}@example.test`, ip: '203.0.113.75' }), 'asked');
    } finally {
      redis.pipeline = real;
    }
  }
});
