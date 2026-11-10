import assert from 'node:assert/strict';
import type {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/chat-summary/route';
import {CHAT_URL,reset,state,redis} from '../../tests/chat-counter-admission-world';
let pass=0,fail=0;
const ask=(body:Record<string,unknown>)=>POST(new Request('https://example.test/api/store/chat-summary',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}) as NextRequest);
const key='nl:chatsum:'+'f'.repeat(32);
const original=globalThis.fetch;
globalThis.fetch=async()=>{state.posts++;return new Response(null,{status:204});};
async function check(name:string,run:()=>Promise<void>){try{await run();pass++;console.log('PASS '+name);}catch(e){fail++;console.error('FAIL '+name,e);}}
async function main(){try{
for(const [label,value] of [['omitted',undefined],['null',null],['number',0],['boolean',false],['array',[]],['object',{}]] as const){await check('invalid URL '+label+' refuses without deleting an existing setting',async()=>{
 reset();assert.equal((await ask({url:CHAT_URL})).status,200);
 const before=(await redis.pipeline([['GET',key]]))[0];assert.equal(typeof before,'string');
 const commands=state.commands.length,posts=state.posts;
 const result=await ask({url:value});
 const after=(await redis.pipeline([['GET',key]]))[0];
 console.log(JSON.stringify({label,status:result.status,body:await result.json(),deleted:after===null,commands:state.commands.slice(commands).map(c=>c[0])}));
 assert.equal(result.status,400);assert.equal(after,before);assert.equal(state.posts,posts);
 });}
await check('explicit whitespace removal ignores an exceeded provider-test counter',async()=>{reset();state.override=true;state.reply=[null,11];const r=await ask({url:' \n\t '});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,result:'removed'});assert.deepEqual(state.commands.map(c=>c[0]),['DEL']);assert.equal(state.posts,0);});
await check('unauthorized removal cannot touch configuration or provider',async()=>{reset();state.authorized=false;const r=await ask({url:''});assert.equal(r.status,403);assert.equal(state.commands.length,0);assert.equal(state.posts,0);});
await check('unknown counter refuses a URL while leaving the existing setting',async()=>{reset();assert.equal((await ask({url:CHAT_URL})).status,200);const before=(await redis.pipeline([['GET',key]]))[0];state.override=true;state.reply=['OK',null];const posts=state.posts;const r=await ask({url:CHAT_URL});assert.equal(r.status,503);assert.deepEqual(await r.json(),{ok:false,error:'unavailable'});assert.equal((await redis.pipeline([['GET',key]]))[0],before);assert.equal(state.posts,posts);});
await check('invalid provider URL never posts or changes a kept setting',async()=>{reset();assert.equal((await ask({url:CHAT_URL})).status,200);const before=(await redis.pipeline([['GET',key]]))[0];const posts=state.posts;const r=await ask({url:'https://example.test/unsupported'});assert.equal(r.status,400);assert.deepEqual(await r.json(),{ok:false,error:'invalid'});assert.equal((await redis.pipeline([['GET',key]]))[0],before);assert.equal(state.posts,posts);});
}finally{globalThis.fetch=original;}console.log(pass+' PASS; '+fail+' FAIL');process.exitCode=fail?1:0;}
main().catch(e=>{console.error(e);process.exitCode=1;});
