// G identified same-byte assertion variant: DEL addresses ONE key, so count2 is an impossible receipt. Only this unapplied reply changes from null to2.
// Based on G original null-receipt proof; here the unapplied one-key DEL returns count2. No stored data or counters forged.
import { saveFlow, removeFlow, forgetStoreWorkflows, readFlows } from '@/lib/flows';
import { readFlowVersions } from '@/lib/flow-versions';
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { dataKey } from '@/lib/store-data';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';

globalThis.fetch = async () => { throw Error('No external provider in this proof'); };
async function main() {
  redis.clear();
  const owner = 'g-history-race@example.test';
  await claimHandle(owner, 'g-history-race', 'Synthetic workflow', '');
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, 'acct_GHistoryRace', true);
  await setSubscription(owner, { customerId: 'cus_GHistoryRace', subscriptionId: 'sub_GHistoryRace', active: true, tier: 'pro', period: paidPeriod() });
  await setMailSettings(owner, { fromName: 'Synthetic sender', address: 'SYNTHETIC ADDRESS' });
  const shop = (await storeForEmail(owner))!;
  const first = await saveFlow(shop, { name: 'Synthetic workflow', trigger: 'joined', steps: [{ delayHours: 0, subject: 'Original subject', body: 'Original content retained in history.' }] });
  if (!first.ok) throw Error('fixture workflow unavailable');
  const before = first.flows[0]; const id = before.id;
  const key = `nl:wf:ver:${shop.listId}:${id}`;
  const base = redis.pipeline.bind(redis);
  const control = process.env.G_ERASE_ACK === 'healthy';
  let reached!: () => void, release!: () => void;
  const atRead = new Promise<void>(r => { reached = r; });
  const resume = new Promise<void>(r => { release = r; });
  let paused = 0, faulty = 0, completed = false;
  redis.pipeline = async commands => {
    if (paused === 0 && commands.some(c => c[0] === 'LRANGE' && c[1] === key)) {
      paused++; reached(); await resume;
    }
    if (!control && faulty === 0 && commands.some(c => c[0] === 'DEL' && c[1] === `nl:mail:flows:${shop.listId}`)) {
      faulty++;
      const result: unknown[] = [];
      for (const c of commands) {
        if (c[0] === 'DEL' && c[1] === `nl:mail:flows:${shop.listId}`) { if (c.length !== 2) throw Error('The overcount proof requires DEL of exactly one key'); result.push(2); } // only this DEL unapplied, unknown own slot
        else result.push((await base([c]))[0]);
      }
      return result;
    }
    return base(commands);
  };
  const saving = saveFlow(shop, { ...before, steps: before.steps.map(s => ({ ...s, subject: 'New subject' })) });
  await atRead;
  try { await forgetStoreWorkflows(shop); completed = true; }
  catch { completed = false; }
  release();
  let saved: Awaited<ReturnType<typeof saveFlow>>;
  try { saved = await saving; } finally { redis.pipeline = base; }
  const definitions = await readFlows(shop.listId);
  const history = await readFlowVersions(shop.listId, id);
  const indexed = (await base([['SMEMBERS', `nl:wf:ver:idx:${shop.listId}`]]))[0];
  console.log('G_UNKNOWN_DEFINITION_DELETE', JSON.stringify({ control, paused, faulty, completed, saved: saved.ok, definitions: definitions.map(f => f.id), history: history.map(h => h.flow.steps[0].subject), indexed }));
  is('G: real save was paused at its history read', paused, 1);
  is('G: only the actual definition DEL was made unknown without applying it', faulty, control ? 0 : 1);
  is('G: the admitted real save completed', saved.ok, true);
  is('G: unknown definition deletion cannot be reported as completed forgetting', completed, control);
  is('G: healthy confirmed forgetting prevents the old save retaining history', control ? history.length : true, control ? 0 : true);
  await forgetStoreWorkflows(shop);
  is('G: a later confirmed retry removes both definitions and history', [(await readFlows(shop.listId)).length, (await readFlowVersions(shop.listId, id)).length], [0, 0]);
  done();
}
void main();
