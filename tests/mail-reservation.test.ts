import { dispatch } from './mail-reservation-email';
import { sesObservation } from './mail-reservation-ses';
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from '@/lib/store';
import { upsertContact } from '@/lib/contacts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reserve, reserveDay, usedThisMonth, monthlyAllowance, sendTo, takeFromMonth } from '@/lib/mail';
import { PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS } from '@/lib/plan';
import type { Store } from '@/lib/store';
import { store as memory } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { windowId } from '@/lib/allowance-window';
import { ROOM } from "./data-room";
const actual=memory.pipeline.bind(memory);
let reply: unknown[]|undefined;
let dayRead: {value:unknown}|undefined;
let pipelines:(string|number)[][][]=[];
(memory as unknown as {pipeline:typeof memory.pipeline}).pipeline=(async(commands:(string|number)[][])=>{
 pipelines.push(commands);
 if(dayRead && commands.length===1 && commands[0][0]==='GET' && String(commands[0][1]).startsWith('nl:mail:day:')){
  if(dayRead.value instanceof Error)throw dayRead.value;
  return dayRead.value as unknown[];
 }
 const result=await actual(commands);
 const key=String(commands[0]?.[1]??'');
 return commands[0]?.[0]==='INCRBY' && (key.startsWith('nl:mail:used:')||key.startsWith('nl:mail:day:')) && reply!==undefined?reply:result;
}) as typeof memory.pipeline;
const store={listId:'a'.repeat(32),tier:'pro',subscriptionActive:true,trialEnds:0} as Store;
beforeEach(()=>{memory.clear();reply=undefined;dayRead=undefined;pipelines=[];process.env.MARKETING_DAILY_CAP='100000';dispatch.calls=0;dispatch.listCalls=0;dispatch.notices.length=0;dispatch.outcome='retry';sesObservation.configured=true;sesObservation.room=100000;});
test('paid list caps (raised 18 October 2026 with the new prices) are the actual runtime allowances',()=>{assert.equal(monthlyAllowance(store),7000);assert.equal(monthlyAllowance({...store,tier:'scale'}),10000);assert.equal(PRO_MONTHLY_EMAILS,7000);assert.equal(SCALE_MONTHLY_EMAILS,10000);});
test('an acknowledged exact reservation consumes the monthly capacity',async()=>{assert.equal(await reserve(store,3),'ok');assert.equal(await usedThisMonth(store.listId),3);});
test('missing, partial or corrupt counter acknowledgements cannot authorize',async()=>{
 for(const value of [[],[1,1],[1,1,1],[1,1,1,1,1],[undefined,1,1,1],[true,1,1,1],['01',1,1,1],[-1,1,1,1],[0,1,1,1],[1.5,1,1,1],[NaN,1,1,1],[Infinity,1,1,1],[1,0,1,1],[1,1,1,0],[1,true,1,1]]){reply=value;assert.equal(await reserve(store,1),'unavailable');}
});
test('a lost acknowledgement retains the actual reservation and never decrements it',async()=>{reply=[];assert.equal(await reserve(store,2),'unavailable');reply=undefined;assert.equal(await usedThisMonth(store.listId),2);assert.equal(pipelines.some(c=>c.some(x=>x[0]==='DECRBY')),false);});
test('invalid or excessive request counts never touch provider or ledger capacity',async()=>{for(const n of [-1,0.5,NaN,Infinity,PRO_MONTHLY_EMAILS+1])assert.equal(await reserve(store,n),'month');assert.equal(pipelines.length,0);assert.equal(await reserve(store,0),'ok');assert.equal(pipelines.length,0);});
test('exact monthly boundary passes and another attempt is refused without over-authorizing',async()=>{assert.equal(await reserve(store,PRO_MONTHLY_EMAILS),'ok');assert.equal(await reserve(store,1),'month');assert.equal(await usedThisMonth(store.listId),PRO_MONTHLY_EMAILS);});
test('day-only reservations also require exact acknowledged counters',async()=>{for(const value of [[],[1],[0,1],[1,0],[false,1],[1,1,1]]){reply=value;assert.equal(await reserveDay(1),false);}reply=undefined;assert.equal(await reserveDay(1),true);});

