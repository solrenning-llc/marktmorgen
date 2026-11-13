// Codex G's proof on #1947 (codex/g-review-1947-product-cleanup, tests/g1947-retry-marker-alias.proof.ts), kept as a discovered test with its assertions unchanged.
// G: a malformed product id must not let a real removal retry erase another operation's deletion fence.
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/store/product/route';
import { SESSION_COOKIE, openSession } from '@/lib/auth';
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductPage, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { readListing } from '@/lib/catalog';
import { WRITE_LANDINGS, dropLandings, saveLanding } from '@/lib/campaign-landing-store';
import { EMPTY_PAGE, emptyBlock } from '@/lib/sales-page';
import { writePage } from '@/lib/sales-page-store';
import { dataKey } from '@/lib/store-data';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';

globalThis.fetch = async () => { throw Error('No external provider in this proof'); };
async function main() {
  redis.clear();
  const owner = 'g-landing-marker@example.test';
  await claimHandle(owner, 'g-landing-marker', 'Synthetic store', '');
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, 'acct_GLandingMarker', true);
  await setSubscription(owner, { customerId: 'cus_GLandingMarker', subscriptionId: 'sub_GLandingMarker', active: true, tier: 'pro', period: paidPeriod() });
  const made = await addProduct(owner, 'Synthetic course', '', '19', null);
  if (!made.ok) throw Error('Real product fixture failed');
  const id = made.product.id;
  if (!(await setProductPage(owner, id, true)).ok) throw Error('Real page fixture failed');
  const shop = (await storeForEmail(owner))!;
  await writePage(shop.statsId!, id, { ...EMPTY_PAGE, blocks: [emptyBlock('hero')] }, shop);
  const landing = (campaign: string) => ({ campaign, headline: 'Known headline', sub: 'Known campaign content', button: 'Read more' });
  await saveLanding(shop.statsId!, id, landing('original'), shop);
  const key = `nl:product:landing:${shop.statsId}:${id}`, marker = `${key}:gone`;
  const base = redis.pipeline.bind(redis), control = process.env.G_MARKER_ALIAS === 'control';
  const session = await openSession(owner);
  const remove = async (target: string) => {
    const response = await POST(new NextRequest('https://marktmorgen.com/api/store/product', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://marktmorgen.com', host: 'marktmorgen.com', cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: 'remove', id: target }) }));
    return { status: response.status, body: await response.json() as { ok?: boolean; error?: string } };
  };
  let reached!: () => void, release!: () => void, paused = 0;
  const atWrite = new Promise<void>(r => { reached = r; }), resume = new Promise<void>(r => { release = r; });
  redis.pipeline = async commands => {
    if (!paused && commands.some(c => c[0] === 'EVAL' && c[1] === WRITE_LANDINGS && c[4] === key)) { paused++; reached(); await resume; }
    return base(commands);
  };
  const pending = saveLanding(shop.statsId!, id, landing('stale-request'), shop).catch((error: unknown) => error);
  let first: Awaited<ReturnType<typeof remove>>, alias: Awaited<ReturnType<typeof remove>> | null = null;
  let afterDrop: unknown, markerBefore: unknown, markerAfter: unknown, outcome: unknown;
  try {
    await atWrite;
    first = await remove(id);
    afterDrop = (await base([['GET', key]]))[0]; markerBefore = (await base([['EXISTS', marker]]))[0];
    if (!control) alias = await remove(`${id}:gone`); // HTTP input only; no Redis state is forged.
    markerAfter = (await base([['EXISTS', marker]]))[0];
  } finally { release(); outcome = await pending; redis.pipeline = base; }
  const retained = (await base([['GET', key]]))[0], slot = (await base([['HGET', dataKey(shop)!, `al:${id}`]]))[0];
  is('the real save paused before its actual write', paused, 1);
  is('the authenticated real removal completed', [first!.status, first!.body.ok], [200, true]);
  is('the real product is absent in a fresh catalog snapshot', await readListing((await storeForEmail(owner))!, id), null);
  is('the confirmed removal erased campaign content', afterDrop, null);
  is('its deletion marker really existed before the malformed input', markerBefore, 1);
  is('a malformed product id is never acknowledged as a completed removal', alias?.body.ok === true, false);
  is('the malformed retry cannot remove the original product deletion marker', markerAfter, 1);
  is('the older save cannot recreate campaign data after a confirmed product removal', retained, null);
  is('a removed product has no revived campaign slot', slot, null);
  console.log('G_LANDING_MARKER_ALIAS', JSON.stringify({ control, paused, first: first!, alias, markerBefore, markerAfter, outcome: String(outcome), retained, slot }));
  await dropLandings(shop.statsId!, id, shop);
  done();
}
void main();
