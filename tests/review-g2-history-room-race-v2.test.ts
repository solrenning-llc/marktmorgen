/** Identified G2 dual-protocol barrier variant; all original assertions and data unchanged. */
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
  // New protocol refunds its own take instead of recounting. Inject the newer push BEFORE that refund; on the old protocol use the original observed LRANGE barrier below.
  if(phase===1&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:store-data:')&&c[3]===dataKey(ROOM)&&c[8]===slot)){
   phase=2;redis.pipeline=base;assert.equal(await keepFlowVersion(ROOM,list,flow('C'.repeat(800)),after,4),true);redis.pipeline=spy;
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
  const kept=await keepFlowVersion(ROOM,list,flow('A'.repeat(100)),after,2);assert.equal(kept,false);assert.equal(phase,2);
  const held=redis.run(['LRANGE',key,0,-1]) as string[],required=dataBytes(held,held.length),charged=Number(redis.run(['HGET',dataKey(ROOM)!,slot]));
  console.log('G2_HISTORY_RECOUNT_RACE',JSON.stringify({entries:held.length,charged,required}));assert.ok(charged>=required,'the stale recount released storage still holding the newest version');
 }finally{redis.pipeline=base;}
});
