/**
 * A person deleted from the store is never put back on a company (Codex G2's MEDIUM 3 on #2574, raised to HIGH by
 * Claude 1): neither by the undo of a company deleted before the erasure (restore, with the editor's old list of
 * people), nor by a link, nor by a restore whose write lands after the erasure began. The people who were not
 * deleted come back as before. Real route, real erasure; synthetic transport only, no email, no provider.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/companies/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {addCompany,changeCompanies,dropCompany,forgetCompanyPerson,linkPerson,readCompanies,restoreCompany} from '@/lib/crm-companies';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {erasePerson} from '@/lib/person-erasure';
import {personKey} from '@/lib/person-key';
import {isSuppressed} from '@/lib/suppression';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';

const who = 'erased-buyer@example.test';
const kept = 'kept-buyer@example.test';
const id = 'abcdef0123';
const owner = 'erased-companies@example.test';

async function seed() {
  redis.clear();
  assert.equal((await claimHandle(owner, 'erased-companies', 'Synthetic shop', '')).ok, true);
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const paid = await setSubscription(owner, {customerId: 'cus_ErasedCo', subscriptionId: 'sub_ErasedCo', active: true, tier: 'creator', period: paidPeriod()});
  assert.ok(paid?.subscriptionActive);
  const store = await storeForEmail(owner);
  assert.ok(store?.statsId);
  const person = personKey(store.statsId, who);
  const other = personKey(store.statsId, kept);
  assert.ok((await changeCompanies(store.statsId, store, (c) => addCompany(c, {name: 'Synthetic company', website: '', note: ''}, id, 100))).ok);
  assert.ok((await changeCompanies(store.statsId, store, (c) => linkPerson(c, id, person))).ok);
  assert.ok((await changeCompanies(store.statsId, store, (c) => linkPerson(c, id, other))).ok);
  const snapshot = (await readCompanies(store.statsId))[0];
  assert.deepEqual([...snapshot.people].sort(), [person, other].sort());
  return {store, statsId: store.statsId, person, other, snapshot};
}

async function erase(email: string) {
  const store = await storeForEmail(owner);
  assert.ok(store);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error('External transport prohibited in this test');
  };
  try {
    const erased = await erasePerson(store, email, {kind: 'person'});
    assert.ok(erased.ok, JSON.stringify(erased));
  } finally {
    globalThis.fetch = oldFetch;
  }
  const current = await storeForEmail(owner);
  assert.ok(current?.listId);
  assert.equal(await isSuppressed(current.listId, email), true);
}

async function post(body: Record<string, unknown>) {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  return POST(new NextRequest('https://marktmorgen.com/api/store/companies', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(body)}));
}

test('the undo of a company deleted before an erasure never puts the deleted person back; the others come back', async () => {
  const s = await seed();
  assert.ok((await changeCompanies(s.statsId, s.store, (c) => dropCompany(c, id))).ok);
  await erase(who);
  const response = await post({action: 'restore', name: s.snapshot.name, website: s.snapshot.website, note: s.snapshot.note, people: s.snapshot.people});
  const answer = (await response.json()) as {ok: boolean; skipped?: string[]};
  const rows = await readCompanies(s.statsId);
  assert.equal(rows.some((c) => c.people.includes(s.person)), false, JSON.stringify({status: response.status, rows}));
  assert.equal(response.status, 200, JSON.stringify(answer));
  assert.deepEqual(rows.map((c) => c.people), [[s.other]]);
  assert.deepEqual(answer.skipped, [s.person]);
});

test('a link of a deleted person is refused and writes nothing; a person not deleted is still linked', async () => {
  const s = await seed();
  await erase(who);
  assert.deepEqual((await readCompanies(s.statsId)).map((c) => c.people), [[s.other]]);
  const refused = await post({action: 'link', id, person: s.person});
  assert.notEqual(refused.status, 200);
  assert.equal((await readCompanies(s.statsId)).some((c) => c.people.includes(s.person)), false);
  assert.ok((await changeCompanies(s.statsId, s.store, (c) => addCompany(c, {name: 'Second company', website: '', note: ''}, 'bbbbbbbbbb', 101))).ok);
  const moved = await post({action: 'link', id: 'bbbbbbbbbb', person: s.other});
  assert.equal(moved.status, 200);
  assert.deepEqual((await readCompanies(s.statsId)).find((c) => c.id === 'bbbbbbbbbb')?.people, [s.other]);
});

test('a restore whose write lands after the erasure began writes nothing', async () => {
  const s = await seed();
  assert.ok((await changeCompanies(s.statsId, s.store, (c) => dropCompany(c, id))).ok);
  const original = redis.pipeline.bind(redis);
  let struck = false;
  redis.pipeline = async (commands) => {
    if (!struck && commands[0]?.[0] === 'EVAL' && String(commands[0][1]).startsWith('-- marktmorgen:crm-companies-write:')) {
      struck = true;
      // The erasure's step for the companies starts while the restore holds the lock: it cannot take it, and the
      // deletion is said not done, but the person is already marked as deleted from the store.
      await forgetCompanyPerson(s.statsId, s.person, 0).catch(() => 0);
    }
    return original(commands);
  };
  let result;
  try {
    result = await changeCompanies(s.statsId, s.store, (c) => restoreCompany(c, {name: s.snapshot.name, website: s.snapshot.website, note: s.snapshot.note}, 'cccccccccc', 102, s.snapshot.people));
  } finally {
    redis.pipeline = original;
  }
  assert.equal(struck, true);
  assert.equal((await readCompanies(s.statsId)).some((c) => c.people.includes(s.person)), false, JSON.stringify(result));
  assert.equal(result.ok, false);
});
