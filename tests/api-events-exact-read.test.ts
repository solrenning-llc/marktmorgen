/**
 * Codex G2 on #2192: GET /api/v1/events through the real route, with the
 * reading of the deliveries (lib/webhooks.ts, READ_DELIVERIES) answered
 * partly, with extra items, or not as a receipt: 502, never 200 with an
 * empty history. Synthetic store, key and Redis only.
 */
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
test('control: a delivery kept is sent',async()=>{const {read}=await world();const r=await read();assert.equal(r.status,200);assert.equal((await r.json()).data.length,1)});
test('control: a delivery gone is an empty history',async()=>{
 const {read,id}=await world();await redis.pipeline([['DEL','nl:hooks:d:'+id]]);const r=await read();assert.equal(r.status,200);assert.deepEqual((await r.json()).data,[]);
});
for(const [label,reply] of [['missing results',[1,[]]],['missing slot',[1,[undefined]]],['extra results',[1,[null,null]]],['no state',[[null]]],['a state of true',[true,[null]]],['refused as larger',[0]],['a value larger than its bound',[1,['x'.repeat(200_000)]]]] as const){
 test('a reading of the deliveries not answered exactly is unavailable, never an empty history (Codex G2): '+label,async()=>{
  const {read,id}=await world(),original=redis.pipeline;let injected=false;
  redis.pipeline=async commands=>{if(commands.length===1&&commands[0][0]==='EVAL'&&String(commands[0][1]).startsWith('-- marktmorgen:webhook-deliveries-read')&&commands[0][3]==='nl:hooks:d:'+id){injected=true;return [reply] as unknown[]}return original.call(redis,commands)};
  try{const r=await read();assert(injected);assert.equal(r.status,502,'an unconfirmed delivery cannot become a complete empty history')}finally{redis.pipeline=original}
 });
}
