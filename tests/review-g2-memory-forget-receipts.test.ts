/** G2 independent v3 receipt boundaries; real note/data-room writers, synthetic transport responses only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {keepNote,forgetMemory,MemoryWriteUnconfirmed} from '@/lib/assistant-memory-store';
import {dataKey} from '@/lib/store-data';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
const stats='G2MemoryReceipt',key=`nl:amem:${stats}`,room={...ROOM,sid:'g2-memory-receipt'};
async function seed(){redis.clear();assert.ok((await keepNote(stats,{kind:'preference',text:'Use a warm voice.'},room)).ok);return{raw:redis.run(['GET',key]),held:redis.run(['HGET',dataKey(room)!,'amem'])};}
for(const receipt of [[],[null],[[1]],[[1,1,0]],[[true,240]],[[1,'240']],[[1,-1]],[[0,240]],[[1,240],0]])test('unapplied malformed forgetting receipt cannot release occupied room '+JSON.stringify(receipt),async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);let reached=0;
 redis.pipeline=async commands=>{if(commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-forget:'))){reached++;return receipt as never;}return original(commands);};
 try{await assert.rejects(forgetMemory(stats,room),MemoryWriteUnconfirmed);}finally{redis.pipeline=original;}
 assert.equal(reached,1);assert.equal(redis.run(['GET',key]),s.raw);assert.equal(redis.run(['HGET',dataKey(room)!,'amem']),s.held);
});
test('an applied deletion with a lost receipt remains unknown and keeps its previously admitted room',async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);let reached=0;
 redis.pipeline=async commands=>{if(commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-forget:'))){reached++;await original(commands);return [] as never;}return original(commands);};
 try{await assert.rejects(forgetMemory(stats,room),MemoryWriteUnconfirmed);}finally{redis.pipeline=original;}
 assert.equal(reached,1);assert.equal(redis.run(['GET',key]),null);assert.equal(redis.run(['HGET',dataKey(room)!,'amem']),s.held);
});
