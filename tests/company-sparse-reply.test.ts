/**
 * Codex X5's MEDIUM on #4026 @3d558ff08e: a Redis reply of the right length with a missing position (a hole in a
 * sparse array) must never be read. `every` skips holes, so the MGET of the deletion marks passed, and the hole was
 * read as a mark: a person never confirmed deleted was taken as erased (a link refused, a restore saved without
 * them). The same holds for the companies' HGETALL pairs, where a hole was read as a record. A hole ends the
 * operation as an unknown read (CompaniesUnreadable), with nothing written. Synthetic records only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {CompaniesUnreadable,addCompany,changeCompanies,linkPerson,readCompanies} from '@/lib/crm-companies';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {personKey} from '@/lib/person-key';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';

const owner = 'sparse-companies@example.test';
const id = 'abcdef0124';

async function seed() {
  redis.clear();
  assert.equal((await claimHandle(owner, 'sparse-companies', 'Synthetic shop', '')).ok, true);
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  assert.ok((await setSubscription(owner, {customerId: 'cus_SparseCo', subscriptionId: 'sub_SparseCo', active: true, tier: 'creator', period: paidPeriod()}))?.subscriptionActive);
  const store = await storeForEmail(owner);
  assert.ok(store?.statsId);
  assert.ok((await changeCompanies(store.statsId, store, (c) => addCompany(c, {name: 'Synthetic company', website: '', note: ''}, id, 100))).ok);
  return store;
}

type Batch = (string | number)[][];

/** Answers the first command named `name` with `holed(original reply)`; every other command as Redis would. */
function holeIn(name: string, holed: (reply: unknown) => unknown) {
  const original = redis.pipeline.bind(redis);
  let hit = false;
  (redis as unknown as {pipeline: unknown}).pipeline = async (batch: Batch) => {
    const replies = (await original(batch)) as unknown[];
    if (!hit && batch.length === 1 && batch[0][0] === name) {
      hit = true;
      return [holed(replies[0])];
    }
    return replies;
  };
  return {restore: () => ((redis as unknown as {pipeline: unknown}).pipeline = original), hit: () => hit};
}

test('a deletion-mark MGET with a hole is unknown, never "erased"', async () => {
  const store = await seed();
  const person = personKey(store.statsId!, 'never-deleted@example.test');
  const patch = holeIn('MGET', (reply) => new Array(Array.isArray(reply) ? reply.length : 1));
  let outcome: unknown;
  try {
    outcome = await changeCompanies(store.statsId!, store, (c) => linkPerson(c, id, person)).then((r) => r, (e: unknown) => e);
  } finally {
    patch.restore();
  }
  assert.equal(patch.hit(), true, 'the marks were read');
  assert.ok(outcome instanceof CompaniesUnreadable, `a hole is an unknown read, not ${JSON.stringify(outcome)}`);
  const after = await readCompanies(store.statsId!);
  assert.equal(after.find((c) => c.id === id)?.people.includes(person), false, 'nothing was written');
  // Read whole again, the link goes through: the person was never deleted.
  assert.ok((await changeCompanies(store.statsId!, store, (c) => linkPerson(c, id, person))).ok);
});

test("the companies' HGETALL with a hole is unknown, never a record", async () => {
  const store = await seed();
  const patch = holeIn('HGETALL', (reply) => {
    const pairs = Array.isArray(reply) ? reply.slice() : [];
    delete pairs[1];
    return pairs;
  });
  let outcome: unknown;
  try {
    outcome = await readCompanies(store.statsId!).then((r) => r, (e: unknown) => e);
  } finally {
    patch.restore();
  }
  assert.equal(patch.hit(), true, 'the companies were read');
  assert.ok(outcome instanceof CompaniesUnreadable, `a hole is an unknown read, not ${JSON.stringify(outcome)}`);
});
