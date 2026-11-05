/**
 * Codex G2 on #2287 (19d8cce1), kept as permanent tests: a deal write refused late (taken over, or the record
 * changed), or one Redis did not answer, never cuts the room of a newer, larger record: the room moves by what each
 * write changes, never set to a total from an answer that came later.
 */
/** Independent G2 return: retained records may grow after a valid receipt, before the caller's separate room rollback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeDeal,writeDealOver,dealBytes,dealSlot,type RunTake} from '@/lib/crm';
import {dataKey} from '@/lib/store-data';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
const stats='G2ReceiptRoom',id='g2deal0001',key=`nl:crm:deals:${stats}`;
const lease='g2:receipt:lease',member='synthetic-run',take:RunTake={key:lease,member,score:1};
const small={id,title:'Synthetic small deal',email:'person@example.com',cents:0,stage:'talking',note:'',createdAt:1,updatedAt:1};
const large={...small,note:'L'.repeat(450),updatedAt:2};
for(const writer of ['move','save'] as const)for(const present of [true,false])test(`${writer}: a superseded receipt cannot later resize the newer board record (${present?'present':'absent'} at receipt)`,async()=>{
 redis.clear();let before='';if(present){assert.equal(await writeDeal(stats,small,ROOM),true);before=String(redis.run(['HGET',key,id]));}
 await redis.pipeline([['ZADD',lease,2,member]]);
 const original=redis.pipeline.bind(redis);let reached=0,measured:unknown;
 redis.pipeline=async batch=>{
  if(batch.length===1&&batch[0][0]==='EVAL'&&String(batch[0][1]).startsWith(`-- marktmorgen:crm-deal-${writer==='move'?'move':'save'}:`)){
   redis.pipeline=original;measured=await original(batch);reached++;
   assert.equal(await writeDeal(stats,large,ROOM),true);
   assert.ok(Number(redis.run(['HGET',dataKey(ROOM)!,dealSlot(id)]))>=dealBytes(large),'the newer writer genuinely paid the full retained room');
   return measured as never;
  }
  return original(batch);
 };
 let outcome;try{outcome=writer==='move'?await writeDealOver(stats,{...small,stage:'offered'},before,ROOM,take):await writeDeal(stats,small,ROOM,undefined,take);}finally{redis.pipeline=original;}
 assert.equal(reached,1);assert.equal(outcome,'superseded');assert.deepEqual(JSON.parse(String(redis.run(['HGET',key,id]))),large);
 const held=Number(redis.run(['HGET',dataKey(ROOM)!,dealSlot(id)])),required=dealBytes(large);
 console.log('G2_AFTER_VALID_RECEIPT',JSON.stringify({writer,present,measured,held,required}));assert.ok(held>=required,'a stale receipt cannot return room belonging to the newer real board write');
});
test('control: ordinary concurrent growth stays fully accounted without stale rollback',async()=>{
 redis.clear();assert.equal(await writeDeal(stats,small,ROOM),true);assert.equal(await writeDeal(stats,large,ROOM,'edit'),true);
 assert.deepEqual(JSON.parse(String(redis.run(['HGET',key,id]))),large);assert.ok(Number(redis.run(['HGET',dataKey(ROOM)!,dealSlot(id)]))>=dealBytes(large));
});
for(const writer of ['move','save'] as const)test(`${writer}: an unknown unapplied receipt cannot shrink room still occupied by the prior larger record`,async()=>{
 redis.clear();assert.equal(await writeDeal(stats,large,ROOM),true);const before=String(redis.run(['HGET',key,id]));await redis.pipeline([['ZADD',lease,1,member]]);
 const original=redis.pipeline.bind(redis);let reached=0,unknown=false;
 redis.pipeline=async batch=>{
  if(batch.length===1&&batch[0][0]==='EVAL'&&String(batch[0][1]).startsWith(`-- marktmorgen:crm-deal-${writer==='move'?'move':'save'}:`)){reached++;return [] as never;}
  return original(batch);
 };
 try{if(writer==='move')await writeDealOver(stats,small,before,ROOM,take);else await writeDeal(stats,small,ROOM,undefined,take);}catch{unknown=true;}finally{redis.pipeline=original;}
 assert.equal(reached,1);assert.equal(unknown,true);assert.deepEqual(JSON.parse(String(redis.run(['HGET',key,id]))),large);
 const held=Number(redis.run(['HGET',dataKey(ROOM)!,dealSlot(id)])),required=dealBytes(large);console.log('G2_UNKNOWN_UNAPPLIED_ROOM',JSON.stringify({writer,held,required}));
 assert.ok(held>=required,'a failed unapplied write cannot reduce the paid room of the unchanged existing record');
});
