import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredAiStoreMicroUsd, aiEntitlementsFunded, aiEntitlementsSnapshot } from '@/lib/ai-entitlement-rules';
import { aiSpendPolicySnapshot, isAiSpendPolicyValid, type AiSpendPolicy } from '@/lib/ai-spend-policy';
const rates={'claude-sonnet-5-5':100,'claude-haiku-5-5':20};
// Store and the free trial include no AI since October 17, 2026 (lib/ai-rules.ts).
const expected={creator:0,pro:33000,scale:56000,trial:0,setup:56000,ended:56000};
// One moment for the fixture's month and the validity check, so a run across 00:00 UTC on a month's last day cannot split them.
const now=new Date();
function fixture():AiSpendPolicy{return {reviewId:'entitlement_test',month:now.toISOString().slice(0,7),evidence:'TEST ONLY hypothetical charges; not approved provider pricing',requestMicroUsd:{...rates},storeMicroUsd:{...expected},fundedStores:{creator:1,pro:1,scale:1,trial:1,setup:1,ended:1},companyMicroUsd:201000};}
test('every simultaneous writing and visitor allowance is funded at the most expensive model',()=>{for(const [tier,cost] of Object.entries(expected))assert.equal(requiredAiStoreMicroUsd(tier as keyof typeof expected,rates),BigInt(cost));});
test('exact hypothetical coverage passes; one microdollar less fails for every funded scope',()=>{for(const tier of (Object.keys(expected) as (keyof typeof expected)[]).filter(tier=>expected[tier]>0)){const p=fixture();assert.equal(isAiSpendPolicyValid(p,now),true);assert.equal(aiEntitlementsFunded(p),true);p.storeMicroUsd[tier]--;assert.equal(isAiSpendPolicyValid(p,now),true);assert.equal(aiEntitlementsFunded(p),false);}});
test('zero funded acquisition slots do not pretend to grant an allocation',()=>{const p=fixture();p.fundedStores.setup=0;p.storeMicroUsd.setup=0;assert.equal(aiEntitlementsFunded(p),true);p.fundedStores.setup=1;assert.equal(aiEntitlementsFunded(p),false);});
test('missing model prices and unknown scopes never become zero costs',()=>{assert.equal(requiredAiStoreMicroUsd('creator',{}),null);assert.equal(requiredAiStoreMicroUsd('creator',{...rates,'claude-haiku-5-5':0}),null);assert.equal(requiredAiStoreMicroUsd('unknown' as 'creator',rates),null);});
test('ledger binding contains the accepted model, request and entitlement envelope',()=>{assert.ok(aiSpendPolicySnapshot(fixture()).includes(JSON.stringify(aiEntitlementsSnapshot()).slice(1,-1)));});
