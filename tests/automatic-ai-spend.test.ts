import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { reserveAiSpend, isAiBudgetConfigured } from '../lib/ai-spend';
import { AUTOMATIC_AI_SPEND_CEILINGS, AUTOMATIC_AI_SPEND_REVIEW_ID, AUTOMATIC_AI_STORE_MICRO_USD, PAID_AI_ALLOCATIONS_PER_TIER, aiSpendLedgerKey, aiSpendOpenedKey, aiSpendPolicySnapshot, automaticAiSpendPolicy, ceilingPercent, currentAiSpendPolicy, isAiSpendPolicyValid } from '../lib/ai-spend-policy';
import { aiRequestHoldMicroUsd } from '../lib/spend-cost-table';
import { boundedAiRequest } from '../lib/ai-request-rules';
import { askModel } from '../lib/ai';
import type { Store } from '@/lib/store';
import { reset, ledger, opened, calls, seed } from './ai-spend-redis';
import { calendarPeriod, calendarPeriodId } from './billing-period-fixture';
// The month below is named once, at load, and the code reads the month again on every call (lib/ai-spend.ts,
// lib/ai-spend-policy.ts): a run crossing 00:00 UTC on a month's last day failed the ledger and ceiling checks. Only
// Date is stopped, for the whole run; timers and performance.now() run as usual.
mock.timers.enable({ apis: ['Date'], now: Date.now() });

const now = new Date();
const month = now.toISOString().slice(0, 7);
const key = aiSpendLedgerKey(month);
const pro = AUTOMATIC_AI_STORE_MICRO_USD.pro;
/** Spend a store up to `amount` in requests no larger than one allowed request. */
async function spend(statsId: string, amount: number, policy = currentAiSpendPolicy(now)!) {
  for (let left = amount; left > 0; left -= 1_000_000) assert.equal(await reserveAiSpend(statsId, 'pro', 'claude-sonnet-5-5', policy, Math.min(left, 1_000_000)), true);
}

test('the automatic policy is valid every month with nothing to renew', () => {
  const policy = currentAiSpendPolicy(now)!;
  assert.equal(isAiBudgetConfigured(), true);
  assert.equal(isAiSpendPolicyValid(policy, now), true);
  assert.equal(policy.reviewId, AUTOMATIC_AI_SPEND_REVIEW_ID);
  const later = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 15));
  assert.equal(isAiSpendPolicyValid(automaticAiSpendPolicy(later), later), true);
  assert.equal(automaticAiSpendPolicy(later)!.month, later.toISOString().slice(0, 7));
  assert.equal(automaticAiSpendPolicy(new Date(NaN)), null);
});

test('ceilings come from the allowances and the cost table, and only paid plans have one', () => {
  const policy = currentAiSpendPolicy(now)!;
  assert.deepEqual(policy.storeMicroUsd, AUTOMATIC_AI_STORE_MICRO_USD);
  assert.equal(policy.storeMicroUsd.creator, 0);
  for (const scope of ['trial', 'setup', 'ended'] as const) { assert.equal(policy.storeMicroUsd[scope], 0); assert.equal(policy.fundedStores[scope], 0); }
  assert.equal(policy.fundedStores.pro, PAID_AI_ALLOCATIONS_PER_TIER);
  assert.equal(policy.companyMicroUsd, (policy.storeMicroUsd.creator + policy.storeMicroUsd.pro + policy.storeMicroUsd.scale) * PAID_AI_ALLOCATIONS_PER_TIER);
  assert.deepEqual(policy.requestMicroUsd, AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd);
});

test('the optional setting can only lower the ceilings', () => {
  assert.equal(ceilingPercent(undefined), 100);
  assert.equal(ceilingPercent('250'), 100);
  assert.equal(ceilingPercent('-5'), 100);
  assert.equal(ceilingPercent('ten'), 100);
  assert.equal(ceilingPercent('40'), 40);
  assert.equal(automaticAiSpendPolicy(now, 50)!.storeMicroUsd.pro, Math.floor(pro / 2));
  assert.equal(automaticAiSpendPolicy(now, 1000)!.storeMicroUsd.pro, pro);
  const off = automaticAiSpendPolicy(now, 0)!;
  assert.equal(off.storeMicroUsd.scale, 0);
  assert.equal(isAiSpendPolicyValid(off, now), true);
});

test('the first reservation of a month opens its ledger once, then reserves the request hold', async () => {
  reset();
  const policy = currentAiSpendPolicy(now)!;
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', policy, 1_000), true);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][0][3], key);
  assert.equal(calls[0][0][4], aiSpendOpenedKey(month));
  const row = ledger.get(key)!;
  assert.equal(row.get('review'), AUTOMATIC_AI_SPEND_REVIEW_ID);
  assert.equal(row.get('policy'), aiSpendPolicySnapshot(policy));
  assert.equal(row.get('store:one'), '1000');
  assert.equal(row.get('slots:pro'), String(PAID_AI_ALLOCATIONS_PER_TIER - 1));
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', policy, 2_000), true);
  assert.equal(row.get('store:one'), '3000');
  assert.equal(row.get('company'), '3000');
});

