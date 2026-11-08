/** Independent canonical-counter boundary; real reader, synthetic Redis transport. */
import {test} from "node:test";
import {strict as assert} from "node:assert";
import {allowanceUsedExact,allowancesUsedStrict} from "@/lib/store-allowance";
import {paidPeriod} from "./billing-period-fixture";
import {store as redis} from "./redis-stub";
const store={sid:"z".repeat(32),statsId:null,handle:"z3169",tier:"creator" as const,subscriptionActive:true,subscriptionId:"sub_Z316900001",trialEnds:0,planEndedAt:"",cycle:"month" as const,period:paidPeriod()};
const real=redis.pipeline.bind(redis);
for(const value of [""," ","0x0","0.0","0e4"]){
 test(`noncanonical counter ${JSON.stringify(value)} is unknown`,async()=>{
  redis.clear();let commands=0;
  redis.pipeline=async batch=>{commands+=batch.length;return [value];};
  try{const strict=await allowancesUsedStrict(store,["email"]);const exact=await allowanceUsedExact(store,"email");console.log(JSON.stringify({value,strict,exact,commands}));assert.equal(exact,null);assert.equal(strict,null);}finally{redis.pipeline=real;}
 });
}
for(const [value,expected] of [[null,0],["0",0],["25",25],[25,25],["many",null],["-1",null]] as [unknown,number|null][]){
 test(`control ${JSON.stringify(value)} returns ${expected}`,async()=>{
  redis.clear();redis.pipeline=async()=>[value];
  try{assert.equal(await allowanceUsedExact(store,"email"),expected);}finally{redis.pipeline=real;}
 });
}