async function fullStore(){
 const owner='mailbudget@example.com';
 await claimHandle(owner,'mailbudget','Synthetic Mail Budget','');
 await ensureStatsId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:'cus_MailBudget0001',subscriptionId:'sub_MailBudget0001',active:true,tier:'pro',period:paidPeriod()});
 await setMailSettings(owner,{fromName:'Synthetic Mail Budget',address:'1 Test St, Portland, OR 97201'});
 const made=(await storeForEmail(owner))!;
 await upsertContact(made.listId!,'reader@example.com',{agreed:true,explicit:true,source:'free'}, ROOM);
 return made;
}
test('actual send loop never dispatches after a lost reservation acknowledgement',async()=>{
 const made=await fullStore();reply=[];const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only','lost-reservation');
 assert.equal(result.stopped,'retry');assert.equal(dispatch.calls,0);reply=undefined;assert.equal(await usedThisMonth(made.listId, windowId(made)),1);
});
test('actual provider retry outcomes retain attempted monthly capacity',async()=>{
 const made=await fullStore();
 for(const key of ['first-attempt','second-attempt']){const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only',key);assert.equal(result.stopped,'retry');}
 assert.equal(dispatch.calls,2);assert.equal(await usedThisMonth(made.listId, windowId(made)),2);
});
test('a provider refusal also cannot replenish dispatched attempt capacity',async()=>{
 const made=await fullStore();dispatch.outcome='refused';const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only','refused-attempt');
 assert.equal(result.stopped,'refused');assert.equal(dispatch.calls,1);assert.equal(await usedThisMonth(made.listId, windowId(made)),1);
});

test('funded paid mail cannot consume sender or monthly capacity without its paid cohort',async()=>{
 const made=await fullStore(),marked={...made,period:{...made.period!,funded:true as const}};
 const before=pipelines.length;
 assert.equal(await reserve(marked,1),'unavailable');
 assert.equal(await takeFromMonth(marked,1),0);
 assert.equal(pipelines.length,before);assert.equal(dispatch.calls,0);
});
test('funded paid list dispatch stops before the provider when financial approvals are absent',async()=>{
 const made=await fullStore(),marked={...made,period:{...made.period!,funded:true as const}};
 const result=await sendTo(marked,['reader@example.com'],'Synthetic','Test only','funded-cohort-required');
 assert.equal(result.stopped,'retry');assert.equal(dispatch.calls,0);
 assert.equal(await usedThisMonth(made.listId,windowId(made)),0);
});

test('unknown daily usage stops the real list loop before reservations and dispatch',async()=>{
 const made=await fullStore();pipelines=[];
 const inherited=new Array(1);Object.setPrototypeOf(inherited,{0:null});
 let getterCalls=0;
 const computed=new Array(1);Object.defineProperty(computed,'0',{get:()=>{getterCalls++;return null;}});
 const malformed:unknown[]=[{},null,[],[null,null],new Array(1),inherited,computed,
  [undefined],[false],[0],[{}],[''],[' 0'],['01'],['-1'],['0.5'],['1e2'],
  ['9007199254740992'],new Error('synthetic daily read lost')];
 for(let i=0;i<malformed.length;i++){
  dayRead={value:malformed[i]};
  const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only','unknown-day-'+i);
  assert.equal(result.stopped,'day');assert.deepEqual(result.done,[]);
  assert.deepEqual(result.rest,['reader@example.com']);
  assert.equal(result.uncertain,undefined);
  assert.equal(dispatch.calls,0);
  assert.equal(await usedThisMonth(made.listId,windowId(made)),0);
 }
 assert.equal(getterCalls,0);
 assert.equal(pipelines.some(commands=>commands.some(command=>command[0]==='INCRBY'||command[0]==='DECRBY')),false);
});
test('explicit daily absence and canonical available counts admit; exhausted counts wait',async()=>{
 const made=await fullStore();dispatch.outcome='sent';
 for(const [index,value] of [null,'0','99999'].entries()){
  dayRead={value:[value]};
  const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only','known-day-'+index);
  assert.equal(result.stopped,null);assert.deepEqual(result.done,['reader@example.com']);
 }
 assert.equal(dispatch.calls,3);assert.equal(await usedThisMonth(made.listId,windowId(made)),3);
 for(const value of ['100000','100001','9007199254740991']){
  dayRead={value:[value]};
  const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only','full-day-'+value);
  assert.equal(result.stopped,'day');assert.equal(dispatch.calls,3);
  assert.equal(await usedThisMonth(made.listId,windowId(made)),3);
 }
});

test('list dispatch uses only SES and known no-send waits keep recipients and allowance',async()=>{
 const made=await fullStore();dispatch.outcome='waiting';
 const before=await usedThisMonth(made.listId,windowId(made));
 pipelines=[];
 const waiting=await sendTo(made,['reader@example.com'],'Synthetic','Test only','known-no-send');
 assert.equal(waiting.stopped,'sender');assert.deepEqual(waiting.rest,['reader@example.com']);
 assert.equal(waiting.uncertain,undefined);assert.deepEqual(waiting.done,[]);
 assert.equal(dispatch.calls,1);assert.equal(dispatch.listCalls,1);
 const cleanupStart=pipelines.findIndex(commands=>commands.some(command=>command[0]==='DECRBY'));
 assert.ok(cleanupStart>=0);
 assert.ok(pipelines.slice(cleanupStart).reduce((sum,commands)=>sum+commands.length,0)<=4,'cleanup is bounded by the existing release and portion-return operations');
 assert.equal(await usedThisMonth(made.listId,windowId(made)),before,'confirmed no-send returns the monthly reservation');
 assert.equal(pipelines.filter(commands=>commands.some(command=>command[0]==='DECRBY')).length,1,'one existing two-counter release, not a retry loop');
 dispatch.outcome='sent';
 const recovered=await sendTo(made,['reader@example.com'],'Synthetic','Test only','known-no-send');
 assert.equal(recovered.stopped,null);assert.deepEqual(recovered.done,['reader@example.com']);
 assert.equal(dispatch.listCalls,2);assert.equal(await usedThisMonth(made.listId,windowId(made)),before+1);
});
test('missing SES or exhausted SES room cannot borrow Resend capacity or retain a list attempt',async()=>{
 const made=await fullStore();
 for(const state of [{configured:false,room:100000},{configured:true,room:0}]){
  Object.assign(sesObservation,state);pipelines=[];
  const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only','no-ses-room');
  assert.equal(result.stopped,'sender');assert.equal(result.uncertain,undefined);
  assert.deepEqual(result.rest,['reader@example.com']);assert.equal(dispatch.calls,0);
  const ledger=pipelines.filter(commands=>commands.some(command=>command[0]==='INCRBY'||command[0]==='DECRBY'));
  if(!state.configured)assert.equal(ledger.length,0,'missing SES waits before ledger work');
  else {
   assert.equal(ledger.filter(commands=>commands.some(command=>command[0]==='INCRBY')).length,1,'configured SES checks one bounded reservation');
   assert.equal(ledger.filter(commands=>commands.some(command=>command[0]==='DECRBY')).length,1,'known no-room returns both counters once');
  }
  assert.equal(await usedThisMonth(made.listId,windowId(made)),0);
 }
 assert.equal(dispatch.notices.length,1,'the existing monthly owner-notice claim is shared by both waits');
 assert.equal(dispatch.notices[0].subject,'List email is waiting for Amazon SES');
 assert.match(dispatch.notices[0].text,/Creator list email sends only through Amazon SES/);
 assert.match(dispatch.notices[0].text,/Resend is not used for this list batch/);
 assert.match(dispatch.notices[0].text,/This notice does not confirm delivery/);
 assert.doesNotMatch(dispatch.notices[0].text,/larger plan|SENDER_MONTHLY_QUOTA|went out through Resend/);
});
test('unknown acceptance still holds capacity and stops automatic list retry',async()=>{
 const made=await fullStore();dispatch.outcome='retry';pipelines=[];
 const result=await sendTo(made,['reader@example.com'],'Synthetic','Test only','unknown-ses-send');
 assert.equal(result.stopped,'retry');assert.deepEqual(result.uncertain,['reader@example.com']);
 assert.equal(dispatch.listCalls,1);assert.equal(await usedThisMonth(made.listId,windowId(made)),1);
 assert.equal(pipelines.some(commands=>commands.some(command=>command[0]==='DECRBY')),false);
});
