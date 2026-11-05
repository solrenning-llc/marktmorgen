/** Independent G2: actual saveFlow retries must not assign stale data-room totals to a newer definition. */
import test from 'node:test';import assert from 'node:assert/strict';
import {saveFlow,readFlows} from '@/lib/flows';
import {dataKey} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
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

test('control: a real workflow edit is fully charged',async()=>{
 const s=await seed();assert.ok((await saveFlow(s.store,s.next)).ok);
 const raw=String(redis.run(['GET',`nl:mail:flows:${s.store.listId}`]));const flows=await readFlows(s.store.listId);assert.deepEqual(JSON.parse(raw),flows);
 assert.ok(Number(redis.run(['HGET',dataKey(s.store)!,'wf:defs']))>=dataBytes([raw],1+flows.length));
});
test('three actual CAS refusals cannot finish with a stale recount below the newer retained definition',async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis),key=`nl:mail:flows:${s.store.listId}`;let attempts=0,phase='write';
 const spy:typeof redis.pipeline=async batch=>{
  if(phase==='write'&&attempts<3&&batch.length===1&&batch[0][0]==='EVAL'&&String(batch[0][1]).startsWith('-- marktmorgen:flows-write-if:')){
   attempts++;redis.pipeline=original;
   const now=(await readFlows(s.store.listId))[0];
   assert.ok((await saveFlow(s.store,{...now,name:`B short ${attempts}`,steps:now.steps.map(step=>({...step,body:'B'}))})).ok);
   redis.pipeline=spy;const answer=await original(batch);assert.deepEqual(answer,[0],'the actual old compare-and-set refuses the newer real definition');phase='recount';return answer;
  }
  if(phase==='recount'&&batch.length===1&&batch[0][0]==='GET'&&batch[0][1]===key){
   const snapshot=await original(batch);redis.pipeline=original;
   const now=(await readFlows(s.store.listId))[0];
   assert.ok((await saveFlow(s.store,{...now,name:`C retained ${attempts}`,steps:now.steps.map(step=>({...step,body:'C'.repeat(2000)}))})).ok);
   redis.pipeline=spy;phase='write';return snapshot;
  }
  return original(batch);
 };
 redis.pipeline=spy;let refused=false;try{await saveFlow(s.store,{...s.flow,name:'A never landed',steps:s.flow.steps.map(step=>({...step,body:'A'.repeat(500)}))});}catch{refused=true;}finally{redis.pipeline=original;}
 assert.equal(attempts,3);assert.equal(refused,true);const flows=await readFlows(s.store.listId),raw=String(redis.run(['GET',key]));
 assert.equal(flows[0].name,'C retained 3');const charged=Number(redis.run(['HGET',dataKey(s.store)!,'wf:defs'])),required=dataBytes([raw],1+flows.length);
 console.log('G2_WORKFLOW_DEFINITION_RECOUNT',JSON.stringify({attempts,refused,charged,required}));
 assert.ok(charged>=required,'an old failed workflow change returned room still holding the newer actual definition');
});
