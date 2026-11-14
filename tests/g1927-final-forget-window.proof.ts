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
  const control = process.env.G_ERASE_RACE === 'control';
  let reachedRead!: () => void, resumeRead!: () => void;
  const reading = new Promise<void>(resolve => { reachedRead = resolve; });
  const resume = new Promise<void>(resolve => { resumeRead = resolve; });
  let readBoundary = 0, finalBoundary = 0, beforeResume = -1;
  let saving!: Promise<Awaited<ReturnType<typeof saveFlow>>>;
  redis.pipeline = async commands => {
    if (!control && readBoundary === 0 && commands.some(c => c[0] === 'LRANGE' && c[1] === key)) {
      readBoundary++; reachedRead(); await resume;
    }
    if (!control && finalBoundary === 0 && commands.some(c => c[0] === 'DEL' && c[1] === `nl:mail:flows:${shop.listId}`)) {
      finalBoundary++;
      beforeResume = Number((await base([['EXISTS', key]]))[0]);
      resumeRead();
      await saving;
    }
    return base(commands);
  };
  let saved: Awaited<ReturnType<typeof saveFlow>>;
  try {
    saving = saveFlow(shop, { ...before, steps: before.steps.map(s => ({ ...s, subject: 'New subject' })) });
    if (!control) await reading; else await saving;
    await forgetStoreWorkflows(shop);
    saved = await saving;
  } finally { redis.pipeline = base; }
  const definitions = await readFlows(shop.listId);
  const history = await readFlowVersions(shop.listId, id);
  const indexed = (await base([['SMEMBERS', `nl:wf:ver:idx:${shop.listId}`]]))[0];
  await forgetStoreWorkflows(shop);
  const afterSecondForget = (await base([['LLEN', key]]))[0];
  console.log('G_HISTORY_FINAL_ERASE_WINDOW', JSON.stringify({ control, readBoundary, finalBoundary, beforeResume, saved: saved.ok, definitions: definitions.length, history: history.map(h => h.flow.steps[0].subject), indexed, afterSecondForget, charged: redis.run(['HGET', dataKey(shop)!, 'wv:' + id]) }));
  is('the real save completed', saved.ok, true);
  is('the exact pre-final-DEL window was reached', [readBoundary, finalBoundary, beforeResume], control ? [0, 0, -1] : [1, 1, 0]);
  is('the definitions are gone after full workflow forgetting completes', definitions.length, 0);
  is('full workflow forgetting leaves no late history', history.length, 0);
  is('a second workflow forget removes indexed remnants', afterSecondForget, 0);
  done();
}
void main();
