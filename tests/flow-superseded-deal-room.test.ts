/**
 * Codex G2 on #2287, kept as a permanent test: a step whose run was taken over by a later take writes nothing, and
 * the deal's room goes back to the record kept there now (a newer edit may have made it bigger), as the scripts
 * measure it in the same step, never to the record the stale step read.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeDeal,writeDealOver,dealBytes,dealSlot,type RunTake} from '@/lib/crm';
import {dataKey} from '@/lib/store-data';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
const stats='G2SupersededRoom',id='g2deal0001',key=`nl:crm:deals:${stats}`;
const lease='g2:review:lease',member='synthetic-run',take:RunTake={key:lease,member,score:1};
const small={id,title:'Synthetic small deal',email:'person@example.com',cents:0,stage:'talking',note:'',createdAt:1,updatedAt:1};
const large={...small,note:'L'.repeat(450),updatedAt:2};
async function fixture(){redis.clear();assert.equal(await writeDeal(stats,small,ROOM),true);await redis.pipeline([['ZADD',lease,1,member]]);return String(redis.run(['HGET',key,id]));}
test('control: an owned ordinary move keeps its complete room charged',async()=>{
 const before=await fixture();assert.equal(await writeDealOver(stats,{...small,title:'Moved'},before,ROOM,take),'saved');
 const kept=redis.run(['HGET',dataKey(ROOM)!,dealSlot(id)]);assert.ok(Number(kept)>=dealBytes({...small,title:'Moved'}));
});
test('an old superseded move cannot return room occupied by the newer larger board record',async()=>{
 const before=await fixture(),base=redis.pipeline.bind(redis);let reached=false;
 redis.pipeline=async batch=>{
  if(!reached&&batch.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:crm-deal-move:'))){
   reached=true;redis.pipeline=base;
   // After the old move reserved its room, a real confirmed edit grows this SAME deal and the take changes.
   assert.equal(await writeDeal(stats,large,ROOM,'edit'),true);await base([['ZADD',lease,2,member]]);
  }
  return base(batch);
 };
 try{
  const outcome=await writeDealOver(stats,{...small,stage:'offered'},before,ROOM,take);
  assert.equal(reached,true);assert.deepEqual(JSON.parse(String(redis.run(['HGET',key,id]))),large,'the newer record really remains');
  const held=Number(redis.run(['HGET',dataKey(ROOM)!,dealSlot(id)])),required=dealBytes(large);
  console.log('G2_SUPERSEDED_DEAL_ROOM',JSON.stringify({outcome,held,required}));assert.ok(held>=required,'superseded old snapshot released space still holding the larger new deal');
 }finally{redis.pipeline=base;}
});