test('a store stops at its plan ceiling and a request above the largest bound is refused', async () => {
  reset();
  const policy = currentAiSpendPolicy(now)!;
  const big = AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd['claude-haiku-5-5'];
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-haiku-5-5', policy, big + 1), false);
  for (const bad of [0, -1, 1.5, NaN]) assert.equal(await reserveAiSpend('one', 'pro', 'claude-haiku-5-5', policy, bad), false);
  assert.equal(calls.length, 0);
  await spend('one', pro - 10);
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', policy, 11), false);
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', policy, 10), true);
  assert.equal(ledger.get(key)!.get('store:one'), String(pro));
});

test('Store, trial, setup and ended stores have no allocation and never reach Redis', async () => {
  reset();
  const policy = currentAiSpendPolicy(now)!;
  for (const tier of ['creator', 'trial', 'setup', 'ended'] as const) assert.equal(await reserveAiSpend('one', tier, 'claude-haiku-5-5', policy, 100), false);
  assert.equal(calls.length, 0);
});

test('a ledger that was opened and then lost is never recreated empty', async () => {
  reset();
  const policy = currentAiSpendPolicy(now)!;
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', policy, 5_000), true);
  ledger.delete(key);
  assert.equal(opened.has(aiSpendOpenedKey(month)), true);
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', policy, 5_000), false);
  assert.equal(ledger.has(key), false);
});

test('changed automatic ceilings carry every spent amount and claimed allocation', async () => {
  reset();
  const full = currentAiSpendPolicy(now)!;
  await spend('one', pro - 100, full);
  const half = automaticAiSpendPolicy(now, 50)!;
  assert.notEqual(aiSpendPolicySnapshot(half), aiSpendPolicySnapshot(full));
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', half, 1), false);
  const row = ledger.get(key)!;
  assert.equal(row.get('policy'), aiSpendPolicySnapshot(half));
  assert.equal(row.get('store:one'), String(pro - 100));
  assert.equal(row.get('slots:pro'), String(PAID_AI_ALLOCATIONS_PER_TIER - 1));
  assert.equal(await reserveAiSpend('two', 'pro', 'claude-sonnet-5-5', half, 1), true);
  assert.equal(row.get('slots:pro'), String(PAID_AI_ALLOCATIONS_PER_TIER - 2));
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', full, 100), true);
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', full, 1), false);
});

test('a ledger written under any other review is left untouched', async () => {
  reset();
  const policy = currentAiSpendPolicy(now)!;
  seed(key, 'separately_reviewed', 'their-snapshot');
  const before = JSON.stringify([...ledger.get(key)!]);
  assert.equal(await reserveAiSpend('one', 'pro', 'claude-sonnet-5-5', policy, 1_000), false);
  assert.equal(JSON.stringify([...ledger.get(key)!]), before);
});

const studio = { statsId: 'studio1', tier: 'pro', createdAt: 1, subscriptionActive: true, subscriptionId: 'sub_test', trialEnds: 0, planEndedAt: '', period: calendarPeriod() } as unknown as Store;
test('the provider call reserves exactly the hard bound of its own request before the fetch', async () => {
  reset();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'x'.repeat(30);
  const old = globalThis.fetch; let fetched = 0;
  globalThis.fetch = async () => { fetched++; assert.equal(ledger.get(key)!.has('store:studio1:' + calendarPeriodId()), true); return new Response('busy', { status: 503 }); };
  try {
    assert.equal(await askModel(studio, 'system words', 'the prompt', 900, 'claude-sonnet-5-5'), null);
    const bounded = boundedAiRequest('system words', 'the prompt', 900, 'claude-sonnet-5-5');
    assert.ok(bounded.ok);
    const hold = aiRequestHoldMicroUsd('claude-sonnet-5-5', bounded.shape)!;
    assert.equal(fetched, 1);
    assert.equal(ledger.get(key)!.get('store:studio1:' + calendarPeriodId()), String(hold));
    // A failed attempt keeps its reservation; the retry is a new one.
    assert.equal(await askModel(studio, 'system words', 'the prompt', 900, 'claude-sonnet-5-5'), null);
    assert.equal(ledger.get(key)!.get('store:studio1:' + calendarPeriodId()), String(2 * hold));
  } finally { globalThis.fetch = old; }
});

test('a Store plan reaches neither Redis nor the provider', async () => {
  reset();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'x'.repeat(30);
  const old = globalThis.fetch; let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw Error('must not call'); };
  try {
    assert.equal(await askModel({ ...studio, tier: 'creator' } as unknown as Store, 'system', 'prompt', 100, 'claude-haiku-5-5'), null);
    assert.equal(fetched, 0);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = old; }
});
