/** Opt-in independent proof: run with proofs/cx1/review-2770-run.mjs. */
import assert from 'node:assert/strict';
import { readNumbers, summaryOf } from '@/lib/stats-report';
import { apiNumbers, keptNumbersCopy, keptNumbersKey } from '@/lib/api-numbers';
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from '@/lib/store';
import { store as redis } from './redis-stub';

async function main() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_cx1_synthetic_fixture_only';
  let providerReads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.stripe.com' && (init?.method ?? 'GET') === 'GET') {
      providerReads++;
      return Response.json({ object: 'list', data: [], has_more: false });
    }
    throw new Error('Unexpected external request in synthetic proof');
  }) as typeof fetch;

  redis.clear();
  const now = Date.now();
  const email = 'numbers-owner@example.test';
  await claimHandle(email, 'cx1numbers', 'Synthetic numbers', '');
  await ensureStatsId(email);
  await setStripeAccount(email, 'acct_1CX1Nums0001', true);
  const shop = await storeForEmail(email);
  assert.ok(shop?.statsId);
  const data = await readNumbers(shop, now);
  assert.ok(data);
  const baseline = summaryOf(data);
  assert.equal(baseline.paid_figures_complete, true);
  assert.equal(baseline.days.last_7_days.revenue, 0);
  const raw = keptNumbersCopy(shop, 'plain', data, now);
  assert.ok(raw);
  const key = keptNumbersKey(shop.statsId, 'plain');
  await redis.pipeline([['SET', key, raw]]);
  const end = raw.indexOf('\n');
  assert.ok(end > 0);
  const originalPipeline = redis.pipeline.bind(redis);
  let failed = 0;
  for (const [name, cents, invalid] of [
    ['string revenue', 'unreadable', true],
    ['boolean revenue', false, true],
    ['null revenue', null, true],
    ['known zero control', 0, false],
  ] as const) {
    // Keep the real producer's complete data and exact identity header.
    // Only the single GET response differs from the valid stored copy.
    const changed = JSON.parse(raw.slice(end + 1));
    changed.totals.d7.cents = cents;
    const answer = raw.slice(0, end + 1) + JSON.stringify(changed);
    let hits = 0;
    let holds = 0;
    let settlements = 0;
    let coldCharges = 0;
    const beforeReads = providerReads;
    redis.pipeline = async (commands) => {
      if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) {
        hits++;
        return [answer];
      }
      return originalPipeline(commands);
    };
    try {
      const result = await apiNumbers(shop, 'plain', async () => {
        coldCharges++;
        return new Response('Synthetic cold charge refusal', { status: 429 });
      }, async () => {
        holds++;
        return async () => { settlements++; return null; };
      }, now);
      assert.equal(hits, 1, 'The injected GET must be reached');
      assert.equal(holds, 1, 'The warm read must reserve before GET');
      assert.equal(providerReads, beforeReads, 'A refused cold charge cannot read the provider');
      if (result === null || result instanceof Response) {
        assert.equal(invalid, true, 'A valid known-zero copy must remain available');
      } else {
        const summary = summaryOf(result.data);
        assert.equal(await result.settle(Buffer.byteLength(JSON.stringify(summary))), null);
        assert.equal(settlements, 1);
        console.log(JSON.stringify({ name, revenue: summary.days.last_7_days.revenue,
          paid_figures_complete: summary.paid_figures_complete, coldCharges }));
        if (invalid) {
          // A correction can refuse, perform a separately funded refresh, or
          // explicitly mark the paid figures incomplete with no known revenue.
          assert.equal(summary.paid_figures_complete, false,
            'Unreadable paid revenue must not be certified complete');
          assert.equal(summary.days.last_7_days.revenue, null);
        } else {
          assert.equal(summary.paid_figures_complete, true);
          assert.equal(summary.days.last_7_days.revenue, 0);
          assert.equal(coldCharges, 0);
        }
      }
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      redis.pipeline = originalPipeline;
    }
  }
  console.log(`Checks: 4; failed: ${failed}; passed: ${4 - failed}`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
