/**
 * Codex G2 on #1949 (d429402a), kept as permanent tests: a list with a note the rules leave out is never written
 * over; a change whose lock ran out never cuts a newer note's room; forgetting never gives back a fresh note's room.
 * A note saved while the forgetting holds the lock may be refused as busy and is kept once it is done, with the
 * same room check (the window after an expired lock is tests/assistant-memory-forget-evidence.test.ts).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keepNote,forgetMemory,readMemory,readMemoryState} from '@/lib/assistant-memory-store';
import {dataKey,needData} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {ROOM} from './data-room';
import {store as redis} from './redis-stub';
const stats='G2MemoryBoundaries',key=`nl:amem:${stats}`,room={...ROOM,sid:'g2-memory-boundaries'};
async function fixture(){redis.clear();assert.equal((await keepNote(stats,{kind:'preference',text:'Use a warm voice.'},room)).ok,true);return String(redis.run(['GET',key]));}
function accounting(){const raw=String(redis.run(['GET',key])),required=dataBytes([raw],1),held=Number(redis.run(['HGET',dataKey(room)!,'amem']));return {required,held};}
test('control: ordinary changes and forgetting leave the room coherent',async()=>{await fixture();assert.equal((await keepNote(stats,{kind:'instruction',text:'Keep paragraphs short.'},room)).ok,true);const a=accounting();assert.ok(a.held>=a.required);await forgetMemory(stats,room);assert.equal(redis.run(['GET',key]),null);});
test('a partially unreadable stored list cannot be overwritten as if all notes were known',async()=>{
 const prior=await fixture(),valid=JSON.parse(prior)[0],raw=JSON.stringify([valid,{...valid,id:'abc123def4',kind:'future_kind',text:'Keep a deliberate preference for later.'}]);
 redis.run(['SET',key,raw]);await needData(room,[{slot:'amem',bytes:dataBytes([raw],1),set:true}]);
 const result=await keepNote(stats,{kind:'preference',text:'Use short sentences.'},room);console.log('G2_MEMORY_PARTIAL_ROW',JSON.stringify({result,before:raw,after:redis.run(['GET',key])}));
 assert.equal(redis.run(['GET',key]),raw,'the writer silently discarded a stored row it could not understand');
});
test('an expired old writer cannot shrink the room of the confirmed newer larger record',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let raced=false;
 redis.pipeline=async batch=>{
  if(!raced&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-write:'))){
   raced=true;redis.pipeline=base;redis.advance(11_000);
   assert.equal((await keepNote(stats,{kind:'instruction',text:'L'.repeat(240)},room)).ok,true);
  }
  return base(batch);
 };
 try{const result=await keepNote(stats,{kind:'preference',text:'Use a plain voice.'},room);assert.equal(raced,true);assert.equal(JSON.parse(String(redis.run(['GET',key]))).some((n:{text:string})=>n.text==='L'.repeat(240)),true);
  const a=accounting();console.log('G2_MEMORY_EXPIRED_ACCOUNTING',JSON.stringify({result,...a}));assert.ok(a.held>=a.required,'the expired writer returned room occupied by its successor');
 }finally{redis.pipeline=base;}
});
test('forgetting cannot return the room of a fresh note saved after its atomic delete',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let raced=false;
 redis.pipeline=async batch=>{
  const answer=await base(batch);
  if(!raced&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-forget:'))){
   raced=true;redis.pipeline=base;assert.equal(redis.run(['GET',key]),null);
   // While the forgetting holds the lock (MEMORY_FORGET v2 and later), the note waits and may be refused as busy.
   const fresh=await keepNote(stats,{kind:'instruction',text:'N'.repeat(240)},room);assert.ok(fresh.ok||fresh.error==='busy');waiting=!fresh.ok;
  }
  return answer;
 };
 let waiting=false;
 try{await forgetMemory(stats,room);assert.equal(raced,true);if(waiting)assert.equal((await keepNote(stats,{kind:'instruction',text:'N'.repeat(240)},room)).ok,true,'once the forgetting is done, the fresh note is kept');assert.equal(JSON.parse(String(redis.run(['GET',key])))[0].text,'N'.repeat(240));const a=accounting();console.log('G2_MEMORY_FORGET_ACCOUNTING',JSON.stringify(a));assert.ok(a.held>=a.required,'a confirmed older delete returned the fresh writer\'s room');}
 finally{redis.pipeline=base;}
});
test('a list with a note the rules leave out is never shown to the studio as the whole list; the model gets only the readable ones (Codex G2 on #1951)',async()=>{
 const prior=await fixture(),valid=JSON.parse(prior)[0],raw=JSON.stringify([valid,{...valid,id:'abc123def4',kind:'future_kind',text:'Keep a deliberate preference for later.'}]);
 redis.run(['SET',key,raw]);
 assert.deepEqual(await readMemoryState(stats),{ok:false,error:'unreadable'},'the studio is told the notes cannot be read whole');
 assert.deepEqual((await readMemory(stats)).map(n=>n.id),[valid.id],'the model gets only the note the rules let through');
});
