/** Structural unknown read must not authorize creating a deal without reserving real data room. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createFormOpportunity} from "@/lib/form-opportunity";
import {DEFAULT_STAGES,type Deal} from "@/lib/crm-rules";
import {dataUsed} from "@/lib/store-data";
import {ROOM} from "../../../tests/data-room";
import {store as redis} from "../../../tests/redis-stub";
const real=redis.pipeline.bind(redis);
for(const shape of ["inherited","getter"] as const)test(`inherited MEDIUM sibling: ${shape} read slot cannot bypass deal room`,async()=>{
 redis.clear();const ref="c".repeat(64),id=ref.slice(0,10),stats="z3305-shape-"+shape,room={...ROOM,sid:stats},hash="nl:crm:deals:"+stats;
 const draft={id:"",title:"Synthetic form response",email:"synthetic@example.com",note:"Synthetic",cents:0,stage:"lead00",nextAction:"Review",dueDate:"2026-10-16",assignee:"owner@example.com",createdAt:1800000000,updatedAt:1800000000} as Deal;
 const raw=JSON.stringify({...draft,id,formResponseRef:ref});let changed=false,getters=0,error:unknown,state:unknown;const trace:(string|number)[][][]=[];
 redis.pipeline=async commands=>{
  trace.push(commands);const replies=await real(commands);
  if(!changed&&commands.some(c=>c[0]==="HGET"&&c[1]===hash)){
   changed=true;assert.deepEqual(replies,[null],"actual stored record is absent before rewriting ONLY the acknowledgment");
   if(shape==="inherited"){const a=new Array(1);Object.setPrototypeOf(a,Object.assign(Object.create(Array.prototype),{0:raw}));return a;}
   return Object.defineProperty(new Array(1),"0",{get(){getters++;return raw;}});
  }
  return replies;
 };
 try{state=(await createFormOpportunity(stats,ref,draft,DEFAULT_STAGES,room)).state;}catch(e){error=e;}finally{redis.pipeline=real;}
 const [stored]=await real([["HGET",hash,id]]),usage=await dataUsed(room);
 console.log("Z_UNFUNDED_SHAPE",JSON.stringify({shape,state,errorName:error instanceof Error?error.name:null,getters,actualRecordBytes:typeof stored==="string"?Buffer.byteLength(stored):0,actualUsed:usage?.used??null,productCommands:trace.flat().map(c=>c[0]),jsonPipelineBytes:trace.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0)}));
 assert.equal(stored,null,"a structurally unknown initial read must refuse before an unreserved deal is actually created");assert.ok(error instanceof Error);
});
