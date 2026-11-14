// Codex G's proof on #1927 (codex/g-review-1927-history-retention, tests/g1927-history-after-removal.proof.ts), kept as a discovered test with its assertions unchanged.
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
  let boundary = 0, removed = false, forgotten = false, deletedBeforeResume = -1;
  redis.pipeline = async commands => {
    if (!control && boundary === 0 && commands.some(c => c[0] === 'LRANGE' && c[1] === key)) {
      boundary++;
      redis.pipeline = base;
      try {
        const result = await removeFlow(shop, id); removed = result.ok;
        await forgetStoreWorkflows(shop); forgotten = true;
        deletedBeforeResume = Number((await base([['EXISTS', key]]))[0]);
      } finally { redis.pipeline = spy; }
    }
    return base(commands);
  };
  const spy = redis.pipeline;
  let saved: Awaited<ReturnType<typeof saveFlow>>;
  try { saved = await saveFlow(shop, { ...before, steps: before.steps.map(s => ({ ...s, subject: 'New subject' })) }); }
  finally { redis.pipeline = base; }
  if (control) {
    const result = await removeFlow(shop, id); removed = result.ok;
    await forgetStoreWorkflows(shop); forgotten = true;
    deletedBeforeResume = Number((await base([['EXISTS', key]]))[0]);
  }
  const history = await readFlowVersions(shop.listId, id);
  const definitions = await readFlows(shop.listId);
  await forgetStoreWorkflows(shop);
  const afterSecondForget = (await redis.pipeline([['LLEN', key]]))[0];
  console.log('G_HISTORY_AFTER_REMOVAL', JSON.stringify({ control, boundary, saved: saved.ok, removed, forgotten, deletedBeforeResume, definitions: definitions.map(f => f.id), history: history.map(h => h.flow.steps[0].subject), afterSecondForget, charged: redis.run(['HGET', dataKey(shop)!, 'wv:' + id]) }));
  is('real save completed through the admitted workflow writer', saved.ok, true);
  is('real concurrent removal and forgetting completed', [removed, forgotten], [true, true]);
  is('the history was absent before the paused save resumed', deletedBeforeResume, 0);
  is('the exact history boundary was reached when raced', boundary, control ? 0 : 1);
  is('the real workflow definitions stay removed', definitions.length, 0);
  is('a removed workflow cannot regain retained history', history.length, 0);
  is('a later full workflow forget leaves no orphaned history', afterSecondForget, 0);
  done();
}
void main();
