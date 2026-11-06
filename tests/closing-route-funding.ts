// A checkout's funding grant stood in for, shaped as lib/contract-funding.ts makes one; everything else as it is.
export * from '../lib/contract-funding';
import type { ContractGrant } from '../lib/contract-funding';
import { PUBLISHED_PLAN_PRICES, type Cycle, type Tier } from '../lib/plan';
export const grants: ContractGrant[] = [];
export async function reserveContractFunding(statsId: string, tier: Tier, cycle: Cycle, action: 'checkout' | 'switch' | 'restart'): Promise<ContractGrant | null> {
  const now = Math.floor(Date.now() / 1000);
  const grant = { sourceSubscriptionId: null, action, id: `ctr_closingroute${grants.length}`, reviewId: 'rev_closingroute', statsId, key: `${tier}_${cycle}`, reservedCents: PUBLISHED_PLAN_PRICES[tier][cycle], submitUntilSeconds: now + 300, checkoutExpiresAtSeconds: now + 3600, activationUntilSeconds: now + 86_400, liabilitiesThrough: '2027-12-31' } as ContractGrant;
  grants.push(grant);
  return grant;
}
