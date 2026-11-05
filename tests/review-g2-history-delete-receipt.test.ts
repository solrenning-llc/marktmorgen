/** Independent G2: structural triples must also satisfy the deletion script logical invariants. */
/** Independent G2: actual saveFlow may finish its first history push after actual store-workflow cleanup. */
import test from 'node:test';import assert from 'node:assert/strict';
import {saveFlow} from '@/lib/flows';
import {readFlowVersions,dropFlowVersions} from '@/lib/flow-versions';
import {dataKey} from '@/lib/store-data';
import {claimHandle,ensureStatsId,ensureListId,setMailSettings,setStripeAccount,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';import {store as redis} from './redis-stub';
globalThis.fetch=async()=>{throw Error('External transport prohibited in independent review');};
async function seed(){
 redis.clear();const owner='g2-history-delete@example.test';await claimHandle(owner,'g2historydelete','Synthetic workflows','');await ensureStatsId(owner);await ensureListId(owner);
 await setStripeAccount(owner,'acct_G2HistoryDelete',true);await setSubscription(owner,{customerId:'cus_G2HistoryDelete',subscriptionId:'sub_G2HistoryDelete',active:true,tier:'pro',period:paidPeriod()});
 await setMailSettings(owner,{fromName:'Synthetic sender',address:'SYNTHETIC POSTAL ADDRESS'});const store=(await storeForEmail(owner))!;
 const result=await saveFlow(store,{name:'Synthetic sequence',trigger:'joined',steps:[{delayHours:0,subject:'Before cleanup',body:'Synthetic retained template.'}]});assert.ok(result.ok);if(!result.ok)throw Error('Fixture refused');
 const flow=result.flows[0],key=`nl:wf:ver:${store.listId}:${flow.id}`;assert.equal(redis.run(['LLEN',key]),0);
 return{store,flow,key,next:{...flow,steps:flow.steps.map(s=>({...s,subject:'An edit before cleanup'}))}};
}

test('control: a confirmed version deletion removes history and its room',async()=>{
 const s=await seed();assert.ok((await saveFlow(s.store,s.next)).ok);await dropFlowVersions(s.store,s.store.listId!,s.flow.id);
 assert.equal((await readFlowVersions(s.store.listId,s.flow.id)).length,0);assert.equal(Number(redis.run(['HGET',dataKey(s.store)!,'wv:'+s.flow.id])??0),0);
});
for(const length of [64,999999999])test(`an unapplied impossible receipt count0/bytes${length} cannot confirm deletion or return room`,async()=>{
 const s=await seed();assert.ok((await saveFlow(s.store,s.next)).ok);const before=redis.run(['LRANGE',s.key,0,-1]),room=dataKey(s.store)!,slot='wv:'+s.flow.id,held=redis.run(['HGET',room,slot]);const original=redis.pipeline.bind(redis);let reached=0,unknown=false;
 redis.pipeline=async batch=>{
  if(batch.length===1&&((batch[0][0]==='EVAL'&&String(batch[0][1]).startsWith('-- marktmorgen:flow-version-drop:')&&batch[0][3]===s.key)||(batch[0][0]==='DEL'&&batch[0][1]===s.key))){reached++;return [[1,0,length]];}
  return original(batch);
 };
 try{await dropFlowVersions(s.store,s.store.listId!,s.flow.id);}catch{unknown=true;}finally{redis.pipeline=original;}
 assert.equal(reached,1);assert.deepEqual(redis.run(['LRANGE',s.key,0,-1]),before);
 const after=redis.run(['HGET',room,slot]);console.log('G2_HISTORY_IMPOSSIBLE_DELETE',JSON.stringify({length,unknown,held,after}));
 assert.equal(unknown,true,'a count of zero cannot have positive aggregate string length in the actual Lua script');assert.equal(after,held,'unknown unapplied deletion preserves the room still holding history');
});
