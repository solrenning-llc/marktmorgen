// G: exercise real workflow/person erasure; no records, counters or indexes are forged.
import { saveFlow, forgetWorkflowPerson } from '@/lib/flows';
import { openRuns, personOf, readRun } from '@/lib/flow-runs';
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';

globalThis.fetch = async () => { throw Error('No external provider in this proof'); };
async function main() {
  redis.clear();
  const owner = 'g-erase-arity@example.test', email = 'synthetic-person@example.test';
  await claimHandle(owner, 'g-erase-arity', 'Synthetic workflow', '');
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, 'acct_GArity', true);
  await setSubscription(owner, { customerId: 'cus_GArity', subscriptionId: 'sub_GArity', active: true, tier: 'pro', period: paidPeriod() });
  await setMailSettings(owner, { fromName: 'Synthetic sender', address: 'SYNTHETIC ADDRESS' });
  const shop = (await storeForEmail(owner))!;
  const saved = await saveFlow(shop, { name: 'Arity', trigger: 'joined', steps: [{ delayHours: 0, subject: 'Subject', body: 'Body' }] });
  if (!saved.ok) throw Error('Real workflow fixture failed');
  const id = saved.flows[0].id, person = personOf(email), index = `nl:wf:runs:${id}`;
  await openRuns(id, [email]);
  is('real writer created the run and its first history event', (await readRun(id, person))?.events.length, 1);
  const base = redis.pipeline.bind(redis);
  const healthy = process.env.G_ARITY_MODE === 'healthy';
  let dualDeletes = 0, dualCount = -1, intercepted = 0, completed = false;
  redis.pipeline = async commands => {
    const replies: unknown[] = [];
    for (const c of commands) {
      if (c[0] === 'ZREM' && c[1] === index && !healthy && intercepted === 0) {
        if (c.length !== 3) throw Error('The targeted ZREM must name exactly one member');
        intercepted++; replies.push(2); // ONLY this command is unapplied and its count impossible.
      } else {
        const receipt = (await base([c]))[0];
        if (c[0] === 'DEL' && c.length === 3 && String(c[1]).startsWith(`nl:wf:run:${id}:`)) { dualDeletes++; dualCount = Number(receipt); }
        replies.push(receipt);
      }
    }
    return replies;
  };
  try { await forgetWorkflowPerson(shop, email); completed = true; }
  catch { completed = false; }
  finally { redis.pipeline = base; }
  const remaining = (await base([['ZREVRANGE', index, 0, -1]]))[0];
  is('the real two-key DEL ran once and legitimately removed both keys', [dualDeletes, dualCount], [1, 2]);
  is('only the one-member ZREM was made unknown', intercepted, healthy ? 0 : 1);
  is('an overcount cannot confirm erasure; healthy arity accepts its actual receipts', completed, healthy);
  is('the unapplied index deletion remains observable', remaining, healthy ? [] : [person]);
  await forgetWorkflowPerson(shop, email);
  is('a later confirmed retry removes the retained member', (await base([['ZREVRANGE', index, 0, -1]]))[0], []);
  console.log('G_ERASE_ARITY', JSON.stringify({ healthy, dualDeletes, dualCount, intercepted, completed, remaining }));
  done();
}
void main();
