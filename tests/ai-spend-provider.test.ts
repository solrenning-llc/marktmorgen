import './frozen-clock'; // first: the month this file names at load is the month the code reads on every call
import { withAiCallBudget } from '@/lib/ai-call-budget';
import test from 'node:test';
import assert from 'node:assert/strict';
import { askModel } from '../lib/ai';
import { aiSpendLedgerKey, aiSpendPolicySnapshot } from '../lib/ai-spend-policy';
import { CURRENT_AI_SPEND_POLICY as fundedPolicy } from './ai-spend-approved-policy';
import type { Store } from '@/lib/store';
import { reset, seed, ledger, settings } from './ai-spend-redis';
import { calendarPeriod, calendarPeriodId } from './billing-period-fixture';
const key=aiSpendLedgerKey(new Date().toISOString().slice(0,7));
const store={statsId:'one',tier:'creator',createdAt:1,subscriptionActive:true,subscriptionId:'test-subscription',trialEnds:0,planEndedAt:'',period:calendarPeriod()} as unknown as Store;
function start(){reset();seed(key,'test_review',aiSpendPolicySnapshot(fundedPolicy));process.env.ANTHROPIC_API_KEY='sk-ant-'+ 'x'.repeat(30);}
test('real provider path blocks an unfunded ledger before fetch',async()=>{start();ledger.clear();let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('must not call');};try{assert.equal(await askModel(store,'system','prompt',100,'claude-sonnet-5-5'),null);assert.equal(calls,0);}finally{globalThis.fetch=old;}});
test('failed paid requests and retries retain separate reservations',async()=>{start();let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;return new Response('busy',{status:503});};try{for(let i=0;i<6;i++)assert.equal(await askModel(store,'system','prompt',100,'claude-sonnet-5-5'),null);assert.equal(calls,3);assert.equal(ledger.get(key)?.get('store:one:'+calendarPeriodId()),'300');assert.equal(ledger.get(key)?.get('company'),'300');}finally{globalThis.fetch=old;}});
test('network failure keeps its ceiling reserved',async()=>{start();const old=globalThis.fetch;globalThis.fetch=async()=>{throw Error('lost response');};try{await assert.rejects(askModel(store,'system','prompt',100,'claude-sonnet-5-5'));assert.equal(ledger.get(key)?.get('company'),'100');}finally{globalThis.fetch=old;}});
test('invalid requests consume no money and make no provider call',async()=>{start();let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('must not call');};try{assert.equal(await askModel(store,'system','prompt',6001,'claude-sonnet-5-5'),null);assert.equal(await askModel(store,'system','prompt',100,'claude-unknown'),null);assert.equal(ledger.get(key)?.get('company'),'0');assert.equal(calls,0);}finally{globalThis.fetch=old;}});
test('successful requests also retain the reviewed maximum',async()=>{start();let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;return Response.json({content:[{type:'text',text:'A draft'}],usage:{input_tokens:1,output_tokens:1}});};try{assert.equal(await askModel(store,'system','prompt',100,'claude-sonnet-5-5'),'A draft');assert.equal(ledger.get(key)?.get('company'),'100');settings({failure:true});assert.equal(await askModel(store,'system','prompt',100,'claude-sonnet-5-5'),null);assert.equal(calls,1);}finally{globalThis.fetch=old;}});

test('unfunded setup and ended accounts never spend a paid allocation',async()=>{
  for(const state of [{subscriptionActive:false,subscriptionId:null},{subscriptionActive:false,subscriptionId:'ended'}]){
    start();let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('must not call');};
    try{assert.equal(await askModel({...store,...state},'system','prompt',100,'claude-sonnet-5-5'),null);assert.equal(calls,0);assert.equal(ledger.get(key)?.get('company'),'0');}
    finally{globalThis.fetch=old;}
  }
});

test('the provider cannot exceed the shared job call envelope even with spare money',async()=>{start();let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;return Response.json({content:[{type:'text',text:'A draft'}]});};try{const results=await withAiCallBudget('one',2,async()=>Promise.all(Array.from({length:20},()=>askModel(store,'system','prompt',100,'claude-sonnet-5-5'))));assert.equal(results?.filter(Boolean).length,2);assert.equal(calls,2);assert.equal(ledger.get(key)?.get('company'),'200');assert.equal(ledger.get(key)?.get('store:one:'+calendarPeriodId()),'200');}finally{globalThis.fetch=old;}});

test('marked paid AI work needs its contract cohort before spending or contacting the model',async()=>{
 start();let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('must not call');};
 try{
  const marked={...store,statsId:'a'.repeat(32),subscriptionId:'sub_AiCohortProof001',period:{...store.period!,funded:true as const}};
  assert.equal(await askModel(marked,'system','prompt',100,'claude-sonnet-5-5'),null);
  assert.equal(calls,0);assert.equal(ledger.get(key)?.get('company'),'0');
  assert.equal(ledger.get(key)?.get('store:one:'+calendarPeriodId()),undefined);
 }finally{globalThis.fetch=old;}
});
