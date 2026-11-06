/** Local reply-contract evidence, not a REST/JSON or live-supplier exploit. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reserveAiSpend} from '../lib/ai-spend';
import {aiSpendLedgerKey,aiSpendPolicySnapshot,type AiSpendPolicy} from '../lib/ai-spend-policy';
import {reset,seed,settings,ledger,calls} from './ai-spend-redis';

function policy():AiSpendPolicy {
 return {reviewId:'test_review',month:new Date().toISOString().slice(0,7),evidence:'Synthetic test fixture, not an approved production price',requestMicroUsd:{'claude-sonnet-5-5':100,'claude-haiku-5-5':20},storeMicroUsd:{creator:300,pro:500,scale:1000,trial:0,setup:0,ended:0},companyMicroUsd:400,fundedStores:{creator:1,pro:0,scale:0,trial:0,setup:0,ended:0}};
}
let traps=0;
const cases:[string,()=>unknown][]=[
 ['inherited slot',()=>{
  const value=new Array(1);const prototype=Object.create(Array.prototype);
  Object.defineProperty(prototype,'0',{value:1});Object.setPrototypeOf(value,prototype);return value;
 }],
 ['own accessor',()=>{
  const value=new Array(1);Object.defineProperty(value,'0',{get(){traps++;return 1;}});return value;
 }],
 // Promise assimilation may ask for `then` before the reader receives it;
 // count only the receipt properties evaluated by the admission guard.
 ['proxy',()=>new Proxy([1],{get(target,key,receiver){if(key==='length'||key==='0')traps++;return Reflect.get(target,key,receiver);}})],
 ['array-like object',()=>({length:1,0:1})],
];
for(const [name,reply] of cases){
 test(`non-automatic reservation refuses ${name} without inspecting executable slots`,async()=>{
  reset();traps=0;const p=policy(),key=aiSpendLedgerKey(p.month);
  seed(key,p.reviewId,aiSpendPolicySnapshot(p),p.fundedStores);
  settings({response:reply() as unknown[]}); // Existing contract fixture returns before executing the script.
  const accepted=await reserveAiSpend('synthetic-store','creator','claude-sonnet-5-5',p);
  assert.equal(calls.length,1);assert.equal(calls[0].length,1);assert.equal(calls[0][0][0],'EVAL');
  assert.equal(ledger.get(key)?.get('company'),'0');assert.equal(ledger.get(key)?.has('store:synthetic-store'),false);
  console.log('EVIDENCE',JSON.stringify({name,accepted,appCommands:1,fixtureCompanyMicroUsd:'0',fixtureStoreFieldPresent:false,executableReads:traps,realProviderCalls:0,scope:'synthetic non-automatic policy and local JS envelope only'}));
  assert.deepEqual({accepted,executableReads:traps},{accepted:false,executableReads:0});
 });
}
test('a healthy reservation really consumes the contract fixture ledger',async()=>{
 reset();const p=policy(),key=aiSpendLedgerKey(p.month);seed(key,p.reviewId,aiSpendPolicySnapshot(p),p.fundedStores);
 assert.equal(await reserveAiSpend('synthetic-store','creator','claude-sonnet-5-5',p),true);
 assert.equal(ledger.get(key)?.get('company'),'100');assert.equal(ledger.get(key)?.get('store:synthetic-store'),'100');
 assert.equal(calls.length,1);
});
test('ordinary ambiguous acknowledgements are already refused',async()=>{
 for(const response of [[],[0],[null],[true],['1'],[1,1]]){
  reset();const p=policy(),key=aiSpendLedgerKey(p.month);seed(key,p.reviewId,aiSpendPolicySnapshot(p),p.fundedStores);settings({response});
  assert.equal(await reserveAiSpend('synthetic-store','creator','claude-sonnet-5-5',p),false);
  assert.equal(ledger.get(key)?.get('company'),'0');assert.equal(calls.length,1);
 }
});
