/**
 * Codex G2 on #1949 (a3b625722), kept as permanent tests: forgetting holds its own lock until its room is given
 * back, and once that lock has run out, its late give-back never clears a fresh note's room.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keepNote,forgetMemory} from '@/lib/assistant-memory-store';
import {dataKey} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {ROOM} from './data-room';
import {store as redis} from './redis-stub';
const stats='G2MemoryForgetV2',key=`nl:amem:${stats}`,lock=`nl:amem:lock:${stats}`,room={...ROOM,sid:'g2-memory-forget-v2'};
async function fixture(){redis.clear();assert.equal((await keepNote(stats,{kind:'preference',text:'Use a warm voice.'},room)).ok,true);}
test('control: forgetting retains an exclusive lock until its space is returned',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let reached=false;
 redis.pipeline=async batch=>{const answer=await base(batch);if(!reached&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-forget:'))){reached=true;assert.equal(redis.run(['GET',key]),null);assert.equal(typeof redis.run(['GET',lock]),'string');assert.equal(redis.run(['SET',lock,'competing','NX','EX',10]),null);}return answer;};
 try{await forgetMemory(stats,room);assert.equal(reached,true);assert.equal(redis.run(['GET',lock]),null);assert.equal(redis.run(['HGET',dataKey(room)!,'amem']),null);}finally{redis.pipeline=base;}
});
test('after forgetting lock expires, its old quota return cannot clear a fresh confirmed note reservation',async()=>{
 await fixture();const base=redis.pipeline.bind(redis);let reached=false;
 redis.pipeline=async batch=>{
  const answer=await base(batch);
  if(!reached&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-forget:'))){
   reached=true;redis.pipeline=base;assert.equal(redis.run(['GET',key]),null);redis.advance(11_000);
   assert.equal((await keepNote(stats,{kind:'instruction',text:'F'.repeat(240)},room)).ok,true);
  }
  return answer;
 };
 try{await forgetMemory(stats,room);assert.equal(reached,true);const raw=String(redis.run(['GET',key]));assert.equal(JSON.parse(raw)[0].text,'F'.repeat(240));const held=Number(redis.run(['HGET',dataKey(room)!,'amem'])),required=dataBytes([raw],1);console.log('G2_MEMORY_FORGET_V2_EXPIRED',JSON.stringify({held,required}));assert.ok(held>=required,'the expired forgetting cleared the fresh note\'s quota');}finally{redis.pipeline=base;}
});
