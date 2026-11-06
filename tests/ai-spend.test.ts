import test from 'node:test';
import assert from 'node:assert/strict';
import { aiBudgetScopeFor, isAiBudgetConfigured, reserveAiSpend, RESERVE_AI_SPEND, OPEN_AI_SPEND_LEDGER } from '../lib/ai-spend';
import { aiSpendLedgerKey, aiSpendPolicySnapshot, aiStoreCostCents, type AiSpendPolicy } from '../lib/ai-spend-policy';
import { reset, seed, ledger, calls, settings } from './ai-spend-redis';
const month = new Date().toISOString().slice(0,7);
const key = aiSpendLedgerKey(month);
function policy(): AiSpendPolicy { return { reviewId:'test_review', month, evidence:'Test fixture only: not approved production prices',requestMicroUsd:{'claude-sonnet-5-5':100,'claude-haiku-5-5':20},storeMicroUsd:{creator:300,pro:500,scale:1000,trial:0,setup:0,ended:0},companyMicroUsd:400,fundedStores:{creator:1,pro:0,scale:0,trial:0,setup:0,ended:0} }; }
const take = (id='one', p=policy()) => reserveAiSpend(id,'creator','claude-sonnet-5-5',p);
test('review must cover current UTC month and all finite integer ceilings',()=>{const p=policy();assert.equal(isAiBudgetConfigured(p),true);assert.equal(isAiBudgetConfigured({...p,month:'2000-01'}),false);assert.equal(isAiBudgetConfigured({...p,reviewId:''}),false);for(const n of [NaN,Infinity,-1,0.1,1e12+1])assert.equal(isAiBudgetConfigured({...p,companyMicroUsd:n}),false);assert.equal(isAiBudgetConfigured({...p,requestMicroUsd:{...p.requestMicroUsd,'claude-haiku-5-5':0}}),false);});
test('missing or mismatched funding ledger never gets created',async()=>{reset();assert.equal(await take(),false);assert.equal(ledger.size,0);seed(key,'old_review',aiSpendPolicySnapshot(policy()));assert.equal(await take(),false);assert.equal(ledger.get(key)?.get('company'),'0');});
test('each call reserves both ceilings and full-store use stops exactly at cap',async()=>{reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));for(let n=0;n<3;n++)assert.equal(await take(),true);assert.equal(await take(),false);assert.equal(ledger.get(key)?.get('store:one'),'300');assert.equal(ledger.get(key)?.get('company'),'300');assert.equal(calls[0].length,1);assert.equal(calls[0][0][0],'EVAL');assert.equal(calls[0][0][2],1);});
test('concurrent customers also stop at company cap',async()=>{
  reset();const p={...policy(),storeMicroUsd:{...policy().storeMicroUsd,creator:100},fundedStores:{creator:4,pro:0,scale:0,trial:0,setup:0,ended:0}};
  seed(key,'test_review',aiSpendPolicySnapshot(p),p.fundedStores);
  const results=await Promise.all(Array.from({length:20},(_,i)=>take('customer'+i,p)));
  assert.equal(results.filter(Boolean).length,4);assert.equal(ledger.get(key)?.get('company'),'400');
});
test('all model calls share the same customer counter',async()=>{reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));assert.equal(await take(),true);assert.equal(await reserveAiSpend('one','creator','claude-haiku-5-5',policy()),true);assert.equal(ledger.get(key)?.get('store:one'),'120');});
test('trial needs its own funded allocation',async()=>{reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));assert.equal(await reserveAiSpend('one','trial','claude-haiku-5-5',policy()),false);assert.equal(calls.length,0);const funded={...policy(),storeMicroUsd:{...policy().storeMicroUsd,trial:40},fundedStores:{...policy().fundedStores,trial:1}}; assert.equal(await reserveAiSpend('one','trial','claude-haiku-5-5',funded),false);reset();seed(key,'test_review',aiSpendPolicySnapshot(funded),funded.fundedStores);assert.equal(await reserveAiSpend('one','trial','claude-haiku-5-5',funded),true);});
test('corrupt amounts and Redis failures deny without fallback',async()=>{for(const corrupt of ['-1','NaN','1.5','01','1000000000001']){reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));ledger.get(key)!.set('company',corrupt);assert.equal(await take(),false);}reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));settings({failure:true});assert.equal(await take(),false);settings({failure:false,available:false});assert.equal(await take(),false);});
test('ambiguous Redis acknowledgments never authorize a provider call',async()=>{for(const response of [[],['1'],[true],[1,1],[null],[0]]){reset();settings({response});assert.equal(await take(),false);}});
test('invalid attribution or unsupported model cannot spend',async()=>{reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));assert.equal(await take(''),false);assert.equal(await take('id:other'),false);assert.equal(await reserveAiSpend('one','creator','claude-unreviewed',policy()),false);assert.equal(calls.length,0);});
test('new review identifiers cannot reset a used ledger',async()=>{reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));assert.equal(await take(),true);assert.equal(await take('one',{...policy(),reviewId:'different'}),false);assert.equal(ledger.get(key)?.get('company'),'100');});
test('Lua validates all fields before writes and never expires or refunds reservations',()=>{assert.ok(RESERVE_AI_SPEND.indexOf('storeLimit - store') < RESERVE_AI_SPEND.indexOf("redis.call('HINCRBY'"));assert.match(RESERVE_AI_SPEND,/TTL/);assert.doesNotMatch(RESERVE_AI_SPEND,/EXPIRE|DECRBY|DEL/);assert.doesNotMatch(OPEN_AI_SPEND_LEDGER,/EXPIRE|DECRBY|DEL|HINCRBY|'store:/);});

test('same review identifier cannot silently change any funded ceiling',async()=>{
  const base=policy();
  const edits=[{...base,companyMicroUsd:500},{...base,storeMicroUsd:{...base.storeMicroUsd,creator:400}},{...base,requestMicroUsd:{...base.requestMicroUsd,'claude-sonnet-5-5':80}},{...base,evidence:'Changed evidence'}];
  for(const changed of edits){reset();seed(key,base.reviewId,aiSpendPolicySnapshot(base));assert.equal(await take('one',changed),false);assert.equal(ledger.get(key)?.get('company'),'0');}
});
test('missing snapshot and inconsistent store counters cannot spend',async()=>{
  reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));ledger.get(key)!.delete('policy');assert.equal(await take(),false);
  reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));ledger.get(key)!.set('store:one','100');assert.equal(await take(),false);assert.equal(ledger.get(key)?.get('company'),'0');
});
test('canonical policy binding ignores object insertion order',()=>{
  const p=policy();assert.equal(aiSpendPolicySnapshot(p),aiSpendPolicySnapshot({...p,requestMicroUsd:{'claude-haiku-5-5':20,'claude-sonnet-5-5':100},storeMicroUsd:{ended:0,setup:0,trial:0,scale:1000,pro:500,creator:300}}));
});
test('malformed review evidence refuses without throwing',()=>{
  for(const value of [0,true,{},[]])assert.equal(isAiBudgetConfigured({...policy(),evidence:value} as unknown as AiSpendPolicy),false);
});

