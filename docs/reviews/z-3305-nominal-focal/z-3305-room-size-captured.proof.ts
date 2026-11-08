/** Same existing response with a smaller retry draft; actual room and actual hash, no fake committed deal. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFormOpportunity } from "@/lib/form-opportunity";
import { DEFAULT_STAGES, type Deal } from "@/lib/crm-rules";
import { dealBytes,dealSlot } from "@/lib/crm";
import { dataUsed,dataKey } from "@/lib/store-data";
import { ROOM } from "../../../tests/data-room";
import { store as redis } from "../../../tests/redis-stub";
const real=redis.pipeline.bind(redis);
test("inherited MEDIUM: unread existing deal must keep its actual larger room when the retry draft is smaller",async()=>{
 redis.clear();const room={...ROOM,sid:"z3305-room-size"},stats="z3305-room-size",ref="b".repeat(64),id=ref.slice(0,10),hash="nl:crm:deals:"+stats;
 const draft={id:"",title:"Synthetic form response",email:"synthetic@example.com",note:"x".repeat(500),cents:0,stage:"lead00",nextAction:"Review",dueDate:"2026-10-16",assignee:"owner@example.com",createdAt:1800000000,updatedAt:1800000000} as Deal;
 assert.equal((await createFormOpportunity(stats,ref,draft,DEFAULT_STAGES,room)).state,"created");
 const before=await dataUsed(room),[raw]=await real([["HGET",hash,id]]);assert.equal(typeof raw,"string");
 const stored=JSON.parse(String(raw)) as Deal;let missed=false;const batches:(string|number)[][][]=[];
 redis.pipeline=async commands=>{batches.push(commands);if(!missed&&commands.some(c=>c[0]==="HGET"&&c[1]===hash)){missed=true;throw new Error("synthetic existing-deal read unavailable");}return real(commands);};
 let state,error:unknown;try{state=(await createFormOpportunity(stats,ref,{...draft,note:"x"},DEFAULT_STAGES,room)).state;}catch(e){error=e;}finally{redis.pipeline=real;}
 const after=await dataUsed(room),[still,slot]=await real([["HGET",hash,id],["HGET",dataKey(room)!,dealSlot(id)]]);
 console.log("Z_ROOM_SIZE",JSON.stringify({missed,state,errorName:error instanceof Error?error.name:null,beforeUsed:before?.used,afterUsed:after?.used,actualDealBytes:dealBytes(stored),actualRecordBytes:Buffer.byteLength(String(still)),recordUnchanged:still===raw,reservedSlot:slot,commands:batches.flat().map(c=>c[0]),jsonPipelineBytes:batches.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0)}));

 assert.ok(after&&before&&after.used>=before.used,"an unchanged stored deal must not lose its existing reserved room merely because a smaller retry draft could not read it");
 assert.equal(missed,true);assert.equal(state,undefined);assert.ok(error instanceof Error);assert.equal(still,raw);
});
