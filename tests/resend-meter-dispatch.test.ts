/** Real sender/guard and allowance validators; only synthetic HTTP/Redis ACK boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {sendEmail,sendBatch,queuedShipmentMailSender} from '@/lib/email';
import {guardedResendPost,type ResendPost} from '../lib/resend-fallback-transport';
import {createResendFallbackFixture} from './resend-fallback-fixture';
import {allowanceUsed,takeAllowance} from '@/lib/store-allowance';
import {CURRENT_CONTRACT_FUNDING_POLICY} from '@/lib/contract-funding-rules';
import {CURRENT_COMMERCIAL_MARGIN_REVIEW} from '@/lib/commercial-margin';
import {store} from './redis-stub';
const credential='re_SYNTHETIC_TRANSPORT_ONLY';
process.env.RESEND_API_KEY=credential;
for(const name of ['RESEND_READ_API_KEY','RESEND_CREATORS_API_KEY','AWS_SES_ROLE_ARN','AWS_SES_REGION','AWS_SES_CONFIGURATION_SET','AWS_SES_TOPIC_ARN','VERCEL_OIDC_TOKEN','VERCEL'])delete process.env[name];
const now=Math.floor(Date.now()/1000);
const owner={statsId:'meter_dispatch_1502',tier:'creator' as const,cycle:'month' as const,subscriptionId:'sub_ReviewMeter1502',subscriptionActive:true,trialEnds:0,planEndedAt:'',period:{start:now-1000,end:now+86400,renews:true}};
const body={from:'Shop <shop@example.test>',to:['buyer@example.test'],subject:'Synthetic mail',text:'Original content'};
const message={...body,to:body.to[0],html:'<p>Original content</p>',idempotencyKey:'synthetic-meter-stable',meter:{by:'store' as const,store:owner,kind:'email' as const}};
const request=(key:string,beforePost:()=>Promise<boolean>):ResendPost=>({base:'https://api.resend.com',path:'/emails',credential,usageCredential:credential,body:JSON.stringify(body),idempotencyKey:key,recipients:1,beforePost});
const accepted:typeof fetch=async()=>Response.json({id:'synthetic_accepted'});
const posts=(f:Awaited<ReturnType<typeof createResendFallbackFixture>>)=>f.requests.filter(r=>r.method==='POST').length;

test('full account sent plus received does not spend store quota across repeated calls',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:3,sent:1,received:2,fetch:accepted});
 for(let i=0;i<3;i++)assert.equal(await sendEmail(message,f.runtime),false);
 assert.equal(await allowanceUsed(owner,'email'),0);assert.equal(posts(f),0);
});
test('an over-cap batch cannot debit any of its filtered message occurrences',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:3,sent:1,received:1,fetch:accepted});
 const batch=[{...message,to:'invalid'},message,{...message,to:message.to}];
 for(let i=0;i<3;i++)assert.equal(await sendBatch(batch,'synthetic-over-cap-batch',message.meter,'resend',f.runtime),'retry');
 assert.equal(await allowanceUsed(owner,'email'),0);assert.equal(posts(f),0);
});
test('accepted sender receipt replay consumes no second store allowance, including batch n>1',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:10,received:1,fetch:accepted});
 assert.equal(await sendEmail(message,f.runtime),true);assert.equal(await sendEmail(message,f.runtime),true);
 assert.equal(await allowanceUsed(owner,'email'),1);assert.equal(posts(f),1);
 store.clear();const b=await createResendFallbackFixture({credential,cap:10,fetch:async()=>Response.json({data:[{id:'a'},{id:'b'}]})});
 const batch=[message,{...message,to:'other@example.test'}];
 assert.equal(await sendBatch(batch,'synthetic-batch-replay',message.meter,'resend',b.runtime),'sent');
 assert.equal(await sendBatch(batch,'synthetic-batch-replay',message.meter,'resend',b.runtime),'sent');
 assert.equal(await allowanceUsed(owner,'email'),2);assert.equal(posts(b),1);
});
test('only the confirmed dispatch CAS winner executes the debit callback',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:10,fetch:accepted});let hooks=0;
 const hook=async()=>{hooks++;const took=await takeAllowance(owner,'email');await new Promise(r=>setTimeout(r,20));return took.ok;};
 const results=await Promise.all([guardedResendPost(request('concurrent-meter',hook),f.runtime),guardedResendPost(request('concurrent-meter',hook),f.runtime)]);
 assert.equal(results.filter(r=>r.kind==='response').length,1);assert.equal(posts(f),1);
 assert.equal(hooks,1);assert.equal(await allowanceUsed(owner,'email'),1);
});
test('lost dispatch ACK keeps the account hold without calling debit or provider',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:1,fetch:accepted});f.loseNext('dispatch');let hooks=0;
 const hook=async()=>{hooks++;return(await takeAllowance(owner,'email')).ok;};
 assert.equal((await guardedResendPost(request('lost-dispatch-meter',hook),f.runtime)).kind,'unknown');
 await guardedResendPost(request('lost-dispatch-meter',hook),f.runtime);
 assert.equal(hooks,0);assert.equal(await allowanceUsed(owner,'email'),0);assert.equal(posts(f),0);assert.equal(f.held(),1);
});
test('a refusing or throwing callback settles only its acknowledged dispatch capability',async()=>{
 for(const throws of [false,true]){
  store.clear();const f=await createResendFallbackFixture({credential,cap:1,fetch:accepted});let hooks=0;
  const result=await guardedResendPost(request('no-http-'+throws,async()=>{hooks++;assert.equal([...f.claims.values()][0]?.state,'dispatched');if(throws)throw Error('synthetic debit ACK unknown');return false;}),f.runtime);
  assert.equal(result.kind,'unknown');assert.equal(hooks,1);assert.equal(posts(f),0);assert.equal(f.held(),0);
  assert.equal(f.commands.some(c=>c[5]==='cancel'),false);
  const settlement=f.commands.find(c=>c[5]==='settle');assert.ok(settlement);assert.equal(settlement[23],'confirmed_not_accepted');assert.equal(typeof settlement[26],'string');assert.notEqual(settlement[26],'');
 }
});
test('unknown callback settlement ACK does not authorize any POST or repeat debit',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:1,fetch:accepted});f.loseNext('settle');let hooks=0;
 const result=await guardedResendPost(request('lost-debit-settle',async()=>{hooks++;return false;}),f.runtime);
 assert.equal(result.kind,'unknown');assert.equal(hooks,1);assert.equal(posts(f),0);assert.equal(f.commands.some(c=>c[5]==='cancel'),false);
});
test('callback time consumes the original exclusive dispatch deadline',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:1,fetch:accepted});let hooks=0;
 const result=await guardedResendPost(request('slow-debit',async()=>{hooks++;await new Promise(r=>setTimeout(r,1050));return true;}),f.runtime);
 assert.equal(result.kind,'unknown');assert.equal(hooks,1);assert.equal(posts(f),0);assert.equal(f.held(),1);
});
test('one invocation reuses its store debit after known HTTP429 without skipping either dispatch',async()=>{
 store.clear();let count=0;const f=await createResendFallbackFixture({credential,cap:5,fetch:async()=>++count===1?Response.json({error:'slow'},{status:429}):Response.json({id:'synthetic_after_429'})});
 assert.equal(await sendEmail({...message,idempotencyKey:'synthetic-429-meter'},f.runtime),true);
 assert.equal(posts(f),2);assert.equal(await allowanceUsed(owner,'email'),1);assert.equal(f.commands.filter(c=>c[5]==='dispatch').length,2);
});
test('a retry cannot reuse an old-window debit or debit a new window after HTTP429',async()=>{
 store.clear();const clock=Date.now,originalTime=clock();let calls=0;
 try{
  const f=await createResendFallbackFixture({credential,cap:5,fetch:async()=>{
   calls++;Date.now=()=>originalTime+86400000+2000;return Response.json({error:'slow'},{status:429});
  }});
  assert.equal(await sendEmail({...message,idempotencyKey:'synthetic-cross-window'},f.runtime),false);
  assert.equal(calls,1);assert.equal(f.requests.filter(r=>r.method==='GET').length,1);
  assert.equal(await allowanceUsed(owner,'email',originalTime),1);assert.equal(await allowanceUsed(owner,'email'),0);
 }finally{Date.now=clock;}
});
test('a batch keeps its original occurrences and content through a known tags refusal',async()=>{
 store.clear();const batch=[{...message,tags:{shop:'original'}},{...message,to:message.to,tags:{shop:'original'}}];let calls=0;
 const f=await createResendFallbackFixture({credential,cap:5,fetch:async()=>{
  if(++calls===1){batch[0].to='changed@example.test';batch[0].text='Changed content';batch[0].tags.shop='changed';return Response.json({error:'tags'},{status:422});}
  return Response.json({data:[{id:'first_occurrence'},{id:'second_occurrence'}]});
 }});
 assert.equal(await sendBatch(batch,'synthetic-stable-tags',message.meter,'resend',f.runtime),'sent');
 const sent=f.requests.filter(r=>r.method==='POST').map(r=>JSON.parse(r.body!));
 assert.equal(sent.length,2);assert.deepEqual(sent.map(rows=>rows.map((m:{to:string[];text:string})=>({to:m.to,text:m.text}))),Array.from({length:2},()=>Array.from({length:2},()=>({to:[message.to],text:message.text}))));
 assert.equal(await allowanceUsed(owner,'email'),2);
});
test('missing actual funded cohort refuses before usage GET and before store debit',async()=>{
 store.clear();assert.equal(CURRENT_CONTRACT_FUNDING_POLICY,null);assert.equal(CURRENT_COMMERCIAL_MARGIN_REVIEW,null);
 const f=await createResendFallbackFixture({credential,cap:5,fetch:accepted});
 const funded={...owner,period:{...owner.period,funded:true as const}};
 assert.equal(await sendEmail({...message,meter:{...message.meter,store:funded}},f.runtime),false);
 assert.equal(f.requests.length,0);assert.equal(await allowanceUsed(funded,'email'),0);
});
test('an unknown store debit is kept without a provider request or an automatic refund',async()=>{
 store.clear();const original=store.pipeline;let lost=false,refunds=0;
 store.pipeline=async commands=>{
  refunds+=commands.filter(c=>c[0]==='DECRBY'&&String(c[1]).startsWith('nl:allow:')).length;
  const results=await original(commands);
  if(!lost&&commands.some(c=>c[0]==='INCRBY'&&String(c[1]).startsWith('nl:allow:'))){lost=true;throw Error('Synthetic committed allowance ACK loss');}
  return results;
 };
 try{
  const f=await createResendFallbackFixture({credential,cap:5,fetch:accepted});
  assert.equal(await sendEmail({...message,idempotencyKey:'synthetic-lost-allowance'},f.runtime),false);
  assert.equal(await allowanceUsed(owner,'email'),1);assert.equal(posts(f),0);assert.equal(refunds,0);assert.equal(f.held(),0);
 }finally{store.pipeline=original;}
});
test('uncertain HTTP keeps its existing allowance and account hold without an automatic resend',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:1,fetch:async()=>{throw Error('Synthetic possibly accepted HTTP reply lost');}});
 assert.equal(await sendEmail({...message,idempotencyKey:'synthetic-lost-http'},f.runtime),false);
 assert.equal(await sendEmail({...message,idempotencyKey:'synthetic-lost-http'},f.runtime),false);
 assert.equal(posts(f),1);assert.equal(await allowanceUsed(owner,'email'),1);assert.equal(f.held(),1);
});
test('shipment accepted receipt still runs its separate reconciliation barrier',async()=>{
 store.clear();const f=await createResendFallbackFixture({credential,cap:1,fetch:accepted});const sender=queuedShipmentMailSender(f.runtime);let barriers=0;
 const shipment={...message,replyTo:'owner@example.test'},context={id:'synthetic-shipment-receipt'};
 assert.equal(await sender(shipment,async()=>{barriers++;return true;},context),'accepted');
 assert.equal(await sender(shipment,async()=>{barriers++;return true;},context),'accepted');
 assert.equal(barriers,2);assert.equal(posts(f),1);
 assert.equal(await sender(shipment,async()=>{barriers++;return false;},context),'unknown');
 assert.equal(barriers,3);assert.equal(posts(f),1);
});
