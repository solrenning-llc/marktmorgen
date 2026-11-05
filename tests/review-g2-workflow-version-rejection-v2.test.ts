/** Identified G2 DEL-or-DROP_SCRIPT hook variant; original rejection assertions preserved. */
/** G2 compatibility copy of e5dbe585: permit the new explicit rejection of an unknown delete; also replace one unreachable error diagnostic for strict TypeScript. Every assertion and fixture stays unchanged. Original remains in review-g2-workflow-version-evidence.test.ts. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {saveFlow,readFlows,restoreFlowVersion,setFlowActive} from '@/lib/flows';
import {readFlowVersions,dropFlowVersions} from '@/lib/flow-versions';
import {dataKey} from '@/lib/store-data';
import {contentRoomFor,dataBytes} from '@/lib/store-data-rules';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId,ensureListId,setMailSettings,setStripeAccount,setSubscription,storeForEmail} from '@/lib/store';
import {POST} from '@/app/api/store/mail/route';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
globalThis.fetch=async()=>{throw Error('No external service in G2 review');};
async function fixture(){
 redis.clear();const email='g2-workflow-history@example.test';
 await claimHandle(email,'g2-workflow-history','Synthetic workflows','');await ensureStatsId(email);await ensureListId(email);
 await setStripeAccount(email,'acct_G2FlowVersion',true);
 await setSubscription(email,{customerId:'cus_G2FlowVersion',subscriptionId:'sub_G2FlowVersion',active:true,tier:'pro',period:paidPeriod()});
 await setMailSettings(email,{fromName:'Synthetic sender',address:'SYNTHETIC POSTAL ADDRESS'});
 const shop=(await storeForEmail(email))!,first=await saveFlow(shop,{name:'Synthetic sequence',trigger:'joined',steps:[{delayHours:0,subject:'Subject A',body:'Synthetic known body.'}]});assert.ok(first.ok);if(!first.ok)throw Error("the first save was refused");
 const before=first.flows[0],id=before.id;
 const second=await saveFlow(shop,{...before,steps:before.steps.map(s=>({...s,subject:'Subject B'}))});assert.ok(second.ok);
 const versions=await readFlowVersions(shop.listId,id);assert.equal(versions.length,1);
 const key=`nl:wf:ver:${shop.listId}:${id}`,room=dataKey(shop)!;
 const token=await openSession(email);
 const post=async()=>{const r=await POST(new NextRequest('https://marktmorgen.com/api/store/mail',{method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${token}`},body:JSON.stringify({action:'flow-versions',id})}));return{status:r.status,body:await r.json()};};
 return{shop,id,key,room,before,versions,post};
}
test('control: confirmed history is readable and accounted',async()=>{
 const f=await fixture(),r=await f.post();assert.equal(r.status,200);assert.equal(r.body.versions.length,1);
 const [list,charged]=await redis.pipeline([['LRANGE',f.key,0,-1],['HGET',f.room,'wv:'+f.id]]);assert.ok(Number(charged)>=dataBytes(list as string[],(list as string[]).length));
});
test('unknown history read is never a confirmed empty version list',async()=>{
 const f=await fixture(),base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(c=>c[0]==='LRANGE'&&c[1]===f.key)?[]:base(batch);
 try{const r=await f.post();console.log('G2_UNKNOWN_HISTORY',JSON.stringify(r));assert.notEqual(r.body.ok,true,'unknown read was confirmed as an empty history');}finally{redis.pipeline=base;}
});
test('unknown held history cannot make the next version unaccounted',async()=>{
 const f=await fixture(),base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(c=>c[0]==='LRANGE'&&c[1]===f.key)?[]:base(batch);
 try{
  const current=(await readFlows(f.shop.listId)).find(x=>x.id===f.id)!;
  const result=await saveFlow(f.shop,{...current,steps:current.steps.map(s=>({...s,subject:'Subject C'}))});assert.ok(result.ok);
  const [held,charged]=await base([['LRANGE',f.key,0,-1],['HGET',f.room,'wv:'+f.id]]);const required=dataBytes(held as string[],(held as string[]).length);
  console.log('G2_HISTORY_UNDERCOUNT',JSON.stringify({entries:(held as string[]).length,required,charged}));assert.ok(Number(charged)>=required,'retained history exceeds the bytes admitted for its slot');
 }finally{redis.pipeline=base;}
});
test('unknown unapplied delete cannot release room while history survives',async()=>{
 const f=await fixture(),base=redis.pipeline.bind(redis);redis.pipeline=async batch=>batch.some(c=>((c[0]==='DEL'&&c[1]===f.key)||(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:flow-version-drop:')&&c[3]===f.key)))?[]:base(batch);
 try{
  await dropFlowVersions(f.shop,f.shop.listId!,f.id).catch(() => undefined);
  const [held,charged]=await base([['LRANGE',f.key,0,-1],['HGET',f.room,'wv:'+f.id]]);const required=dataBytes(held as string[],(held as string[]).length);
  assert.equal((held as string[]).length,1);console.log('G2_DELETE_RELEASE',JSON.stringify({required,charged}));assert.ok(Number(charged)>=required,'unknown deletion freed storage still holding the old workflow');
 }finally{redis.pipeline=base;}
});
test('a full history budget must not silently destroy the version promised as undoable',async()=>{
 const f=await fixture();await redis.pipeline([['HSET',f.room,'#',String(contentRoomFor(f.shop))]]);
 const result=await restoreFlowVersion(f.shop,f.id,f.versions[0].at);
 const current=(await readFlows(f.shop.listId)).find(x=>x.id===f.id)!;
 const history=await readFlowVersions(f.shop.listId,f.id);
 console.log('G2_RESTORE_FULL',JSON.stringify({ok:result.ok,current:current.steps[0].subject,history:history.map(v=>v.flow.steps[0].subject)}));
 if(result.ok)assert.ok(history.some(v=>v.flow.steps[0].subject==='Subject B'),'restore confirmed undoability but discarded the replaced workflow');
 else assert.equal(current.steps[0].subject,'Subject B');
});

test('restoration cannot reactivate a workflow paused while its history was being read',async()=>{
 const f=await fixture();assert.ok((await setFlowActive(f.shop,f.id,true)).ok);
 const base=redis.pipeline.bind(redis);let paused=false;
 redis.pipeline=async batch=>{
  const answer=await base(batch);
  if(!paused&&batch.some(c=>c[0]==='LRANGE'&&c[1]===f.key)){
   paused=true;assert.ok((await setFlowActive(f.shop,f.id,false)).ok);
   assert.equal((await readFlows(f.shop.listId)).find(x=>x.id===f.id)!.active,false,'second operation really paused the flow');
  }
  return answer;
 };
 try{
  const result=await restoreFlowVersion(f.shop,f.id,f.versions[0].at);
  const active=(await readFlows(f.shop.listId)).find(x=>x.id===f.id)!.active;
  console.log('G2_RESTORE_PAUSE_RACE',JSON.stringify({paused,result:result.ok,active}));assert.equal(paused,true);assert.equal(active,false,'restoration overwrote a confirmed pause with its stale active flag');
 }finally{redis.pipeline=base;}
});
