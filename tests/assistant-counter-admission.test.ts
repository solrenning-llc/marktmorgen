import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/assistant/route";
import { ASSISTANT_PER_TEN_MINUTES,ASSISTANT_PER_DAY,ASSISTANT_STORE_PER_MINUTE } from "@/lib/store-assistant-rules";
import {redis,reset,state} from "./assistant-counter-admission-world";
let passed=0,failed=0;
async function check(name:string,run:()=>Promise<void>){try{await run();passed++;console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}`,error);}}
const ask=(action="ask",ip="198.51.100.1",origin="https://example.com")=>POST(new Request("https://example.com/api/store/assistant",{method:"POST",headers:{host:"example.com",origin,"x-forwarded-for":ip,"Content-Type":"application/json"},body:JSON.stringify({handle:"test-assistant",action,text:"What is included?",token:"synthetic-token"})}) as NextRequest);
async function main(){
 for(const [stage,scope] of ["assist","assist-day","assist-store"].entries()){
  for(const [label,reply] of [["missing",undefined],["empty",[]],["partial",["OK"]],["extra",["OK",1,true]],["text",["OK","1"]],["null",["OK",null]],["zero",["OK",0]],["negative",["OK",-1]],["fractional",["OK",0.5]],["unknown SET",[false,1]]] as [string,unknown][]){
   await check(`${scope} refuses ${label} before paid reply`,async()=>{reset();state.scope=scope;state.reply=reply;const response=await ask();assert.equal(response.status,429);assert.deepEqual(await response.json(),{ok:false,error:"slow"});assert.equal(state.models,0);assert.equal(state.publics,0);assert.equal(state.commands.length,2*(stage+1));});
  }
  await check(`${scope} refuses timeout before paid reply`,async()=>{reset();state.scope=scope;state.throws=true;assert.equal((await ask()).status,429);assert.equal(state.models,0);assert.equal(state.commands.length,2*(stage+1));});
 }
 await check("confirmed counters preserve visitor ceiling and all original keys/TTLs",async()=>{reset();for(let i=0;i<ASSISTANT_PER_TEN_MINUTES;i++)assert.equal((await ask()).status,200);assert.equal((await ask()).status,429);assert.equal(state.models,ASSISTANT_PER_TEN_MINUTES);for(const [index,scope,ttl] of [[0,"assist",600],[2,"assist-day",86400],[4,"assist-store",60]] as const){assert.match(String(state.commands[index][1]),new RegExp(`^nl:rl:${scope}:[0-9a-f]{32}$`));assert.deepEqual(state.commands[index].slice(2),["0","EX",ttl,"NX"]);}});
 // Added 9 Nov 2026 (audit ALTO 2): every ask that passes the burst limits is one of the store's public requests (withinStore), before the model.
 await check("ask is a public request of the store, counted after the burst limits",async()=>{reset();assert.equal((await ask()).status,200);assert.equal(state.publics,1);assert.equal(state.models,1);});
 await check("confirmed counters preserve daily ceiling across minute windows",async()=>{reset();for(let i=0;i<ASSISTANT_PER_DAY;i++){if(i%ASSISTANT_PER_TEN_MINUTES===0)redis.advance(601000);assert.equal((await ask()).status,200);}redis.advance(601000);assert.equal((await ask()).status,429);assert.equal(state.models,ASSISTANT_PER_DAY);});
 await check("confirmed counters preserve store ceiling across different visitors",async()=>{reset();for(let i=0;i<ASSISTANT_STORE_PER_MINUTE;i++)assert.equal((await ask("ask",`198.51.100.${i+1}`)).status,200);assert.equal((await ask("ask","198.51.100.254")).status,429);assert.equal(state.models,ASSISTANT_STORE_PER_MINUTE);});
 await check("lost acknowledgement keeps its committed increment consumed",async()=>{reset();state.scope="assist";state.commit=true;state.reply=[];assert.equal((await ask()).status,429);state.scope="";for(let i=0;i<ASSISTANT_PER_TEN_MINUTES-1;i++)assert.equal((await ask()).status,200);assert.equal((await ask()).status,429);assert.equal(state.models,ASSISTANT_PER_TEN_MINUTES-1);});
 for(const [action,field] of [["read","reads"],["delete","deletes"],["handoff","handoffs"]] as const)await check(`${action} keeps its public quota path`,async()=>{reset();state.scope="assist";state.throws=true;assert.equal((await ask(action)).status,200);assert.equal(state[field],1);assert.equal(state.models,0);assert.equal(state.publics,1);assert.equal(state.commands.length,0);});
 await check("cross-origin requests are refused before store/counters",async()=>{reset();assert.equal((await ask("ask","198.51.100.1","https://elsewhere.example")).status,403);assert.deepEqual([state.lookups,state.models,state.commands.length],[0,0,0]);});
 await check("disabled assistant does not take counters",async()=>{reset();state.shown=false;assert.equal((await ask()).status,400);assert.equal(state.commands.length,0);assert.equal(state.models,0);});
 console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
