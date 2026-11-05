import assert from 'node:assert/strict';
import test from 'node:test';
import {assessCustomerWorstCase,customerCostSnapshot,CUSTOMER_COST_CATEGORIES} from '../lib/net-margin-rules';
import {fundedCustomerScenario} from './margin-test-fixtures';
test('a late descriptor trap cannot change a captured cost into approval',()=>{
 const input=fundedCustomerScenario();let reads=0;const original=input.costCeilings;
 input.costCeilings=new Proxy(original,{getOwnPropertyDescriptor(target,key){if(key==='other')Object.defineProperty(target,'infrastructure',{configurable:true,enumerable:true,get(){reads++;return 0;}});return Reflect.getOwnPropertyDescriptor(target,key);}});
 const result=assessCustomerWorstCase(input);assert.equal(result.approved,false);assert.equal(result.reason,'unknown');assert.equal(reads,0);
});
test('own hidden, symbol and missing costs never yield complete approved evidence',()=>{
 for(const kind of ['hidden','symbol','missing']){
  const input=fundedCustomerScenario();if(kind==='missing')delete input.costCeilings.other;else Object.defineProperty(input.costCeilings,kind==='symbol'?Symbol('unknown'):'unknown',{value:null,enumerable:false});
  assert.equal(customerCostSnapshot(input.costCeilings),null);assert.equal(assessCustomerWorstCase(input).approved,false);
 }
});
test('native probe only sees complete scalar maps, never invalid nested graph',()=>{
 const saved=globalThis.structuredClone;const seen:unknown[]=[];
 globalThis.structuredClone=((value:unknown)=>{seen.push(value);return saved(value);}) as typeof structuredClone;
 try{
  const input=fundedCustomerScenario();assert.equal(assessCustomerWorstCase(input).approved,true);assert.equal(seen.length,1);assert.equal(seen[0],input.costCeilings);
  let reads=0;for(const value of [null,undefined,{},new Proxy({get nested(){reads++;return 0;}},{})]){
   const malformed=fundedCustomerScenario();Object.assign(malformed.costCeilings,{other:value});assert.equal(assessCustomerWorstCase(malformed).approved,false);
  }
  assert.equal(seen.length,1);assert.equal(reads,0);
 }finally{globalThis.structuredClone=saved;}
});
test('the same detached scalar costs survive later mutation of the original map',()=>{
 const input=fundedCustomerScenario();const snapshot=customerCostSnapshot(input.costCeilings)!;const before=Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,snapshot[key]]));
 for(const key of CUSTOMER_COST_CATEGORIES)input.costCeilings[key]=0;
 assert.deepEqual({...snapshot},before);assert.equal(Object.getPrototypeOf(snapshot),null);
});
