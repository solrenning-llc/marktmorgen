import assert from "node:assert/strict";
import test from "node:test";
import {protocolInfrastructureMicroUsd,type ProtocolInfrastructureBounds} from "@/lib/spend-cost-table";

const zero:ProtocolInfrastructureBounds={functionCalls:0,memoryGbMilliseconds:0,cpuMilliseconds:0,redisCommands:0,transferBytes:0,retainedBytes:0,retentionMonths:0,storageCopies:1};
test("protocol pricing rounds every infrastructure component up and adds the canonical allowance",()=>{
 assert.deepEqual(protocolInfrastructureMicroUsd({...zero,functionCalls:1,memoryGbMilliseconds:1000,cpuMilliseconds:1000,redisCommands:1,transferBytes:1,retainedBytes:1,retentionMonths:1}),{baseMicroUsd:44,providerAllowanceMicroUsd:5,totalMicroUsd:49});
 assert.deepEqual(protocolInfrastructureMicroUsd(zero),{baseMicroUsd:0,providerAllowanceMicroUsd:0,totalMicroUsd:0});
});
test("retention includes every explicit replica and month without a free storage tier",()=>{
 assert.deepEqual(protocolInfrastructureMicroUsd({...zero,retainedBytes:1_000_000_000,retentionMonths:12,storageCopies:3}),{baseMicroUsd:9_000_000,providerAllowanceMicroUsd:900_000,totalMicroUsd:9_900_000});
 assert.equal(protocolInfrastructureMicroUsd({...zero,retainedBytes:1}),null);
 assert.equal(protocolInfrastructureMicroUsd({...zero,storageCopies:0}),null);
});
test("unknown, inherited and computed protocol bounds never become zero or execute getters",()=>{
 let getters=0;
 for(const key of Object.keys(zero)){
  const missing={...zero};delete (missing as Partial<ProtocolInfrastructureBounds>)[key as keyof ProtocolInfrastructureBounds];
  assert.equal(protocolInfrastructureMicroUsd(missing),null);
  const inherited=Object.assign(Object.create({[key]:zero[key as keyof ProtocolInfrastructureBounds]}),missing);
  assert.equal(protocolInfrastructureMicroUsd(inherited),null);
  const computed={...missing};
  Object.defineProperty(computed,key,{get(){getters++;return 0;},enumerable:true});
  assert.equal(protocolInfrastructureMicroUsd(computed),null);
  for(const value of [null,undefined,-1,0.5,NaN,Infinity,"0",true,Number.MAX_SAFE_INTEGER+1]){
   assert.equal(protocolInfrastructureMicroUsd({...zero,[key]:value} as unknown as ProtocolInfrastructureBounds),null);
  }
 }
 assert.equal(getters,0);
 assert.equal(protocolInfrastructureMicroUsd(null),null);
 assert.equal(protocolInfrastructureMicroUsd([] as unknown as ProtocolInfrastructureBounds),null);
});
test("large products use exact arithmetic and refuse an unrepresentable reservation",()=>{
 assert.equal(protocolInfrastructureMicroUsd({...zero,retainedBytes:Number.MAX_SAFE_INTEGER,retentionMonths:Number.MAX_SAFE_INTEGER,storageCopies:Number.MAX_SAFE_INTEGER}),null);
 const bound={...zero,functionCalls:1_000_000,memoryGbMilliseconds:3_600_000,cpuMilliseconds:3_600_000,redisCommands:1_000_000,transferBytes:1_000_000_000};
 const first=protocolInfrastructureMicroUsd(bound)!;
 assert.deepEqual(first,{baseMicroUsd:2_768_600,providerAllowanceMicroUsd:276_860,totalMicroUsd:3_045_460});
 assert.ok(protocolInfrastructureMicroUsd({...bound,redisCommands:1_000_001})!.totalMicroUsd>first.totalMicroUsd);
 assert.equal(Object.keys(bound).length,8);
});


test("extra unpriced protocol categories are unknown, never a known zero", () => {
 for (const extra of [null, undefined, 0, 100_000]) {
  assert.equal(protocolInfrastructureMicroUsd({...zero, unreviewedSupplier: extra} as ProtocolInfrastructureBounds), null);
 }
 const symbol = {...zero, [Symbol("unreviewed supplier")]: null};
 const hidden = Object.defineProperty({...zero}, "unreviewedSupplier", {value: null});
 let getters = 0;
 const computed = Object.defineProperty({...zero}, "unreviewedSupplier", {get(){getters++;return 100_000;}});
 for (const input of [symbol, hidden, computed]) assert.equal(protocolInfrastructureMicroUsd(input), null);
 assert.equal(getters, 0);
});

test("protocol evidence is plain own enumerable data while frozen and null-prototype data stay exact", () => {
 for (const key of Object.keys(zero)) {
  const hidden = Object.defineProperty({...zero}, key, {enumerable: false});
  assert.equal(protocolInfrastructureMicroUsd(hidden), null, key);
 }
 const derived = Object.assign(Object.create({unreviewedSupplier: null}), zero);
 const unreadable = new Proxy({...zero}, {getPrototypeOf(){throw Error("unreadable profile");}});
 const revoked = Proxy.revocable({...zero}, {});
 revoked.revoke();
 for (const input of [derived, unreadable, revoked.proxy]) assert.equal(protocolInfrastructureMicroUsd(input), null);
 const bound = {...zero, redisCommands: 1_000_000, retainedBytes: 1_000_000, retentionMonths: 12};
 const expected = protocolInfrastructureMicroUsd(bound);
 assert.ok(expected && expected.totalMicroUsd > 0);
 assert.deepEqual(protocolInfrastructureMicroUsd(Object.freeze({...bound})), expected);
 assert.deepEqual(protocolInfrastructureMicroUsd(Object.assign(Object.create(null), bound)), expected);
});
