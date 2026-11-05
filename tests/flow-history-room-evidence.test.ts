/**
 * Codex G2 on #1927 (718223e45), kept as a permanent test: a push refused because the list changed never cuts the
 * room of a newer push. The refused push no longer reads the list again; the third push then comes right after it,
 * and the room check is the same.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keepFlowVersion} from '@/lib/flow-versions';
import type {Flow} from '@/lib/flows';
import {dataKey} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {ROOM} from './data-room';
import {store as redis} from './redis-stub';
const list='G2HistoryRoomRace',id='a'.repeat(16),key=`nl:wf:ver:${list}:${id}`,slot='wv:'+id;
const flow=(body:string):Flow=>({id,name:'Synthetic sequence',trigger:'joined',productId:null,createdAt:1,tag:'',active:false,steps:[{id:'b'.repeat(12),delayHours:0,subject:'Synthetic subject',body}]});
const after=flow('The proposed next version.');
test('control: sequential history writes retain and charge the complete list',async()=>{
 redis.clear();assert.equal(await keepFlowVersion(ROOM,list,flow('one'),after,1),true);assert.equal(await keepFlowVersion(ROOM,list,flow('two'),after,2),true);
 const held=redis.run(['LRANGE',key,0,-1]) as string[];assert.ok(Number(redis.run(['HGET',dataKey(ROOM)!,slot]))>=dataBytes(held,held.length));
});
test('recount after a refused old push cannot shrink the room of a newer third push',async()=>{
 redis.clear();assert.equal(await keepFlowVersion(ROOM,list,flow('Initial'),after,1),true);
 const base=redis.pipeline.bind(redis);let phase=0;
 redis.pipeline=async batch=>{
  if(phase===0&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:flow-version-keep:'))){
   phase=1;redis.pipeline=base;
   assert.equal(await keepFlowVersion(ROOM,list,flow('B'.repeat(400)),after,3),true);
   redis.pipeline=spy;
  }
  const answer=await base(batch);
  if(phase===1&&batch.some(c=>c[0]==='LRANGE'&&c[1]===key)){
   phase=2;redis.pipeline=base;
   assert.equal(await keepFlowVersion(ROOM,list,flow('C'.repeat(800)),after,4),true);
   redis.pipeline=spy;
  }
  return answer;
 };
 const spy=redis.pipeline;
 try{
  const kept=await keepFlowVersion(ROOM,list,flow('A'.repeat(100)),after,2);assert.equal(kept,false);assert.ok(phase>=1);
  // A refused push no longer reads the list again (it gives back only what it took), so the third push comes right after it.
  if(phase===1){redis.pipeline=base;phase=2;assert.equal(await keepFlowVersion(ROOM,list,flow('C'.repeat(800)),after,4),true);}
  const held=redis.run(['LRANGE',key,0,-1]) as string[],required=dataBytes(held,held.length),charged=Number(redis.run(['HGET',dataKey(ROOM)!,slot]));
  console.log('G2_HISTORY_RECOUNT_RACE',JSON.stringify({entries:held.length,charged,required}));assert.ok(charged>=required,'the stale recount released storage still holding the newest version');
 }finally{redis.pipeline=base;}
});
