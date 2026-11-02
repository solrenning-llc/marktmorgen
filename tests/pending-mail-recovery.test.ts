import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipmentMailPolicy } from '@/lib/shipment-mail-outbox';
import { shipmentPolicy } from './shipment-mail-outbox-fixture';

const now = 1_800_000_000_000;
const recovery = () => ({
 version: 1, revision: 1, evidence: 'SYNTHETIC finite recovery; no actual funding',
 startsAt: now - 1000, until: now + 3_600_000,
 maximumAttempts: 100, maximumCommandUnits: 6400,
 checkpointBytes: 8192, maximumTriggerInvocations: 100,
 triggerEvidence: 'SYNTHETIC fixed trigger/function/failed-guard funding envelope',
});

test('an explicit finite recovery grant belongs to the same mail review', () => {
 const policy = { ...shipmentPolicy(now), recovery: recovery() };
 assert.ok(shipmentMailPolicy(policy, now, false), 'a valid bounded construction grant must be captured');
});

test('ordinary pending storage evidence never supplies recovery capacity', () => {
 const p = shipmentMailPolicy(shipmentPolicy(now), now, false);
 assert.ok(p);
 assert.equal(Object.hasOwn(p, 'recovery'), false);
});

test('recovery periods, finite budgets and own data are required before new IO', () => {
 for (const change of [
  { maximumAttempts: 0 }, { maximumAttempts: Infinity }, { maximumCommandUnits: 0 },
  { checkpointBytes: 1 }, { startsAt: now + 1 }, { until: now },
  { revision: 0 }, { maximumTriggerInvocations: 0 }, { triggerEvidence: '' },
 ]) assert.equal(shipmentMailPolicy({ ...shipmentPolicy(now), recovery: { ...recovery(), ...change } }, now, false), null);
 let reads = 0;
 const executable = Object.defineProperty(recovery(), 'maximumAttempts', { get() { reads++; return 100; } });
 assert.equal(shipmentMailPolicy({ ...shipmentPolicy(now), recovery: executable }, now, false), null);
 assert.equal(reads, 0);
});
