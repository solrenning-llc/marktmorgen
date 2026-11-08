import {test} from "node:test";
import assert from "node:assert/strict";
import {claimHandle,ensureStatsId,setAffiliateSetting,setSubscription,storeForEmail,type Store} from "@/lib/store";
import {NO_AFFILIATES} from "@/lib/affiliate-setting";
import {recordLead,leadId} from "@/lib/affiliate-leads";
import {leadsKey} from "@/lib/affiliate-lead-rules";
import {dataKey} from "@/lib/store-data";
import {dataBytes} from "@/lib/store-data-rules";
import {store as redis} from "../../../tests/redis-stub";
import {paidPeriod} from "../../../tests/billing-period-fixture";
type Batch=(string|number)[][];
const owner="z3295-owner@example.com",aff="a".repeat(12),now=Math.floor(Date.now()/1000);
let ready:Promise<Store>|undefined,n=0;
function setup(){return ready??=(async()=>{
 redis.clear();await claimHandle(owner,"z3295room","Synthetic Room","");await ensureStatsId(owner);
 await setSubscription(owner,{customerId:"cus_synthetic3295",subscriptionId:"sub_synthetic3295",active:true,tier:"creator",trialEnds:0,period:paidPeriod()});
 await setAffiliateSetting(owner,{...NO_AFFILIATES,enabled:true,lead:{kind:"signup",cents:300,hold:14,daily:5,budget:10000}});
 const s=(await storeForEmail(owner))!;
 await redis.pipeline([["HSET",`nl:aff:${s.statsId}:people`,aff,JSON.stringify({id:aff,email:"synthetic-aff@example.com",code:"z3295",status:"approved",appliedAt:(now-30*86400)*1000,decidedAt:1,note:""})]]);return s;
})();}
const counts=()=> (globalThis as typeof globalThis & {__zCounts:()=>{runs:number;mocks:number;over:boolean}}).__zCounts();
const shapes:[string,()=>unknown][]=[
 ["empty",()=>[]],["nil",()=>[null]],["extra",()=>[1,1]],["hole",()=>Array(1)],
 ["inherited",()=>Object.setPrototypeOf(Array(1),Object.assign(Object.create(Array.prototype),{0:1}))],
 ["getter",()=>Object.defineProperty([0],"0",{get(){throw Error("getter executed");}})],
 ["frozen bad",()=>Object.freeze(["1"])],["fraction",()=>[0.5]],["negative",()=>[-1]],["NaN",()=>[NaN]],
 ["infinity",()=>[Infinity]],["unsafe",()=>[Number.MAX_SAFE_INTEGER+1]],["object",()=>[{}]],["false",()=>[false]],
];
async function observe(label:string,reply:{value:unknown}|null,land=true,email?:string,throwAfter=false){
 const s=await setup(), original=redis.pipeline.bind(redis),ledger=dataKey(s)!,key=leadsKey(s.statsId!);
 const to=email??`lead${++n}@buyer.example`;
 const snapshot=async()=>{const [slot,total,row]=await original([["HGET",ledger,"aff:leads"],["HGET",ledger,"#"],["HGET",key,leadId(s.statsId!,to)]]);return {slot:Number(slot??0),total:Number(total??0),row};};
 const before=await snapshot(),c0=counts(),batches:Batch[]=[];let admitted=0,wanted=0,actualReply:unknown=null;
 redis.pipeline=async(batch)=>{
  batches.push(batch);
  if(batch.length===1&&batch[0][0]==="HSETNX"&&batch[0][1]===key){
   const [v]=await original([["HGET",ledger,"aff:leads"]]);admitted=Number(v??0);
   wanted=dataBytes([String(batch[0][2]),String(batch[0][3]),"0000000000other"],1);
   if(land) actualReply=await original(batch);
   if(throwAfter)throw Error("synthetic lost ACK after real lead write");
   if(reply)return reply.value as unknown[];
   return actualReply as unknown[];
  }
  return original(batch);
 };
 let result;try{result=await recordLead(s,{aff,kind:"signup",email:to});}finally{redis.pipeline=original;}
 const c1=counts(),after=await snapshot();
 const record={label,result,slotDelta:after.slot-before.slot,totalDelta:after.total-before.total,stored:typeof after.row==="string",admittedDelta:admitted-before.slot,wanted,
  rowBytes:typeof after.row==="string"?Buffer.byteLength(after.row):0,actualReply,commands:batches.flat().map(c=>c[0]==="EVAL"?"EVAL":c[0]),jsonPipelineBytes:batches.reduce((n,b)=>n+Buffer.byteLength(JSON.stringify(b)),0),nestedRedis:c1.runs-c0.runs,mockHttp:c1.mocks-c0.mocks};
 console.log("Z_CASE",JSON.stringify(record));return record;
}
for(const [label,make] of shapes)test(`real committed HSETNX, unknown receipt ${label}`,async()=>{
 const v=await observe(label,{value:make()});assert.equal(v.stored,true);assert.deepEqual(v.actualReply,[1]);
 assert.equal(v.result,"unavailable");assert.equal(v.admittedDelta,v.wanted);assert.equal(v.slotDelta,v.wanted);assert.ok(v.totalDelta>=v.wanted);
});
test("lost ACK after actual write retains room",async()=>{const v=await observe("throw after commit",null,true,undefined,true);assert.equal(v.result,"unavailable");assert.equal(v.stored,true);assert.equal(v.slotDelta,v.wanted);assert.equal(v.admittedDelta,v.wanted);});
test("unknown ACK without a committed write safely retains room",async()=>{const v=await observe("no write unknown",{value:[null]},false);assert.equal(v.result,"unavailable");assert.equal(v.stored,false);assert.equal(v.slotDelta,v.wanted);});
test("confirmed frozen1 writes once, frozen0 returns only duplicate reservation",async()=>{
 const email="frozen-control@buyer.example";const first=await observe("frozen1",{value:Object.freeze([1])},true,email);assert.equal(first.result,"recorded");assert.equal(first.slotDelta,first.wanted);assert.equal(first.stored,true);assert.equal(first.admittedDelta,first.wanted);
 const second=await observe("frozen0",{value:Object.freeze([0])},true,email);assert.deepEqual(second.actualReply,[0]);assert.equal(second.result,"duplicate");assert.equal(second.slotDelta,0);assert.equal(second.totalDelta,0);assert.equal(second.stored,true);
});
