/** Unknown customer/subscription rows must not become confirmed absence. Synthetic only. */
import { claimHandle, ensureStoreId, setStripeAccount, storeForEmail } from '@/lib/store';
import { freeDaysSubs, giveFreeDays } from '@/lib/member-free-days';
import { store as redis } from '../../../tests/redis-stub';
import { done, is } from '../../../tests/check';

process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_free_days_only';
const now = 1_794_200_000;
const next = now + 86_400;
let mode = 'healthy';
let posts = 0;
const sub = { id: 'sub_sreview0001', object: 'subscription', status: 'active', metadata: { store: 'sfreedays', product: 'prod_sreview' }, items: { data: [{ current_period_end: next, price: { unit_amount: 2900, currency: 'usd', recurring: { interval: 'month' } } }] } };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === 'POST') { posts++; throw new Error('No provider write allowed'); }
  const url = new URL(String(input));
  if (url.hostname !== 'api.stripe.com') throw new Error('No external service');
  const list = (data: unknown[]) => Response.json({ object: 'list', data, has_more: false });
  if (url.pathname === '/v1/customers') {
    if (mode === 'no customer') return list([]);
    if (mode === 'customer object') return list([{}]);
    if (mode === 'customer array') return list([[]]);
    return list([{ id: 'cus_sreview0001', object: 'customer' }]);
  }
  if (url.pathname === '/v1/subscriptions') {
    if (mode === 'subscription object') return list([{}]);
    if (mode === 'subscription array') return list([[]]);
    if (mode === 'canceled') return list([{ ...sub, status: 'canceled' }]);
    if (mode === 'no page') return Response.json({ object: 'list' });
    return list([sub]);
  }
  throw new Error('Unexpected synthetic read');
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = 's-free-days@example.com';
  await claimHandle(owner, 'sfreedays', 'S Free Days', '');
  await ensureStoreId(owner);
  await setStripeAccount(owner, 'acct_SyntheticDays01', true);
  const store = (await storeForEmail(owner))!;
  const by = { who: owner, role: 'owner' as const };
  is('healthy member exists before injected response corruption', (await freeDaysSubs(store, 'member@example.com', now))?.map(x => x.id), [sub.id]);
  for (mode of ['customer object', 'customer array', 'subscription object', 'subscription array']) {
    const found = await freeDaysSubs(store, 'member@example.com', now);
    const given = await giveFreeDays(store, 'member@example.com', sub.id, 7, next, by, now);
    console.log('S2912_ROWS', JSON.stringify({ mode, found, given }));
    is(`${mode}: lookup remains unknown, never an empty membership list`, found, null);
    is(`${mode}: give reports unreadable Stripe, never confirmed not_member`, given, { ok: false, reason: 'stripe' });
  }
  mode = 'no customer';
  is('confirmed empty complete customer page stays empty', await freeDaysSubs(store, 'member@example.com', now), []);
  mode = 'canceled';
  is('confirmed canceled subscription stays excluded', await freeDaysSubs(store, 'member@example.com', now), []);
  mode = 'no page';
  is('missing page data is unknown as already fixed', await freeDaysSubs(store, 'member@example.com', now), null);
  is('no subscription write or email was attempted', posts, 0);
  done();
}
void main();
