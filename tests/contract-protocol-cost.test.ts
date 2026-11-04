import assert from "node:assert/strict";
import test from "node:test";
import {contractProtocolInfrastructureCosts} from "@/lib/contract-protocol-cost";
import {CONTRACT_KEYS} from "@/lib/contract-funding-rules";
import {PUBLISHED_PLAN_PRICES} from "@/lib/plan";
import type {ProtocolInfrastructureBounds} from "@/lib/spend-cost-table";

function profiles(){
 return Object.fromEntries(CONTRACT_KEYS.map((key,index)=>[key,{
  functionCalls:0,memoryGbMilliseconds:0,cpuMilliseconds:0,redisCommands:10_000*(index+1),
  transferBytes:0,retainedBytes:0,retentionMonths:0,storageCopies:1,
 } satisfies ProtocolInfrastructureBounds]));
}
test("six independent monthly and annual profiles retain full precision and published prices",()=>{
 const input=profiles(),before=JSON.stringify(input);
 const output=contractProtocolInfrastructureCosts(input)!;
 assert.ok(output);
 assert.deepEqual(Object.keys(output),[...CONTRACT_KEYS]);
 assert.deepEqual(CONTRACT_KEYS.map(key=>output[key].infrastructureCents),[3,5,7,9,11,14]);
 for(const key of CONTRACT_KEYS){
  const [tier,cycle]=key.split("_") as ["creator"|"pro"|"scale","month"|"year"];
  assert.equal(output[key].publishedPriceCents,PUBLISHED_PLAN_PRICES[tier][cycle]);
  assert.equal(output[key].paidMonths,cycle==="month"?1:12);
  assert.equal(output[key].contractKey,key);
 }
 assert.notEqual(output.creator_year.infrastructureCents,output.creator_month.infrastructureCents*12);
 assert.equal(JSON.stringify(input),before);
});
test("one missing, invalid, inherited or computed profile refuses the whole comparison",()=>{
 let getters=0;
 for(const key of CONTRACT_KEYS){
  const input=profiles();delete input[key];
  assert.equal(contractProtocolInfrastructureCosts(input),null);
  assert.equal(contractProtocolInfrastructureCosts(Object.assign(Object.create({[key]:profiles()[key]}),input)),null);
  Object.defineProperty(input,key,{get(){getters++;return profiles()[key];},enumerable:true});
  assert.equal(contractProtocolInfrastructureCosts(input),null);
  for(const bad of [null,{},[],{...profiles()[key],retainedBytes:1,retentionMonths:0}]){
   assert.equal(contractProtocolInfrastructureCosts({...profiles(),[key]:bad}),null);
  }
 }
 assert.equal(getters,0);
 assert.equal(contractProtocolInfrastructureCosts({...profiles(),unknown_plan:profiles().creator_month}),null);
 assert.equal(contractProtocolInfrastructureCosts(null),null);
});
test("an unknown bound or overflowing annual retention cannot become a partial matrix",()=>{
 const input=profiles();
 const unknown={...input.creator_month};delete (unknown as Partial<ProtocolInfrastructureBounds>).transferBytes;
 assert.equal(contractProtocolInfrastructureCosts({...input,creator_month:unknown}),null);
 assert.equal(contractProtocolInfrastructureCosts({...input,scale_year:{...input.scale_year,retainedBytes:Number.MAX_SAFE_INTEGER,retentionMonths:Number.MAX_SAFE_INTEGER,storageCopies:Number.MAX_SAFE_INTEGER}}),null);
 assert.ok(contractProtocolInfrastructureCosts(input));
});


test("an unpriced category in any monthly or annual profile refuses the whole contract comparison", () => {
 for (const key of CONTRACT_KEYS) {
  for (const unreviewedSupplier of [null, 0, 100_000]) {
   const input = profiles();
   const value = {...input, [key]: {...input[key], unreviewedSupplier}};
   assert.equal(contractProtocolInfrastructureCosts(value), null, `${key}: ${unreviewedSupplier}`);
  }
 }
 assert.ok(contractProtocolInfrastructureCosts(profiles()));
});
