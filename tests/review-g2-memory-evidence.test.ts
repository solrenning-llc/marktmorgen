import {test} from 'node:test';import assert from 'node:assert/strict';
import {keepNote,forgetMemory,readMemory} from '@/lib/assistant-memory-store';
import {dataKey} from '@/lib/store-data';import {dataBytes} from '@/lib/store-data-rules';
import {store as redis} from './redis-stub';import {ROOM} from './data-room';
const stats='G2MemoryEvidence',room={...ROOM,sid:'g2-memory-room'},key=`nl:amem:${stats}`;
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
 redis.clear();const base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(c=>c[0]==='SET'&&c[1]===key)?[]:base(batch);
 try{let result:unknown;try{result=await keepNote(stats,{kind:'preference',text:'Use a plain voice.'},room);}catch(e){result=e;}
 assert.equal(redis.run(['GET',key]),null);console.log('G2_MEMORY_SET',JSON.stringify(result));assert.notEqual((result as {ok?:unknown})?.ok,true);}finally{redis.pipeline=base;}
});
test('a large delayed save after a small save cannot exceed its storage slot',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let stopped=false;let arrived!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
 redis.pipeline=async batch=>{if(!stopped&&batch.some(c=>c[0]==='SET'&&c[1]===key&&String(c[2]).includes('L'.repeat(240)))){stopped=true;arrived();await gate;}return base(batch);};
 let pending:Promise<unknown>|undefined;
 try{
  pending=keepNote(stats,{kind:'preference',text:'L'.repeat(240)},room).catch(e=>e);await seen;
  assert.equal((await keepNote(stats,{kind:'instruction',text:'Be brief.'},room)).ok,true);release();await pending;
  const raw=String(redis.run(['GET',key])),held=redis.run(['HGET',dataKey(room)!,'amem']),required=dataBytes([raw],1);
  console.log('G2_MEMORY_ACCOUNTING',JSON.stringify({required,held}));assert.ok(Number(held)>=required,'the delayed record is larger than the room charged after the smaller write');
 }finally{release();if(pending)await pending;redis.pipeline=base;}
});
test('an unknown unapplied delete cannot release the space still holding notes',async()=>{
 const prior=await fixture(),base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(c=>c[0]==='DEL'&&c[1]===key)?[]:base(batch);
 try{
  await forgetMemory(stats,room);assert.equal(redis.run(['GET',key]),prior);const held=redis.run(['HGET',dataKey(room)!,'amem']),required=dataBytes([prior],1);
  console.log('G2_MEMORY_DELETE',JSON.stringify({required,held}));assert.ok(Number(held)>=required,'unknown delete freed all storage while the note remains');
 }finally{redis.pipeline=base;}
});
test('a save already in flight must not restore notes after forgetMemory completes',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let stopped=false;let arrived!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
 redis.pipeline=async batch=>{if(!stopped&&batch.some(c=>c[0]==='SET'&&c[1]===key)){stopped=true;arrived();await gate;}return base(batch);};
 let pending:Promise<unknown>|undefined;
 try{
  pending=keepNote(stats,{kind:'instruction',text:'Keep the greeting short.'},room).catch(e=>e);await seen;
  await forgetMemory(stats,room);assert.equal(redis.run(['GET',key]),null,'forgetting really completed');release();await pending;
  console.log('G2_MEMORY_RESURRECTION',JSON.stringify({record:redis.run(['GET',key]),held:redis.run(['HGET',dataKey(room)!,'amem'])}));assert.equal(redis.run(['GET',key]),null,'an older save restored private notes after they were forgotten');
 }finally{release();if(pending)await pending;redis.pipeline=base;}
});
