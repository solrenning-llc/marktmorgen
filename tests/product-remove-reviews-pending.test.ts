// Removing a product whose reviews could not be deleted is never answered as a finished removal (Claude 3 cloud I,
// erasure audit 14/11/2026). The route tried dropReviews three times and, when every try failed, only logged it: the
// reviews (each with the buyer's name and words) stayed under a product no longer in the catalog, which a person's
// erasure no longer reads (lib/person-erasure.ts reads today's catalog), and the creator was told the removal was done.
// Now it is said as cleanup still pending, as the page and the campaign landings already are. Synthetic data only.
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/store/product/route';
import { SESSION_COOKIE, openSession } from '@/lib/auth';
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { reviewId } from '@/lib/reviews';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';

globalThis.fetch = async () => { throw Error('No external provider in this test'); };
async function main() {
  redis.clear();
  const owner = 'rev-remove-pending@example.test';
  await claimHandle(owner, 'rev-remove-pending', 'Synthetic store', '');
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, 'acct_RevRemovePend', true);
  await setSubscription(owner, { customerId: 'cus_RevRemovePend', subscriptionId: 'sub_RevRemovePend', active: true, tier: 'pro', period: paidPeriod() });
  const made = await addProduct(owner, 'Synthetic course', '', '19', null);
  if (!made.ok) throw Error('Real product fixture failed');
  const id = made.product.id;
  const shop = (await storeForEmail(owner))!;
  const statsId = shop.statsId!;
  const rid = reviewId(statsId, id, 'buyer@example.test');
  const key = `nl:rev:${statsId}:${id}`;
  const base = redis.pipeline.bind(redis);
  await base([['HSET', key, rid, JSON.stringify({ id: rid, productId: id, rating: 5, text: 'Loved it.', name: 'Rae', createdAt: 1_800_000_000 })]]);
  const session = await openSession(owner);
  let failed = 0;
  redis.pipeline = async commands => {
    if (commands[0]?.[0] === 'DEL' && commands[0]?.[1] === key) { failed++; throw Error('Synthetic transport failure deleting reviews'); }
    return base(commands);
  };
  let body: { ok?: boolean; cleanupPending?: boolean };
  try {
    const response = await POST(new NextRequest('https://marktmorgen.com/api/store/product', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://marktmorgen.com', host: 'marktmorgen.com', cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: 'remove', id }),
    }));
    body = await response.json() as typeof body;
  } finally { redis.pipeline = base; }
  const left = (await base([['HGET', key, rid]]))[0];
  is('the reviews deletion was tried and failed', failed > 0, true);
  is("the buyer's review is still kept under the removed product", typeof left === 'string', true);
  is('the removal is not answered as finished while the reviews stay', Boolean(body.ok && !body.cleanupPending), false);
  done();
}
void main();
