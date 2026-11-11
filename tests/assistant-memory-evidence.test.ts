/**
 * Codex G2 on #1949, kept as permanent tests: the assistant's notes read,
 * written and forgotten only on Redis's exact answers, their room never below
 * what is kept, and a change still in flight never bringing the notes back
 * after they are forgotten. The interceptions read the record's fenced write
 * and forgetting (MEMORY_WRITE, MEMORY_FORGET) as its SET and DEL.
 */
import {test} from 'node:test';import assert from 'node:assert/strict';
import {keepNote,forgetMemory,readMemory} from '@/lib/assistant-memory-store';
import {dataKey} from '@/lib/store-data';import {dataBytes} from '@/lib/store-data-rules';
import {store as redis} from './redis-stub';import {ROOM} from './data-room';
const stats='G2MemoryEvidence',room={...ROOM,sid:'g2-memory-room'},key=`nl:amem:${stats}`;
// The record's write and delete as they are sent now: a SET or DEL, or the scripts that hold them (MEMORY_WRITE, MEMORY_FORGET).
const sets=(c:(string|number)[])=>(c[0]==='SET'&&c[1]===key)||(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-write:v1')&&c[4]===key&&c[6]!=='');
const dels=(c:(string|number)[])=>(c[0]==='DEL'&&c[1]===key)||(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-forget:v3')&&c[4]===key);
globalThis.fetch=async()=>{throw Error('No external service in G2 review');};
async function fixture(){redis.clear();assert.equal((await keepNote(stats,{kind:'preference',text:'Write in a warm voice.'},room)).ok,true);return String(redis.run(['GET',key]));}
test('control: ordinary note writes and confirmed forgetting preserve the contract',async()=>{
 await fixture();assert.equal((await keepNote(stats,{kind:'instruction',text:'Keep each answer concise.'},room)).ok,true);assert.equal((await readMemory(stats)).length,2);await forgetMemory(stats,room);assert.equal(redis.run(['GET',key]),null);
});
for(const reply of [[],[undefined],['{broken-json']])test('unknown existing notes cannot become empty before a successful save '+JSON.stringify(reply),async()=>{
 const prior=await fixture(),base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(c=>c[0]==='GET'&&c[1]===key)?reply:base(batch);
 try{let result:unknown;try{result=await keepNote(stats,{kind:'preference',text:'Use short paragraphs.'},room);}catch(e){result=e;}
 console.log('G2_MEMORY_READ',JSON.stringify({reply,result,before:prior,after:redis.run(['GET',key])}));assert.equal(redis.run(['GET',key]),prior,'unknown read caused the writer to erase earlier notes');}finally{redis.pipeline=base;}
});
test('an unapplied unconfirmed SET must not return ok true',async()=>{
 redis.clear();const base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(sets)?[]:base(batch);
 try{let result:unknown;try{result=await keepNote(stats,{kind:'preference',text:'Use a plain voice.'},room);}catch(e){result=e;}
 assert.equal(redis.run(['GET',key]),null);console.log('G2_MEMORY_SET',JSON.stringify(result));assert.notEqual((result as {ok?:unknown})?.ok,true);}finally{redis.pipeline=base;}
});
test('a large delayed save after a small save cannot exceed its storage slot',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let stopped=false;let arrived!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
 redis.pipeline=async batch=>{if(!stopped&&batch.some(c=>sets(c)&&String(c[0]==='SET'?c[2]:c[6]).includes('L'.repeat(240)))){stopped=true;arrived();await gate;}return base(batch);};
 let pending:Promise<unknown>|undefined;
 try{
  pending=keepNote(stats,{kind:'preference',text:'L'.repeat(240)},room).catch(e=>e);await seen;
  const second=await keepNote(stats,{kind:'instruction',text:'Be brief.'},room);assert.ok(second.ok||(!second.ok&&second.error==='busy'),'the smaller save is kept or refused as busy, never half done');release();await pending;
  const raw=String(redis.run(['GET',key])),held=redis.run(['HGET',dataKey(room)!,'amem']),required=dataBytes([raw],1);
  console.log('G2_MEMORY_ACCOUNTING',JSON.stringify({required,held}));assert.ok(Number(held)>=required,'the delayed record is larger than the room charged after the smaller write');
 }finally{release();if(pending)await pending;redis.pipeline=base;}
});
test('an unknown unapplied delete cannot release the space still holding notes',async()=>{
 const prior=await fixture(),base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(dels)?[]:base(batch);
 try{
  await assert.rejects(forgetMemory(stats,room));assert.equal(redis.run(['GET',key]),prior);const held=redis.run(['HGET',dataKey(room)!,'amem']),required=dataBytes([prior],1);
  console.log('G2_MEMORY_DELETE',JSON.stringify({required,held}));assert.ok(Number(held)>=required,'unknown delete freed all storage while the note remains');
 }finally{redis.pipeline=base;}
});
test('a save already in flight must not restore notes after forgetMemory completes',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let stopped=false;let arrived!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
 redis.pipeline=async batch=>{if(!stopped&&batch.some(sets)){stopped=true;arrived();await gate;}return base(batch);};
 let pending:Promise<unknown>|undefined;
 try{
  pending=keepNote(stats,{kind:'instruction',text:'Keep the greeting short.'},room).catch(e=>e);await seen;
  await forgetMemory(stats,room);assert.equal(redis.run(['GET',key]),null,'forgetting really completed');release();await pending;
  console.log('G2_MEMORY_RESURRECTION',JSON.stringify({record:redis.run(['GET',key]),held:redis.run(['HGET',dataKey(room)!,'amem'])}));assert.equal(redis.run(['GET',key]),null,'an older save restored private notes after they were forgotten');
 }finally{release();if(pending)await pending;redis.pipeline=base;}
});
