import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveStoreUpload, reserveUploadControl, uploadBudgetCouldOpen, CHECK_UPLOAD_BUDGET, OPEN_UPLOAD_BUDGET, RESERVE_UPLOAD_BUDGET, type UploadStore } from '../lib/upload-budget';
import { AUTOMATIC_UPLOAD_CAPS, AUTOMATIC_UPLOAD_REVIEW_ID, PAID_UPLOAD_ALLOCATIONS_PER_TIER, automaticUploadBudgetPolicy, currentUploadBudgetPolicy, isUploadBudgetConfigured, minimumControlRequests, uploadAllowanceWords, uploadBudgetSnapshot, uploadLedgerKey, uploadOpenedKey } from '../lib/upload-budget-policy';
import { PAID_STORAGE_BYTES } from '../lib/storage-rules';
import { hashes, opened, calls, reset } from './upload-budget-redis';
import { calendarPeriod, calendarPeriodId } from './billing-period-fixture';

const now = new Date();
const key = uploadLedgerKey(now.toISOString().slice(0, 7));
const id = (n: number) => n.toString(16).padStart(32, '0');
const store = (n = 1, tier: 'creator' | 'pro' | 'scale' = 'pro', extra: Partial<UploadStore> = {}): UploadStore => ({ statsId: id(n), tier, subscriptionActive: true, subscriptionId: 'sub_test123', trialEnds: 0, planEndedAt: '', period: calendarPeriod(), ...extra });

test('the automatic upload policy is valid every month and matches the published storage', () => {
  const policy = currentUploadBudgetPolicy(now)!;
  assert.equal(isUploadBudgetConfigured(), true);
  assert.equal(isUploadBudgetConfigured(policy, now), true);
  for (const tier of ['creator', 'pro', 'scale'] as const) {
    assert.equal(policy.perStore[tier].authorizedBytes, PAID_STORAGE_BYTES[tier]);
    assert.equal(policy.perStore[tier].controlRequests, minimumControlRequests(policy.perStore[tier].opens, PAID_STORAGE_BYTES[tier]) + policy.perStore[tier].opens);
    assert.equal(policy.fundedStores[tier], PAID_UPLOAD_ALLOCATIONS_PER_TIER);
  }
  const later = new Date(Date.UTC(now.getUTCFullYear() + 2, 5, 1));
  assert.equal(isUploadBudgetConfigured(automaticUploadBudgetPolicy(later), later), true);
});

test('the first upload of the month opens the ledger once and reserves before the provider', async () => {
  reset();
  assert.equal(await reserveStoreUpload(store(), 5_000_000, 'r2'), true);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][0][3], key);
  const row = hashes.get(key)!;
  assert.equal(row.get('review'), AUTOMATIC_UPLOAD_REVIEW_ID);
  assert.equal(row.get('policy'), uploadBudgetSnapshot(currentUploadBudgetPolicy()!));
  assert.equal(row.get('store:' + id(1) + '@' + calendarPeriodId() + ':bytes'), '5000000');
  assert.equal(await reserveUploadControl(store()), true);
  assert.equal(row.get('store:' + id(1) + '@' + calendarPeriodId() + ':controls'), '2');
});

test('a store stops at its monthly starts', async () => {
  reset();
  const opens = AUTOMATIC_UPLOAD_CAPS.creator.opens;
  for (let n = 0; n < opens; n++) assert.equal(await reserveStoreUpload(store(1, 'creator'), 1, 'r2'), true);
  assert.equal(await reserveStoreUpload(store(1, 'creator'), 1, 'r2'), false);
});

test('trial, setup and ended stores have no automatic allocation', async () => {
  reset();
  const soon = Date.now() / 1000 + 3600;
  for (const extra of [{ trialEnds: soon }, { subscriptionActive: false, subscriptionId: null }, { subscriptionActive: false, planEndedAt: '2026-01-01' }])
    assert.equal(await reserveStoreUpload(store(2, 'pro', extra), 1, 'r2'), false);
  assert.equal(calls.length, 0);
});

