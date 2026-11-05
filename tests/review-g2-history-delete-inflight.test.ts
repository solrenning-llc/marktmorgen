/** Independent G2: actual saveFlow may finish its first history push after actual store-workflow cleanup. */
import test from 'node:test';import assert from 'node:assert/strict';
import {saveFlow,forgetStoreWorkflows,readFlows} from '@/lib/flows';
import {readFlowVersions} from '@/lib/flow-versions';
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
test('control: ordinary real store-workflow cleanup removes existing history',async()=>{
 const s=await seed();assert.ok((await saveFlow(s.store,s.next)).ok);assert.equal((await readFlowVersions(s.store.listId,s.flow.id)).length,1);
 await forgetStoreWorkflows(s.store);assert.equal((await readFlows(s.store.listId)).length,0);assert.equal(redis.run(['EXISTS',s.key]),0);
});
test('a first historical push already in flight cannot recreate history after cleanup returns',async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);let reached=0,cleaned=false;
 redis.pipeline=async batch=>{
  if(batch.length===1&&batch[0][0]==='EVAL'&&String(batch[0][1]).startsWith('-- marktmorgen:flow-version-keep:')&&batch[0][3]===s.key){
   redis.pipeline=original;reached++;
   await forgetStoreWorkflows(s.store);
   assert.equal((await readFlows(s.store.listId)).length,0);assert.equal(redis.run(['LLEN',s.key]),0,'cleanup has removed every retained version before the old push resumes');cleaned=true;
   return original(batch);
  }
  return original(batch);
 };
 let result;try{result=await saveFlow(s.store,s.next);}finally{redis.pipeline=original;}
 assert.equal(reached,1);assert.equal(cleaned,true);assert.equal((await readFlows(s.store.listId)).length,0);
 const versions=await readFlowVersions(s.store.listId,s.flow.id);
 console.log('G2_HISTORY_AFTER_CLEANUP',JSON.stringify({saveOK:result.ok,cleaned,retained:versions.map(v=>v.flow.steps[0].subject)}));
 assert.equal(versions.length,0,'an old real save must not put a deleted store workflow template back after successful cleanup');
});
