import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import type {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/chat-summary/route';
import {CHAT_URL,reset,state,redis} from './chat-counter-admission-world';
const key='nl:chatsum:'+'f'.repeat(32);
globalThis.fetch=async(input,init)=>{assert.equal(String(input),CHAT_URL);assert.equal(init?.method,'POST');state.posts++;return new Response(null,{status:204});};
const ask=(url:unknown)=>POST(new Request('https://example.invalid/api/store/chat-summary',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}) as NextRequest);
async function seed(){reset();assert.equal((await ask(CHAT_URL)).status,200);const kept=redis.run(['GET',key]);assert.equal(typeof kept,'string');assert.match(String(kept),/^s1\./);state.commands=[];state.posts=0;return kept;}
for(const blank of ['','  ','\n\t'])test('a real sealed setting is removed despite unknown provider counter '+JSON.stringify(blank),async()=>{
 await seed();state.override=true;state.reply=['OK',null];
 const response=await ask(blank);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,result:'removed'});
 assert.deepEqual(state.commands.map(c=>c[0]),['DEL']);assert.equal(redis.run(['GET',key]),null);assert.equal(state.posts,0);
});
for(const exceeded of [false,true])test('a refused save preserves an existing sealed setting '+exceeded,async()=>{
 const kept=await seed();state.override=true;state.reply=exceeded?[null,11]:['OK',null];
 const response=await ask(CHAT_URL);assert.equal(response.status,exceeded?429:503);assert.deepEqual(await response.json(),{ok:false,error:exceeded?'rate_limited':'unavailable'});
 assert.deepEqual(state.commands.map(c=>c[0]),['SET','INCR']);assert.equal(redis.run(['GET',key]),kept);assert.equal(state.posts,0);
});
test('authorization still protects a real sealed setting during counter failure',async()=>{
 const kept=await seed();state.authorized=false;state.throws=true;
 const response=await ask(' ');assert.equal(response.status,403);assert.equal(state.commands.length,0);assert.equal(state.posts,0);assert.equal(redis.run(['GET',key]),kept);
});
