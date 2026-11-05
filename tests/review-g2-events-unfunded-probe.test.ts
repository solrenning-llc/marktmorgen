import test from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/events/route';
import {makeKey} from '@/lib/api-keys';
import {allowanceUsed,takeAllowance} from '@/lib/store-allowance';
import {allowanceFor} from '@/lib/store-allowance-rules';
import {API_UNIT_COMMANDS} from '@/lib/api-read-rules';
import {TAKE_COMMANDS} from './plan-cost-registry';
import {LOG_SIZE} from '@/lib/webhooks';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
test('G2: a refused events request must not spend fifty sizing commands beyond its only admitted unit',async()=>{
 redis.clear();const owner='g2-events-probe@example.test';
 await claimHandle(owner,'g2-events-probe','Synthetic events','');await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_G2Probe1',subscriptionId:'sub_G2Probe1',active:true,tier:'scale',period:paidPeriod()});
 const shop=(await storeForEmail(owner))!,made=await makeKey(shop.sid,'Synthetic reader');assert(made.ok);
 const ids=Array.from({length:LOG_SIZE},(_,i)=>'dlv_'+i.toString(16).padStart(24,'0'));
 await redis.pipeline([['LPUSH','nl:hooks:log:'+shop.statsId,...ids],...ids.map(id=>['SET','nl:hooks:d:'+id,JSON.stringify({id,statsId:shop.statsId,type:'sale.completed',eventId:id,body:'{}'})])]);
 const limit=allowanceFor(shop,'api');assert((await takeAllowance(shop,'api',limit-1)).ok);const before=await allowanceUsed(shop,'api');
 let probes=0,deliveryReads=0;const original=redis.pipeline;
 redis.pipeline=async commands=>{probes+=commands.filter(c=>c[0]==='STRLEN'&&String(c[1]).startsWith('nl:hooks:d:')).length;deliveryReads+=commands.filter(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:hooks:d:')).length;return original.call(redis,commands)};
 try{
  const r=await GET(new Request('https://marktmorgen.com/api/v1/events?type=sale.completed',{headers:{Authorization:'Bearer '+made.key}}));
  const charged=(await allowanceUsed(shop,'api'))-before;
  console.log('G2_PROBE_OBSERVATION',JSON.stringify({status:r.status,probes,deliveryReads,charged,registeredBaseCommandEnvelope:API_UNIT_COMMANDS+TAKE_COMMANDS}));
  assert.equal(r.status,429);assert.equal(deliveryReads,0);assert.equal(charged,1);
  assert(probes<=charged*(API_UNIT_COMMANDS+TAKE_COMMANDS),'the sizing probes alone exceed the entire admitted command envelope, before counting authentication and the log');
 }finally{redis.pipeline=original}
});