test('a lost ledger is never recreated, and a separately reviewed one is never touched', async () => {
  reset();
  assert.equal(await reserveStoreUpload(store(), 1, 'r2'), true);
  hashes.delete(key);
  assert.equal(opened.has(uploadOpenedKey(now.toISOString().slice(0, 7))), true);
  assert.equal(await reserveStoreUpload(store(), 1, 'r2'), false);
  assert.equal(hashes.has(key), false);
  reset();
  const theirs = new Map([['policy', 'their-snapshot'], ['company:opens', '0'], ['company:bytes', '0'], ['company:controls', '0']]);
  hashes.set(key, theirs);
  const before = JSON.stringify([...theirs]);
  assert.equal(await reserveStoreUpload(store(), 1, 'r2'), false);
  assert.equal(JSON.stringify([...theirs]), before);
});

test('a changed automatic allowance carries the counters it finds', async () => {
  reset();
  assert.equal(await reserveStoreUpload(store(), 7, 'r2'), true);
  const row = hashes.get(key)!;
  row.set('policy', 'an-older-automatic-snapshot');
  assert.equal(await reserveStoreUpload(store(), 3, 'r2'), true);
  assert.equal(row.get('policy'), uploadBudgetSnapshot(currentUploadBudgetPolicy()!));
  assert.equal(row.get('store:' + id(1) + '@' + calendarPeriodId() + ':bytes'), '10');
  assert.equal(row.get('slots:pro'), String(PAID_UPLOAD_ALLOCATIONS_PER_TIER - 1));
});

test('the scripts never expire, delete or refund', () => {
  for (const script of [OPEN_UPLOAD_BUDGET, RESERVE_UPLOAD_BUDGET]) assert.doesNotMatch(script, /EXPIRE|DECRBY|DEL\b|HDEL/);
  assert.doesNotMatch(OPEN_UPLOAD_BUDGET, /HINCRBY|'store:/);
  const used = new Set([...CHECK_UPLOAD_BUDGET.matchAll(/redis\.call\('([A-Z]+)'/g)].map(match => match[1]));
  assert.deepEqual([...used].sort(), ['EXISTS', 'HGET', 'TTL', 'TYPE'], 'the check only reads');
});

test('the read-only check answers as the take would, and creates or changes nothing', async () => {
  reset();
  const month = uploadOpenedKey(now.toISOString().slice(0, 7));
  assert.equal(await uploadBudgetCouldOpen(store(), 5_000_000, 'r2'), true, 'a new month');
  assert.equal(hashes.size, 0);
  assert.equal(opened.size, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  const opens = AUTOMATIC_UPLOAD_CAPS.creator.opens;
  for (let n = 0; n < opens; n++) assert.equal(await reserveStoreUpload(store(3, 'creator'), 1, 'r2'), true);
  const row = JSON.stringify([...hashes.get(key)!]);
  assert.equal(await uploadBudgetCouldOpen(store(3, 'creator'), 1, 'r2'), false, 'starts spent');
  assert.equal(await uploadBudgetCouldOpen(store(4, 'creator'), 1, 'r2'), true, 'another store still has room');
  assert.equal(JSON.stringify([...hashes.get(key)!]), row);
  hashes.delete(key);
  assert.equal(opened.has(month), true);
  assert.equal(await uploadBudgetCouldOpen(store(4, 'creator'), 1, 'r2'), false, 'a lost ledger');
  assert.equal(hashes.has(key), false);
  reset();
  const soon = Date.now() / 1000 + 3600;
  assert.equal(await uploadBudgetCouldOpen(store(2, 'pro', { trialEnds: soon }), 1, 'r2'), false);
  assert.equal(await uploadBudgetCouldOpen(store(), 1, 'stream'), false);
  assert.equal(await uploadBudgetCouldOpen(store(), 0, 'r2'), false);
  assert.equal(calls.length, 0, 'refused before Redis');
});

test('public wording shows the automatic numbers instead of a pause', () => {
  const words = uploadAllowanceWords('pro');
  assert.doesNotMatch(words, /paused/);
  assert.match(words, new RegExp(AUTOMATIC_UPLOAD_CAPS.pro.opens + ' upload starts'));
  assert.match(uploadAllowanceWords('trial'), /start with a paid plan/);
});
