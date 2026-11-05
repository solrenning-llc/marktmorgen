import test from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/events/route';
import {makeKey} from '@/lib/api-keys';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
const owner='g2-events-reader@example.test';
async function world(){
 redis.clear();await claimHandle(owner,'g2-events-reader','Synthetic events','');await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_G2Events1',subscriptionId:'sub_G2Events1',active:true,tier:'scale',period:paidPeriod()});
 const shop=(await storeForEmail(owner))!,made=await makeKey(shop.sid,'Synthetic reader');assert(made.ok);
 const id='dlv_'+'a'.repeat(24),body=JSON.stringify({id:'evt_g2_synthetic',type:'sale.completed',data:{title:'Synthetic book'}});
 await redis.pipeline([['SET','nl:hooks:d:'+id,JSON.stringify({id,body,statsId:shop.statsId,type:'sale.completed',eventId:'evt_g2_synthetic',endpoint:'wh_g2',attempts:0,state:'queued',next:0,lastStatus:0,lastError:'',lastAt:0,createdAt:Date.now()})],['LPUSH','nl:hooks:log:'+shop.statsId,id]]);
 const read=()=>GET(new Request('https://marktmorgen.com/api/v1/events?type=sale.completed',{headers:{Authorization:'Bearer '+made.key}}));
 return{read,id};
}
test('G2 control: confirmed event record is returned',async()=>{const {read}=await world();const r=await read();assert.equal(r.status,200);assert.equal((await r.json()).data.length,1)});
test('G2 control: a confirmed null slot is a legitimate expired delivery',async()=>{
 const {read,id}=await world();await redis.pipeline([['DEL','nl:hooks:d:'+id]]);const r=await read();assert.equal(r.status,200);assert.deepEqual((await r.json()).data,[]);
});
for(const [label,reply] of [['missing GET results',[]],['missing GET slot',[undefined]],['extra GET results',[null,null]]] as const){
 test('G2: partial event GET must be unavailable: '+label,async()=>{
  const {read,id}=await world(),original=redis.pipeline;let injected=false;
  redis.pipeline=async commands=>{if(commands.length===1&&commands[0][0]==='GET'&&commands[0][1]==='nl:hooks:d:'+id){injected=true;return reply as unknown[]}return original.call(redis,commands)};
  try{const r=await read(),body=await r.json();console.log('G2_EVENT_GET_OBSERVATION',JSON.stringify({label,injected,status:r.status,body}));assert(injected);assert.equal(r.status,502,'an unconfirmed delivery cannot become a complete empty history')}finally{redis.pipeline=original}
 });
}
