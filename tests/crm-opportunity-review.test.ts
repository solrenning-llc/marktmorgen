import test from "node:test";
import assert from "node:assert/strict";
import { dealVersion, readOpportunityReview } from "@/lib/crm";
import { DEFAULT_STAGES } from "@/lib/crm-rules";
import { store as redis } from "./redis-stub";
const sid="crm-review-synthetic";
const record=(id="deal000001",extra:Record<string,unknown>={})=>({id,title:"Qualified inquiry",email:"lead@example.test",stage:DEFAULT_STAGES[0].id,cents:0,note:"",createdAt:1760000000,updatedAt:1760000000,formResponseRef:"a".repeat(64),...extra});
// A store that never saved pipelines answers its third read (the pipelines) with nothing.
async function response(raw:unknown[]){const original=redis.pipeline;try{redis.pipeline=async()=>raw.length===2?[...raw,null]:raw;return await readOpportunityReview(sid);}finally{redis.pipeline=original;}}
test("confirmed empty CRM uses known default stages without inventing existing opportunities",async()=>{
  const result=await response([null,[]]);assert.equal(result.available,true);assert.deepEqual(result.stages,DEFAULT_STAGES);assert.deepEqual(result.deals,[]);
});
test("valid custom stages and linked records remain available",async()=>{
  const value=record();const result=await response([JSON.stringify(DEFAULT_STAGES),[value.id,JSON.stringify(value)]]);
  assert.equal(result.available,true);assert.equal(result.deals[0].formResponseRef,value.formResponseRef);assert.equal(result.deals[0].email,"lead@example.test");
});
test("confirmed missing, malformed and partial replies remain unavailable",async()=>{
  for(const raw of [[],[null],[null,undefined],[null,null],[null,{}],[null,["id"]],[null,[],[]],[undefined,[]],[true,[]]])
    assert.deepEqual(await response(raw),{available:false,stages:[],deals:[],pipelines:[],versions:{}});
});
test("malformed stage definitions cannot masquerade as known defaults",async()=>{
  for(const raw of ["not-json","null","[]",JSON.stringify([...DEFAULT_STAGES,{id:"bad",kind:"other"}]),JSON.stringify([...DEFAULT_STAGES,DEFAULT_STAGES[0]])])
    assert.equal((await response([raw,[]])).available,false);
});
test("a malformed record invalidates a negative matching inference",async()=>{
  const valid=record();for(const bad of ["not-json","null","[]",JSON.stringify({id:"deal000002",title:"No stage"})]){
    const result=await response([null,[valid.id,JSON.stringify(valid),"deal000002",bad]]);
    assert.equal(result.available,false);
  }
});
test("record identities and repeated hash fields must agree",async()=>{
  const value=record();for(const rows of [["deal000002",JSON.stringify(value)],[value.id,JSON.stringify(value),value.id,JSON.stringify(value)],[true,JSON.stringify(value)]])
    assert.equal((await response([null,rows])).available,false);
});
test("malformed source links and contact emails never become an empty match set",async()=>{
  for(const extra of [{formResponseRef:"invalid"},{formResponseRef:true},{email:12},{email:"not-an-email"}]){
    const value=record("deal000001",extra);assert.equal((await response([null,[value.id,JSON.stringify(value)]])).available,false);
  }
});
test("ordinary opportunities without a form source remain supported",async()=>{
  const value=record("deal000001",{formResponseRef:undefined,email:""});
  const result=await response([null,[value.id,JSON.stringify(value)]]);
  assert.equal(result.available,true);assert.equal(result.deals[0].formResponseRef,undefined);
});
test("supplier failure preserves Forms through an explicit unavailable result",async()=>{
  const original=redis.pipeline;try{redis.pipeline=async()=>{throw Error("offline");};assert.equal((await readOpportunityReview(sid)).available,false);}
  finally{redis.pipeline=original;}
});
test("one store-scoped batched read replaces the former separate CRM requests",async()=>{
  const original=redis.pipeline;let commands:unknown;
  try{redis.pipeline=async input=>{commands=input;return[null,[],null];};await readOpportunityReview(sid);}
  finally{redis.pipeline=original;}
  assert.deepEqual(commands,[["GET","nl:crm:stages:"+sid],["HGETALL","nl:crm:deals:"+sid],["GET","nl:crm:pipes:"+sid]]);
});
test("each deal's version is the hash of its exact stored record, read in the same batched step",async()=>{
  const one=record(),two=record("deal000002",{title:"Second inquiry"});const rawOne=JSON.stringify(one),rawTwo=JSON.stringify(two);
  const original=redis.pipeline;let calls=0;
  try{redis.pipeline=async()=>{calls++;return[null,[one.id,rawOne,two.id,rawTwo],null];};
    const result=await readOpportunityReview(sid);
    assert.deepEqual(result.versions,{[one.id]:dealVersion(rawOne),[two.id]:dealVersion(rawTwo)});
    assert.match(result.versions[one.id],/^[0-9a-f]{32}$/);
    assert.notEqual(dealVersion(rawOne),dealVersion(JSON.stringify({...one,stage:"won000"})));
    assert.equal(calls,1);
  }finally{redis.pipeline=original;}
});
test("an absent store cannot be treated as a confirmed empty CRM",async()=>{
  assert.deepEqual(await readOpportunityReview(null),{available:false,stages:[],deals:[],pipelines:[],versions:{}});
});
