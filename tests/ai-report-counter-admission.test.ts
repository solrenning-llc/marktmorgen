import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST as reviews } from "@/app/api/store/review-summary/route";
import { POST as numbers } from "@/app/api/store/numbers/ask/route";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { reset, state } from "./ai-report-counter-admission-world";
let passed=0,failed=0;
async function check(name:string,run:()=>Promise<void>){try{await run();passed++;console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}`,error);}}
const downstream=()=>[state.models,state.reads,state.allowances];
const request=(question="What changed?")=>new Request("https://example.com/api/store/reports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question,product:"p1234"})}) as NextRequest;
async function main(){
 for(const [name,route] of [["reviews",reviews],["numbers",numbers]] as const){
  for(const [label,reply] of [["missing",undefined],["empty",[]],["partial",["OK"]],["extra",["OK",1,true]],["text count",["OK","1"]],["null count",["OK",null]],["zero",["OK",0]],["negative",["OK",-1]],["fractional",["OK",0.5]],["unknown SET",[false,1]]] as [string,unknown][]){
   await check(`${name} refuses ${label} before model/data work`,async()=>{reset();state.override=true;state.reply=reply;const response=await route(request());assert.equal(response.status,429);assert.deepEqual(await response.json(),{ok:false,error:"slow"});assert.deepEqual(downstream(),[0,0,0]);assert.equal(state.commands.length,2);});
  }
  await check(`${name} refuses timeout before model/data work`,async()=>{reset();state.throws=true;assert.equal((await route(request())).status,429);assert.deepEqual(downstream(),[0,0,0]);assert.equal(state.commands.length,2);});
  await check(`${name} keeps confirmed minute quota and original counter`,async()=>{reset();for(let i=0;i<AI_PER_MINUTE;i++)assert.equal((await route(request())).status,200);assert.equal((await route(request())).status,429);assert.equal(state.models,AI_PER_MINUTE);assert.equal(state.commands.length,2*(AI_PER_MINUTE+1));assert.match(String(state.commands[0][1]),/^nl:rl:ai:[0-9a-f]{32}$/);assert.deepEqual(state.commands[0].slice(2),["0","EX",60,"NX"]);});
  await check(`${name} authorizes before counter`,async()=>{reset();state.authorized=false;assert.equal((await route(request())).status,403);assert.equal(state.commands.length,0);assert.deepEqual(downstream(),[0,0,0]);});
 }
 await check("numbers validates question before counter",async()=>{reset();assert.equal((await numbers(request("x"))).status,400);assert.equal(state.commands.length,0);assert.deepEqual(downstream(),[0,0,0]);});
 await check("numbers keeps monthly AI refusal before data read",async()=>{reset();state.left=0;assert.equal((await numbers(request())).status,400);assert.deepEqual(downstream(),[0,0,0]);});
 await check("numbers keeps studio quota refusal before data read",async()=>{reset();state.counted=false;assert.equal((await numbers(request())).status,429);assert.deepEqual(downstream(),[0,0,1]);});
 console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