test('company funding covers every promised tier allocation at full use',()=>{
  const p=policy();
  assert.equal(isAiBudgetConfigured({...p,fundedStores:{...p.fundedStores,creator:2}}),false);
  assert.equal(isAiBudgetConfigured({...p,companyMicroUsd:600,fundedStores:{...p.fundedStores,creator:2}}),true);
  assert.equal(isAiBudgetConfigured({...p,fundedStores:{...p.fundedStores,trial:NaN}}),false);
});
test('one funded store slot cannot be reused by concurrent customers',async()=>{
  reset();const p=policy();seed(key,p.reviewId,aiSpendPolicySnapshot(p),p.fundedStores);
  const attempts=await Promise.all(Array.from({length:64},(_,n)=>take('slot'+n,p)));
  assert.equal(attempts.filter(Boolean).length,1);
  assert.equal(ledger.get(key)?.get('slots:creator'),'0');
  const winner=attempts.findIndex(Boolean);assert.equal(await take('slot'+winner,p),true);
  assert.equal(await take('slot'+winner,p),true);
  assert.equal(ledger.get(key)?.get('company'),'300');
});
test('missing or corrupt allocation metadata never grants extra stores',async()=>{
  for(const value of [undefined,'-1','01','2','NaN']){
    reset();const p=policy();seed(key,p.reviewId,aiSpendPolicySnapshot(p),p.fundedStores);
    if(value===undefined)ledger.get(key)!.delete('slots:creator');else ledger.get(key)!.set('slots:creator',value);
    assert.equal(await take(),false);assert.equal(ledger.get(key)?.get('company'),'0');
  }
});
test('tier changes and missing used counters cannot reset existing allocations',async()=>{
  reset();const p={...policy(),companyMicroUsd:350,storeMicroUsd:{...policy().storeMicroUsd,pro:50},fundedStores:{creator:1,pro:1,scale:0,trial:0,setup:0,ended:0}};
  seed(key,p.reviewId,aiSpendPolicySnapshot(p),p.fundedStores);
  assert.equal(await take('one',p),true);
  assert.equal(await reserveAiSpend('one','pro','claude-haiku-5-5',p),false);
  ledger.get(key)!.delete('store:one');
  assert.equal(await take('one',p),false);assert.equal(ledger.get(key)?.get('company'),'100');
});

test('setup, trial and ended stores are attributed to their own acquisition allocations',()=>{
  const base={tier:'creator' as const,subscriptionActive:false,subscriptionId:null,trialEnds:0,planEndedAt:''};
  assert.equal(aiBudgetScopeFor(base,100),'setup');
  assert.equal(aiBudgetScopeFor({...base,subscriptionId:'old'},100),'ended');
  assert.equal(aiBudgetScopeFor({...base,subscriptionActive:true,trialEnds:101},100),'trial');
  assert.equal(aiBudgetScopeFor({...base,subscriptionActive:true},100),'creator');
  // 232 [CA1] unit 4: a renewal Stripe could not collect is spent as an ended plan, and paid up again it is its tier.
  assert.equal(aiBudgetScopeFor({...base,subscriptionActive:true,renewalUnpaidSince:100},100),'ended');
  assert.equal(aiBudgetScopeFor({...base,subscriptionActive:true,renewalUnpaidSince:0},100),'creator');
  assert.equal(aiBudgetScopeFor({...base,tier:'pro',subscriptionActive:true},100),'pro');
});

test('annual AI cost aggregates twelve full months before rounding cents',()=>{
  const p={...policy(),companyMicroUsd:10001,storeMicroUsd:{...policy().storeMicroUsd,creator:10001}};
  assert.equal(aiStoreCostCents(p,'creator',1),2);
  assert.equal(aiStoreCostCents(p,'creator',12),13);
  assert.equal(aiStoreCostCents(p,'creator',2),null);
  assert.equal(aiStoreCostCents(null,'creator',1),null);
  assert.equal(aiStoreCostCents(policy(),'trial',1),null);
});

test('non-string attribution cannot become a shared account through coercion',async()=>{reset();seed(key,'test_review',aiSpendPolicySnapshot(policy()));for(const id of [undefined,null,42,{toString:()=> 'one'}])assert.equal(await reserveAiSpend(id as unknown as string,'creator','claude-sonnet-5-5',policy()),false);assert.equal(calls.length,0);assert.equal(ledger.get(key)?.get('company'),'0');});
