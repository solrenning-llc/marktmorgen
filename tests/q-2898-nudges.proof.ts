/** Independent Q evidence for frozen #2898; only synthetic stores/transports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { claimHandle,ensureStoreId,ensureStatsId,ensureListId,setSubscription,storeForEmail,addProduct } from '@/lib/store';
import { sendTrialNudges } from '@/lib/trial-nudges';
import { forgetWinbackPerson } from '@/lib/winback-send';
import { confirmErasure } from '@/lib/erasure-request';
import { leadsKey,upsertContact,tokensFor } from '@/lib/contacts';
import { isSuppressed } from '@/lib/suppression';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { ROOM } from './data-room';
process.env.STRIPE_SECRET_KEY='sk_test_q2898_only';process.env.RESEND_API_KEY='re_test_trial_nudges_only';
const DAY=86400, START=1791000000;
let checks=0;const eq=(got:unknown,want:unknown,label:string)=>{checks++;assert.deepEqual(got,want,label);};
let trials:Record<string,unknown>[]=[];let mail:string[]=[];let mailStatus=200;
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const url=new URL(String(input));
 if(url.hostname==='api.stripe.com')return new Response(JSON.stringify({data:trials,has_more:false}),{status:200});
 if(url.hostname==='api.resend.com'){
  const b=JSON.parse(String(init?.body??'{}'));if(mailStatus===200)mail.push(...[b.to].flat());
  return new Response(JSON.stringify(mailStatus===200?{id:'synthetic_q2898'}:{message:'synthetic refused'}),{status:mailStatus});
 }
 throw new Error('Unexpected synthetic transport '+url.hostname);
}) as typeof fetch;
const real=redis.pipeline.bind(redis);
type Cmd=(string|number)[];
let override:((commands:Cmd[])=>Promise<unknown[]>|null)|null=null;
redis.pipeline=(async(commands:Cmd[])=>{const x=override?.(commands);return x??real(commands);}) as typeof redis.pipeline;
const nudgeExists=(c:Cmd[])=>c[0]?.[0]==='EXISTS'&&String(c[0][1]).startsWith('nl:nudge:');
const nudgeClaim=(c:Cmd[])=>c[0]?.[0]==='SET'&&String(c[0][1]).startsWith('nl:nudge:')&&c[0].includes('NX');
let serial=0;
async function nudge(){serial++;const email=`q2898-${serial}@example.test`,handle=`q2898-${serial}`,sub=`sub_Q2898${String(serial).padStart(8,'0')}`;
 await claimHandle(email,handle,'Q nudge','');await setSubscription(email,{subscriptionId:sub,active:true,tier:'creator',cycle:'month',trialEnds:START+14*DAY,period:paidPeriod()});
 trials=[{id:sub,status:'trialing',trial_start:START,trial_end:START+14*DAY,cancel_at_period_end:false,metadata:{store:handle}}];mail=[];return{sub,email,key:`nl:nudge:${sub}:0`};}
async function main(){
 redis.clear();
 for(const reply of [[0,0,null],[0,undefined],[0,2],[0,-1],[0,0.5],[0,'0'],[0,null]]){
  await nudge();override=c=>nudgeExists(c)?Promise.resolve(reply):null;
  const r=await sendTrialNudges(START+3*DAY);override=null;eq([r.sent,r.failed,mail.length],[0,1,0],'unknown/extra EXISTS refuses');
 }
 const first=await nudge();override=c=>nudgeExists(c)?Promise.resolve([]):null;
 eq(await sendTrialNudges(START+3*DAY),{sent:0,failed:1,seen:1},'unread EXISTS is failed');override=null;
 eq(redis.run(['GET',first.key]),null,'no mark taken on unknown EXISTS');
 eq((await sendTrialNudges(START+3*DAY)).sent,1,'healthy retry after unknown read sends once');
 eq((await sendTrialNudges(START+3*DAY)).sent,0,'confirmed repeat does not resend');
 for(const applied of [false,true]){
  const f=await nudge();override=c=>nudgeClaim(c)?(async()=>{if(applied)await real(c);return ['QUEUED'];})():null;
  eq(await sendTrialNudges(START+3*DAY),{sent:0,failed:1,seen:1},'unknown claim sends nothing');override=null;
  eq(redis.run(['GET',f.key]),applied?'1':null,'uncertain applied mark is preserved');
  eq((await sendTrialNudges(START+3*DAY)).sent,applied?0:1,'healthy retry follows actual mark');
  eq(mail.length,applied?0:1,'no duplicate on retry');
 }
 const refused=await nudge();mailStatus=422;
 eq((await sendTrialNudges(START+3*DAY)).failed,1,'known sender refusal is failed');mailStatus=200;
 eq(redis.run(['GET',refused.key]),null,'refused sender releases mark');
 eq((await sendTrialNudges(START+3*DAY)).sent,1,'sender recovery retries');
 await nudge();trials[0].metadata={store:'synthetic-store-not-found'};
 eq(await sendTrialNudges(START+3*DAY),{sent:0,failed:0,seen:1},'confirmed missing store sends nothing');
 // repliesFor snapshots only own data slots before claimNudge maps counts.
 await nudge();override=c=>nudgeExists(c)?Promise.resolve(new Array(2)):null;
 const sparse=await sendTrialNudges(START+3*DAY);override=null;
 eq([sparse.sent,sparse.failed,mail.length],[0,1,0],'sparse EXISTS slots refuse');
 let getterReads=0;await nudge();const accessor=[0,0];Object.defineProperty(accessor,'1',{get(){getterReads++;return 0;}});
 override=c=>nudgeExists(c)?Promise.resolve(accessor):null;const getter=await sendTrialNudges(START+3*DAY);override=null;
 eq([getter.sent,getter.failed,mail.length,getterReads],[0,1,0,0],'getter slot refuses without execution');
 let traps=0;await nudge();const proxy=new Proxy([0,0],{get(t,p,r){if(p==='then')return undefined;traps++;return Reflect.get(t,p,r);}}); // Promise adoption reads then before the product receives the value.
 override=c=>nudgeExists(c)?Promise.resolve(proxy):null;const proxied=await sendTrialNudges(START+3*DAY);override=null;
 eq([proxied.sent,proxied.failed,mail.length,traps],[0,1,0,0],'proxy refuses without data access traps');
 // Real erasure consumer: an unapplied winback DEL keeps a grant pending even after the contact disappeared.
 const owner='q2898-erase@example.test',person='q2898-person@example.test';
 await claimHandle(owner,'q2898-erase','Q erasure','');await ensureStoreId(owner);await ensureStatsId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:'cus_Q2898Erase',subscriptionId:'sub_Q2898Erase',active:true,tier:'pro',period:paidPeriod()});
 const made=await addProduct(owner,'Synthetic guide','','9',null);assert.ok(made.ok);checks++;
 const store=(await storeForEmail(owner))!;
 await upsertContact(store.listId!,person,{agreed:true,explicit:true,source:'free'},ROOM);
 const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
 const wb=`nl:wb:once:${store.statsId}:${sha(`nimbus-wb-once:${person}|${made.product.id}`).slice(0,32)}`;
 const token='b'.repeat(64),grantKey='nl:erase:link:'+sha('nimbus-erase-link:'+token).slice(0,40);
 await real([['SET',wb,'1'],['SET',grantKey,JSON.stringify({e:person,s:[store.sid]}),'EX',3600]]);
 override=c=>c[0]?.[0]==='DEL'&&c[0].includes(wb)?Promise.resolve([]):null;
 const partial=await confirmErasure(token);override=null;
 eq([partial.state,partial.deleted,partial.later],['more',[],[store.sid]],'failed winback erasure stays pending');
 eq(redis.run(['GET',wb]),'1','unapplied winback deletion remains');
 eq(redis.run(['HGET',leadsKey(store.listId!),person]),null,'contact already removed');
 eq(await isSuppressed(store.listId,person),true,'erasure opt-out remains before retry');
 eq(typeof redis.run(['GET',grantKey]),'string','retry grant retained');
 eq((await tokensFor(store.listId!,[person],store.handle)).has(person),false,'erased address has no send token');
 const recovered=await confirmErasure(token);
 eq([recovered.state,recovered.later],['done',[]],'retry finishes despite contact now absent');
 eq(redis.run(['GET',wb]),null,'retry removed retained winback mark');
 eq(redis.run(['GET',grantKey]),null,'only completed grant consumed');
 eq(await isSuppressed(store.listId,person),true,'opt-out remains after completion');
 eq(mail.includes(person),false,'no erasure or come-back email sent to erased person');
 await real([['SET',wb,'1']]);
 override=c=>c[0]?.[0]==='DEL'&&c[0].includes(wb)?(async()=>{await real(c);return [];})():null;
 await assert.rejects(()=>forgetWinbackPerson(store.statsId,[made.product.id],person),{name:'UnknownReplyError'});checks++;override=null;
 eq(await forgetWinbackPerson(store.statsId,[made.product.id],person),0,'unknown applied DEL retries as confirmed absence');
 console.log(`PASS ${checks} independent assertions: uncertain-claim retry, no resend, sender recovery, not-found, real erasure retry and opt-out.`);
}
async function appliedUnknownObservation(){
 redis.clear();const f=await nudge();
 override=c=>nudgeClaim(c)?(async()=>{await real(c);return ['QUEUED'];})():null;
 const first=await sendTrialNudges(START+3*DAY);override=null;
 const initialEmails=mail.length,mark=redis.run(['GET',f.key]);
 const retry=await sendTrialNudges(START+4*DAY);const afterRetry=mail.length;
 const second=await sendTrialNudges(START+9*DAY);
 eq(mark,'1','applied claim is present');
 eq(second.sent,1,'second nudge remains available on its due day');
 console.log('APPLIED_UNKNOWN_OBSERVATION '+JSON.stringify({creator:f.email,first,initialEmails,mark,retry,afterRetry,second,totalEmails:mail.length}));
 // The same desired delivery assertions run on parent and fix; only the new-case mode changes.
 eq([first.sent,first.failed,initialEmails],[1,0,1],'an applied fresh claim must not lose the first creator nudge');
 eq([retry.sent,retry.failed,afterRetry],[0,0,1],'the next pass must not duplicate the first creator nudge');
 eq([second.sent,second.failed,mail.length],[1,0,2],'the second nudge remains one separate email');
 console.log(`PASS ${checks} desired applied-claim assertions.`);
}
const selected=process.env.Q_2898_CASE==='applied-claim'?appliedUnknownObservation:main;
selected().catch(e=>{override=null;console.error(e);process.exitCode=1});
