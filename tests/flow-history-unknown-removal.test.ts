// Codex G's proof on #1927 (codex/g-review-1927-history-retention, tests/g1927-history-unknown-removal.proof.ts), kept as a discovered test with its assertions unchanged.
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
  await saveFlow(shop, { ...before, steps: before.steps.map(s => ({ ...s, subject: 'New subject' })) });
  const initial = (await redis.pipeline([["LLEN", key]]))[0];
  const base = redis.pipeline.bind(redis); let injected = 0, unconfirmed = false;
  const control = process.env.G_ERASE_RACE === 'control';
  redis.pipeline = async commands => {
    if (!control && commands.some(c => (c[0] === 'EVAL' && String(c[1]).startsWith('-- marktmorgen:flow-version-drop:') && c[3] === key) || (c[0] === 'DEL' && c[1] === key))) { injected++; return []; }
    return base(commands);
  };
  try { const removed = await removeFlow(shop, id); unconfirmed = !removed.ok; }
  catch { unconfirmed = true; }
  finally { redis.pipeline = base; }
  await forgetStoreWorkflows(shop);
  const definitions = await readFlows(shop.listId), remaining = (await redis.pipeline([["LLEN", key]]))[0];
  console.log('G_HISTORY_UNKNOWN_DELETE', JSON.stringify({ control, initial, injected, unconfirmed, definitions: definitions.map(f => f.id), remaining }));
  is('fixture has real retained history before removing it', initial, 1);
  is('the actual unapplied history delete was intercepted', injected, control ? 0 : 1);
  is('unknown delete is reported as unconfirmed, healthy removal completes', unconfirmed, !control);
  is('the removal does not restore the active workflow', definitions.length, 0);
  is('later full forgetting finds and deletes any retained history', remaining, 0);
  done();
}
void main();
