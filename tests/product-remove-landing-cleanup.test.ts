// Codex G's proof on #1947 (codex/g-review-1947-product-cleanup@15763ba2, tests/g1947-product-cleanup.proof.ts), kept as a discovered test with its assertions unchanged (its default mode, a deletion answered but not applied).
// G extends G2's unknown-deletion case to the real authenticated product-removal consumer.
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/store/product/route';
import { SESSION_COOKIE, openSession } from '@/lib/auth';
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductPage, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { readListing } from '@/lib/catalog';
import { DROP_LANDINGS, dropLandings, saveLanding } from '@/lib/campaign-landing-store';
import { EMPTY_PAGE, emptyBlock } from '@/lib/sales-page';
import { writePage } from '@/lib/sales-page-store';
import { dataKey } from '@/lib/store-data';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';

globalThis.fetch = async () => { throw Error('No external provider in this proof'); };
async function main() {
  redis.clear();
  const owner = 'g-landing-cleanup@example.test';
  await claimHandle(owner, 'g-landing-cleanup', 'Synthetic store', '');
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, 'acct_GLandingCleanup', true);
  await setSubscription(owner, { customerId: 'cus_GLandingCleanup', subscriptionId: 'sub_GLandingCleanup', active: true, tier: 'pro', period: paidPeriod() });
  const made = await addProduct(owner, 'Synthetic course', '', '19', null);
  if (!made.ok) throw Error('Real product fixture failed');
  const id = made.product.id;
  const marked = await setProductPage(owner, id, true);
  if (!marked.ok) throw Error('Real product page fixture failed');
  const shop = (await storeForEmail(owner))!;
  await writePage(shop.statsId!, id, { ...EMPTY_PAGE, blocks: [emptyBlock('hero')] }, shop);
  await saveLanding(shop.statsId!, id, { campaign: 'synthetic', headline: 'Synthetic course', sub: 'Known campaign content', button: 'Read more' }, shop);
  const key = `nl:product:landing:${shop.statsId}:${id}`;
  const base = redis.pipeline.bind(redis);
  const before = (await base([['GET', key]]))[0];
  const slotBefore = (await base([['HGET', dataKey(shop)!, `al:${id}`]]))[0];
  const mode = process.env.G_LANDING_DROP ?? 'unapplied';
  const session = await openSession(owner);
  const remove = async () => {
    const response = await POST(new NextRequest('https://marktmorgen.com/api/store/product', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://marktmorgen.com', host: 'marktmorgen.com', cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: 'remove', id }),
    }));
    return { status: response.status, body: await response.json() as { ok?: boolean; error?: string; cleanupPending?: boolean } };
  };
  let attempted = 0;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === 'EVAL' && c[1] === DROP_LANDINGS && c[4] === key)) {
      attempted++;
      if (mode === 'lost') { await base(commands); return []; }
      if (mode === 'unapplied') return [];
    }
    return base(commands);
  };
  let result: Awaited<ReturnType<typeof remove>>;
  try { result = await remove(); }
  finally { redis.pipeline = base; }
  const retained = (await base([['GET', key]]))[0];
  const slotAfter = (await base([['HGET', dataKey(shop)!, `al:${id}`]]))[0];
  is('the real writers created campaign content and a counted slot', typeof before === 'string' && typeof slotBefore === 'string', true);
  is('the actual campaign deletion was reached', attempted > 0, true);
  is('the product itself really left the catalog (a fresh store snapshot)', await readListing((await storeForEmail(owner))!, id), null);
  is('unknown unapplied deletion retains exactly the prior bytes', retained, mode === 'unapplied' ? before : null);
  is('retained content stays counted, a confirmed/applied deletion frees its slot', slotAfter, mode === 'unapplied' ? slotBefore : null);
  is('retained cleanup is not silently acknowledged as complete', Boolean(result.body.ok && retained !== null && !result.body.cleanupPending), false);
  const again = await remove(); // transport is healthy now; the same ordinary request is tried again.
  const afterRetry = (await base([['GET', key]]))[0];
  is('an ordinary healthy retry can finish previously unconfirmed campaign cleanup', afterRetry, null);
  // A direct internal retry with the removed product's known id is possible; the ordinary route above never reaches it.
  await dropLandings(shop.statsId!, id, shop);
  const manualRecoveryRecord = (await base([['GET', key]]))[0];
  is('a direct confirmed internal cleanup with the known id remains recoverable', manualRecoveryRecord, null);
  console.log('G_PRODUCT_LANDING_CLEANUP', JSON.stringify({ mode, attempted, result, again, retained, afterRetry, slotBefore, slotAfter, manualRecoveryRecord }));
  done();
}
void main();
