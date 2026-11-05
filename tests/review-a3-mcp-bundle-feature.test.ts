/** Independent RED/GREEN of the tools introduced by #1933. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '@/app/api/mcp/route';
import { makeKey } from '@/lib/api-keys';
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from '@/lib/store';
import { paidPeriod } from './billing-period-fixture';
import { store as redis } from './redis-stub';
test('both new tools are served by the real MCP route', async t => {
  redis.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External requests forbidden in review'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const email = 'review-a3-mcp-feature@example.com';
  await claimHandle(email, 'review-a3-mcp-feature', 'Synthetic feature review', '');
  await ensureStatsId(email);
  await setSubscription(email, { customerId: 'cus_A3McpReview', subscriptionId: 'sub_A3McpReview', active: true, tier: 'pro', cycle: 'month', period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const key = await makeKey(store.sid, 'Synthetic feature review');
  assert.equal(key.ok, true);
  if (!key.ok) return;
  const response = await POST(new Request('https://marktmorgen.com/api/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  }));
  const body = await response.json();
  const names = body.result.tools.map((tool: {name: string}) => tool.name);
  for (const name of ['list_bundle_choices', 'get_imports']) await t.test(name, () => assert.equal(names.includes(name), true));
});
