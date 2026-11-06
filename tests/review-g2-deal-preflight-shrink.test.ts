/** G2 independent: real writers, a stale size preflight, and real capacity admission. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeDeal, dealBytes, dealSlot} from '@/lib/crm';
import {DEFAULT_STAGES, parseDeal} from '@/lib/crm-rules';
import {dataKey, needData} from '@/lib/store-data';
import {contentRoomFor} from '@/lib/store-data-rules';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';
const stats='G2SizeRace',id='g2size0001',key=`nl:crm:deals:${stats}`,roomKey=dataKey(ROOM)!;
const small={id,title:'Synthetic deal',email:'person@example.com',cents:0,stage:DEFAULT_STAGES[0].id,note:'',createdAt:1,updatedAt:1};
const medium={...small,note:'M'.repeat(200)},large={...small,note:'L'.repeat(450)};
for(const deal of [small,medium,large])assert.deepEqual(parseDeal(deal,DEFAULT_STAGES),deal,'all race fixtures are valid production deals');
const used=()=>Number(redis.run(['HGET',roomKey,'#']));
const held=()=>Number(redis.run(['HGET',roomKey,dealSlot(id)]));
for(const fill of [false,true])test(`growth following a concurrent shrink is admitted before HSET (${fill?'full room':'spare room'})`,async()=>{
 redis.clear();assert.equal(await writeDeal(stats,large,ROOM),true);
 const original=redis.pipeline.bind(redis);let reached=0,heldAtWrite=0,usedAtWrite=0;
 redis.pipeline=async commands=>{
  if(commands.length===1&&commands[0][0]==='EVAL'&&String(commands[0][1]).startsWith('-- marktmorgen:crm-deal-save:')){
   redis.pipeline=original;reached++;
   assert.equal(await writeDeal(stats,small,ROOM,'edit'),true);
   assert.equal(held(),dealBytes(small),'the concurrent real writer releases only its actual shrink');
   if(fill)await needData(ROOM,[{slot:'g2:another-pending-request',bytes:contentRoomFor(ROOM)-used()-64}]);
   heldAtWrite=held();usedAtWrite=used();
   return original(commands);
  }
  return original(commands);
 };
 let outcome:unknown;try{outcome=await writeDeal(stats,medium,ROOM,'edit');}catch(error){outcome=error;}finally{redis.pipeline=original;}
 assert.equal(reached,1);
 const kept=JSON.parse(String(redis.run(['HGET',key,id])));
 console.log('G2_STALE_SIZE',JSON.stringify({fill,outcome:String(outcome),heldAtWrite,required:dealBytes(medium),usedAtWrite,usedAfter:used(),limit:contentRoomFor(ROOM),mediumStored:kept.note===medium.note}));
 if(!fill&&kept.note===medium.note)assert.ok(heldAtWrite>=dealBytes(medium),'the effect must have its increased room admitted before HSET');
 assert.ok(used()<=contentRoomFor(ROOM),'a stale preflight cannot overrun the admitted store room');
 if(kept.note===medium.note)assert.ok(held()>=dealBytes(medium),'the retained record must remain fully counted');
});
test('control: a full room permits a genuine shortening',async()=>{
 redis.clear();assert.equal(await writeDeal(stats,large,ROOM),true);
 await needData(ROOM,[{slot:'g2:another-pending-request',bytes:contentRoomFor(ROOM)-used()-64}]);
 assert.equal(await writeDeal(stats,medium,ROOM,'edit'),true);
 assert.ok(used()<contentRoomFor(ROOM));assert.equal(held(),dealBytes(medium));
});
