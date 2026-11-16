/**
 * Codex G2 on #2192: an ordinary try of a delivery between its measuring and
 * its reading (its state, count of tries and the endpoint's answer written on
 * it) never makes GET /api/v1/events read more than it set aside: each
 * delivery is set aside at its bound (lib/webhooks.ts, deliveryReadBound) and
 * read only up to it (READ_DELIVERIES). One that grew past it, or came back
 * after it was measured as gone, is not read at all: 502, nothing of it sent.
 * Through the real route, with a synthetic store, key and Redis only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/events/route';
import {makeKey} from '@/lib/api-keys';
import {EVENTS_PROBE_MOST,apiReadUnits,eventsSentMost,eventsWork} from '@/lib/api-read-rules';
import {allowanceUsed,takeAllowance} from '@/lib/store-allowance';
import {allowanceFor} from '@/lib/store-allowance-rules';
import {DELIVERY_UPDATE_ROOM_BYTES,LOG_SIZE,deliveryReadBound} from '@/lib/webhooks';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';

async function world(handle:string){
 redis.clear();const owner=`${handle}@example.test`;
 await claimHandle(owner,handle,'Synthetic events','');await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_EventsGrowth',subscriptionId:'sub_EventsGrowth',active:true,tier:'scale',period:paidPeriod()});
 const shop=(await storeForEmail(owner))!,made=await makeKey(shop.sid,'Synthetic reader');assert(made.ok);
 const ids=Array.from({length:LOG_SIZE},(_,i)=>'dlv_'+i.toString(16).padStart(24,'0')),now=Date.now();
 const records=ids.map(id=>({id,statsId:shop.statsId,endpoint:'we_bbbbbbbbbbbbbbbb',eventId:'evt_'+id.slice(4).padStart(32,'0'),type:'sale.completed',body:JSON.stringify({id:'evt_'+id.slice(4).padStart(32,'0'),type:'sale.completed',created:Math.floor(now/1000),data:{products:Array.from({length:30},()=>({title:'x'.repeat(250)}))}}),attempts:0,state:'queued',next:now,lastStatus:0,lastError:'',lastAt:0,createdAt:now}));
 await redis.pipeline([['LPUSH','nl:hooks:log:'+shop.statsId,...ids],...records.map(r=>['SET','nl:hooks:d:'+r.id,JSON.stringify(r)])]);
 const read=()=>GET(new Request('https://marktmorgen.com/api/v1/events?type=sale.completed&limit=1',{headers:{Authorization:'Bearer '+made.key}}));
 return {shop,ids,records,read,now};
}
const isRead=(c:(string|number)[])=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:webhook-deliveries-read');

test('an ordinary try written on every delivery between its measuring and its reading is read within what was set aside',async()=>{
 const {shop,ids,records,read,now}=await world('events-growth');
 const sizes=records.map(r=>Buffer.byteLength(JSON.stringify(r))),bounds=sizes.map(deliveryReadBound);
 const logBytes=ids.reduce((n,id)=>n+id.length,0);
 const whole=apiReadUnits(eventsWork({deliveries:LOG_SIZE,bytes:logBytes+bounds.reduce((a,b)=>a+b,0),sent:eventsSentMost(bounds,1)}));
 const needs=1+Math.max(whole,apiReadUnits(EVENTS_PROBE_MOST));
 // Exactly what the reading sets aside is left, and no more.
 const limit=allowanceFor(shop,'api');assert((await takeAllowance(shop,'api',limit-needs)).ok);
 const tried=records.map(r=>({...r,attempts:1,state:'retrying',next:now+300000,lastStatus:500,lastError:'Answered 500.',lastAt:now}));
 const original=redis.pipeline;let returned=-1,usedAtRead=-1;
 redis.pipeline=async commands=>{
  if(commands.some(isRead)){
   usedAtRead=await allowanceUsed(shop,'api');
   await original.call(redis,tried.map(r=>['SET','nl:hooks:d:'+r.id,JSON.stringify(r)]));
   const reply=await original.call(redis,commands);
   returned=((reply[0] as [number,(string|null)[]])[1]??[]).reduce((n,v)=>n+(v?Buffer.byteLength(v):0),0);
   return reply;
  }
  return original.call(redis,commands);
 };
 try{
  const r=await read();
  assert.equal(r.status,200);assert.equal(((await r.json()) as {data:unknown[]}).data.length,1);
  assert.equal(usedAtRead,limit,'everything the reading may take was taken before it read');
  assert.ok(returned>sizes.reduce((a,b)=>a+b,0),'(each delivery grew after it was measured)');
  assert.ok(returned<=bounds.reduce((a,b)=>a+b,0),'and what came back fits what was set aside');
  assert.ok((await allowanceUsed(shop,'api'))<=limit,'never more than the store has');
 }finally{redis.pipeline=original}
});

test('a delivery grown past its bound, or back after it was measured as gone, is not read: 502, nothing of it sent',async()=>{
 for(const how of ['grown','back'] as const){
  const {ids,records,read}=await world(`events-over-${how}`);
  if(how==='back')await redis.pipeline([['DEL','nl:hooks:d:'+ids[0]]]);
  const original=redis.pipeline;let reached=false,returned=-1;
  redis.pipeline=async commands=>{
   if(commands.some(isRead)){
    reached=true;
    const big={...records[0],lastError:'y'.repeat(DELIVERY_UPDATE_ROOM_BYTES+64)};
    await original.call(redis,[['SET','nl:hooks:d:'+ids[0],JSON.stringify(how==='grown'?big:records[0])]]);
    const reply=await original.call(redis,commands);returned=JSON.stringify(reply).length;return reply;
   }
   return original.call(redis,commands);
  };
  try{
   const r=await read();
   assert.equal(reached,true);assert.equal(r.status,502,`${how}: unavailable`);
   assert.ok(returned<64,`${how}: nothing of the deliveries came back`);
  }finally{redis.pipeline=original}
 }
});
