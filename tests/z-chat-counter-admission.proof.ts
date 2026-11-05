import assert from "node:assert/strict";
import type {NextRequest} from "next/server";
import {POST} from "@/app/api/store/chat-summary/route";
import {CHAT_URL,reset,state} from "./z-chat-counter-world";
let passed=0,failed=0;
async function check(name:string,run:()=>Promise<void>){try{await run();passed++;console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}`,error);}}
const ask=(body:Record<string,unknown>={url:CHAT_URL})=>POST(new Request("https://example.com/api/store/chat-summary",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}) as NextRequest);
const writes=()=>state.commands.filter(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:chatsum:"));
async function main(){
 const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{assert.equal(String(input),CHAT_URL,"No other supplier URL allowed");assert.equal(init?.method,"POST");assert.equal(typeof init?.body,"string");state.posts++;state.postBytes+=Buffer.byteLength(init.body as string);return new Response(null,{status:204});};
 try{
  for(const [name,reply] of [["missing",undefined],["empty",[]],["partial",["OK"]],["unknown SET",[false,1]],["null count",["OK",null]],["text count",["OK","1"]],["extra",["OK",1,true]]] as [string,unknown][])await check(`unknown ${name} refuses before actual chat POST/write`,async()=>{reset();state.override=true;state.reply=reply;const response=await ask();console.log(JSON.stringify({case:name,status:response.status,counterCommands:state.commands.filter(c=>String(c[1]).startsWith("nl:rl:")).length,posts:state.posts,postBytes:state.postBytes,settingWrites:writes().length,settingCommandBytes:writes().reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0)}));assert.equal(response.status,429);assert.equal(state.posts,0);assert.equal(writes().length,0);});
  await check("counter timeout refuses before actual chat POST/write",async()=>{reset();state.throws=true;const response=await ask();console.log(JSON.stringify({case:"timeout",status:response.status,commands:state.commands.length,posts:state.posts,postBytes:state.postBytes,settingWrites:writes().length}));assert.equal(response.status,429);assert.equal(state.posts,0);assert.equal(writes().length,0);});
  await check("confirmed counter posts and seals exactly once",async()=>{reset();const response=await ask();assert.equal(response.status,200);assert.equal(state.posts,1);assert.ok(state.postBytes>0);assert.equal(writes().length,1);assert.match(String(writes()[0][2]),/^s1\./);assert.deepEqual(state.commands[0].slice(2),["0","EX",3600,"NX"]);});
  await check("confirmed exceeded counter keeps its refusal",async()=>{reset();state.override=true;state.reply=[null,11];assert.equal((await ask()).status,429);assert.equal(state.posts,0);assert.equal(writes().length,0);});
  await check("sales toggle remains outside provider-test counter",async()=>{reset();state.throws=true;assert.equal((await ask({sales:true})).status,200);assert.deepEqual([state.toggles,state.posts,state.commands.length],[1,0,0]);});
  await check("authorization refusal precedes counter/provider",async()=>{reset();state.authorized=false;assert.equal((await ask()).status,403);assert.deepEqual([state.posts,state.commands.length],[0,0]);});
  await check("invalid provider URL retains known refusal",async()=>{reset();assert.equal((await ask({url:"https://example.com/not-a-webhook"})).status,400);assert.equal(state.posts,0);assert.equal(writes().length,0);});
 }finally{globalThis.fetch=original;}
 console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
