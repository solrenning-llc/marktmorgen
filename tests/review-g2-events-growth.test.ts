import test from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/events/route';
import {makeKey} from '@/lib/api-keys';
import {apiReadUnits,eventsWork,eventsSentMost} from '@/lib/api-read-rules';
import {allowanceUsed,takeAllowance} from '@/lib/store-allowance';
import {allowanceFor} from '@/lib/store-allowance-rules';
import {LOG_SIZE} from '@/lib/webhooks';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
test('G2: an ordinary delivery-status update cannot make the reader spend beyond its earlier admission',async()=>{
 redis.clear();const owner='g2-events-growth@example.test';
 await claimHandle(owner,'g2-events-growth','Synthetic events','');await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_G2Growth1',subscriptionId:'sub_G2Growth1',active:true,tier:'scale',period:paidPeriod()});
 const shop=(await storeForEmail(owner))!,made=await makeKey(shop.sid,'Synthetic reader');assert(made.ok);
 const ids=Array.from({length:LOG_SIZE},(_,i)=>'dlv_'+i.toString(16).padStart(24,'0')),now=Date.now(),logBytes=ids.reduce((a,id)=>a+id.length,0);
 const records=(count:number,pad:number)=>ids.map(id=>({id,statsId:shop.statsId,endpoint:'we_bbbbbbbbbbbbbbbb',eventId:'evt_'+id.slice(4).padStart(32,'0'),type:'sale.completed',body:JSON.stringify({id:'evt_'+id.slice(4).padStart(32,'0'),type:'sale.completed',created:Math.floor(now/1000),store:{handle:shop.handle,name:shop.name},data:{products:Array.from({length:count},()=>({title:'x'.repeat(250)})),note:'z'.repeat(pad)}}),attempts:0,state:'queued',next:now,lastStatus:0,lastError:'',lastAt:0,createdAt:now}));
 const finished=(rows:ReturnType<typeof records>)=>rows.map(r=>({...r,attempts:1,state:'retrying',next:now+300000,lastStatus:500,lastError:'Answered 500.',lastAt:now}));
 let scenario:{before:ReturnType<typeof records>;after:ReturnType<typeof records>;held:number;needed:number}|null=null;
 for(let count=20;count<40&&!scenario;count++)for(let pad=0;pad<=256;pad++){
  const before=records(count,pad),after=finished(before),sizes=before.map(r=>Buffer.byteLength(JSON.stringify(r)));
  const held=apiReadUnits(eventsWork({deliveries:LOG_SIZE,bytes:logBytes+sizes.reduce((a,b)=>a+b,0),sent:eventsSentMost(sizes,1)}));
  const needed=apiReadUnits(eventsWork({deliveries:LOG_SIZE,bytes:logBytes+after.reduce((a,r)=>a+Buffer.byteLength(JSON.stringify(r)),0),sent:Buffer.byteLength('['+before[0].body+']')}));
  if(needed>held){scenario={before,after,held,needed};break;}
 }
 assert(scenario,'there is an integer admission boundary crossed by legal status growth');const {before,after,held,needed}=scenario;
 await redis.pipeline([['LPUSH','nl:hooks:log:'+shop.statsId,...ids],...before.map(r=>['SET','nl:hooks:d:'+r.id,JSON.stringify(r)])]);
 const limit=allowanceFor(shop,'api');assert((await takeAllowance(shop,'api',limit-held-1)).ok);const original=redis.pipeline;
 let read=false,chargedAtRead=-1;
 redis.pipeline=async commands=>{
  if(!read&&commands.length===LOG_SIZE&&commands.every(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:hooks:d:'))){
   read=true;chargedAtRead=await allowanceUsed(shop,'api');
   await original.call(redis,after.map(r=>['SET','nl:hooks:d:'+r.id,JSON.stringify(r)])); // concurrent normal status update; no body changes
  }
  return original.call(redis,commands);
 };
 try{
  const r=await GET(new Request('https://marktmorgen.com/api/v1/events?type=sale.completed&limit=1',{headers:{Authorization:'Bearer '+made.key}}));
  console.log('G2_EVENT_GROWTH',JSON.stringify({read,held,needed,status:r.status,chargedAtRead,limit,firstRecordBefore:Buffer.byteLength(JSON.stringify(before[0])),firstRecordAfter:Buffer.byteLength(JSON.stringify(after[0]))}));
  assert(read);assert.equal(chargedAtRead,limit);assert.equal(r.status,429);
  assert(held>=needed,'the delivery bytes were already read before the extra allowance was refused');
 }finally{redis.pipeline=original}
});
