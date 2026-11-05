/** Independent review of #1933: count real route reads against its one API unit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '@/app/api/mcp/route';
import { makeKey } from '@/lib/api-keys';
import { addDraftProducts, claimHandle, ensureStatsId, setSubscription, storeForEmail } from '@/lib/store';
import { paidPeriod } from './billing-period-fixture';
import { store as redis } from './redis-stub';
import { startImport } from '@/lib/imports';

test('the real bundle MCP route stays inside the database reads paid by one API request', async () => {
  redis.clear();
  const email = 'review-a3-bundle@example.com';
  await claimHandle(email, 'review-a3-bundle', 'Synthetic review', '');
  await ensureStatsId(email);
  await setSubscription(email, { customerId: 'cus_A3BundleReview', subscriptionId: 'sub_A3BundleReview', active: true, tier: 'pro', cycle: 'month', period: paidPeriod() });
  const made = await addDraftProducts(email, Array.from({ length: 100 }, (_, i) => ({ title: `Synthetic guide ${i}`, summary: '', priceCents: 1900, link: 'https://example.com/guide' })));
  assert.equal(made.ok, true);
  const store = (await storeForEmail(email))!;
  const key = await makeKey(store.sid, 'Synthetic review');
  assert.equal(key.ok, true);
  if (!key.ok) return;
  const original = redis.pipeline.bind(redis), commands: (string | number)[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External requests forbidden in review'); };
  redis.pipeline = async batch => { commands.push(...batch); return original(batch); };
  try {
    const response = await POST(new Request('https://marktmorgen.com/api/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_bundle_choices', arguments: {} } })
    }));
    const body = await response.json();
    assert.equal(body.result?.isError, false);
    const value = JSON.parse(body.result.content[0].text);
    assert.equal(value.matches, 100);
    assert.equal(value.products.length, 20);
    const listingReads = commands.filter(c => c[0] === 'GET' && /^nl:catalog:.*:l:/.test(String(c[1]))).length;
    console.log(JSON.stringify({ listingReads, totalCommands: commands.length, allowanceCommands: commands.filter(c => c[0] === 'EVAL').length }));
    assert.ok(listingReads <= 20, `one API unit pays 20 route commands, but this route made ${listingReads} listing GETs`);
  } finally {
    redis.pipeline = original;
    globalThis.fetch = originalFetch;
  }
});

test('get_imports refuses an unconfirmed index or job response instead of reporting no imports', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External requests forbidden in review'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  redis.clear();
  const email = 'review-a3-imports@example.com';
  await claimHandle(email, 'review-a3-imports', 'Synthetic imports review', '');
  await ensureStatsId(email);
  await setSubscription(email, { customerId: 'cus_A3ImportsReview', subscriptionId: 'sub_A3ImportsReview', active: true, tier: 'pro', cycle: 'month', period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const made = await startImport(store, email, 'contacts', { expected: 1, file: 'private-review.csv', agreed: true });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const key = await makeKey(store.sid, 'Synthetic imports review');
  assert.equal(key.ok, true);
  if (!key.ok) return;
  const call = async () => {
    const response = await POST(new Request('https://marktmorgen.com/api/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_imports', arguments: {} } })
    }));
    return (await response.json()).result;
  };
  const control = await call();
  assert.equal(control.isError, false);
  assert.deepEqual(JSON.parse(control.content[0].text).imports.map((j: {id: string}) => j.id), [made.job.id]);
  for (const boundary of ['index', 'job']) await t.test(boundary, async () => {
    const original = redis.pipeline.bind(redis);
    let intercepted = false;
    redis.pipeline = async batch => {
      if (batch.some(c => boundary === 'index'
        ? c[0] === 'LRANGE' && String(c[1]) === `nl:imports:list:${store.sid}`
        : c[0] === 'GET' && String(c[1]) === `nl:import:${made.job.id}`)) {
        intercepted = true;
        return [];
      }
      return original(batch);
    };
    try {
      const result = await call();
      assert.equal(intercepted, true, 'the actual transport boundary was exercised');
      console.log(JSON.stringify({ boundary, response: result }));
      assert.equal(result.isError, true, 'an unconfirmed read must not confirm an empty import history');
    } finally { redis.pipeline = original; }
  });
});
