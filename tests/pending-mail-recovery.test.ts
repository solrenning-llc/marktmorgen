import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueShipmentMail, runShipmentMail, shipmentMailPolicy, shipmentMailId, recoverPendingMail } from '@/lib/shipment-mail-outbox';
import { shipmentPolicy } from './shipment-mail-outbox-fixture';
import { physicalPaidFixture, originId, confirmationLocalPipeline } from './order-confirmation-paid-fixture';
import { createCheckout } from '@/lib/store-checkout';
import { readConfirmationOrigin, runOrderConfirmationMail, confirmationOriginRowKey } from '@/lib/order-confirmation-outbox';
import { COMMIT_ORDER_CONFIRMATION } from '@/lib/orders';

const now = 1_800_000_000_000;
const recovery = () => ({
 version: 1 as const, revision: 1, evidence: 'SYNTHETIC finite recovery; no actual funding',
 startsAt: now - 1000, until: now + 3_600_000,
 maximumAttempts: 100, maximumCommandUnits: 6400, maximumReadBytes: 104857600,
 checkpointBytes: 8192, maximumTriggerInvocations: 100,
 triggerEvidence: 'SYNTHETIC fixed trigger/function/failed-guard funding envelope',
});

test('an explicit finite recovery grant belongs to the same mail review', () => {
 const policy = { ...shipmentPolicy(now), recovery: recovery() };
 assert.ok(shipmentMailPolicy(policy, now, false), 'a valid bounded construction grant must be captured');
});

test('ordinary pending storage evidence never supplies recovery capacity', () => {
 const p = shipmentMailPolicy(shipmentPolicy(now), now, false);
 assert.ok(p);
 assert.equal(Object.hasOwn(p, 'recovery'), false);
});

test('recovery periods, finite budgets and own data are required before new IO', () => {
 for (const change of [
  { maximumAttempts: 0 }, { maximumAttempts: Infinity }, { maximumCommandUnits: 0 },
  { maximumReadBytes: 0 }, { checkpointBytes: 1 }, { startsAt: now + 1 }, { until: now },
  { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER }, { maximumTriggerInvocations: 0 }, { triggerEvidence: '' },
 ]) assert.equal(shipmentMailPolicy({ ...shipmentPolicy(now), recovery: { ...recovery(), ...change } }, now, false), null);
 let reads = 0;
 const executable = Object.defineProperty(recovery(), 'maximumAttempts', { get() { reads++; return 100; } });
 assert.equal(shipmentMailPolicy({ ...shipmentPolicy(now), recovery: executable }, now, false), null);
 assert.equal(reads, 0);
});

test('absent recovery funding and never-activated lifecycle add no IO', async () => {
 let calls = 0;
 const runtime = { pipeline: async () => { calls++; throw Error('No new IO allowed'); } };
 await recoverPendingMail('shipment', Date.now()+1000, runtime, async () => { throw Error('No source read'); });
 await recoverPendingMail('confirmation', Date.now()+1000, { ...runtime, lifecycle: 'active', policy: shipmentPolicy() }, async () => { throw Error('No source read'); });
 assert.equal(calls, 0);
});

test('normal physical workers recover original cap holds through real Lua and finite continued grants', {
 skip: process.env.MARKTMORGEN_REDIS_INTEGRATION !== '1' || !process.env.CONFIRMATION_ORIGIN_REDIS_PORT,
}, async () => {
 const pool = 'nl:ship:mail:pool', all = 'nl:ship:mail:all';
 const [priorPool,priorItems,priorBytes,priorCount,priorRecovery] = await confirmationLocalPipeline([
  ['HGETALL',pool],['HGET',pool,'items'],['HGET',pool,'bytes'],['SCARD',all],['HGET',pool,'pendingRecovery']]);
 assert.ok(Array.isArray(priorPool));assert.equal(priorCount,0);assert.equal(priorRecovery,null);
 assert.ok(priorItems===null||priorItems==='0');assert.ok(priorBytes===null||priorBytes==='0');
 const made = new Set<string>([pool,all]);
 const pipeline = async (commands:(string|number)[][]):Promise<unknown[]> => {
  for(const c of commands) {
   if(c[0] === 'EVAL') c.slice(3,3+Number(c[2])).forEach(k=>made.add(String(k)));
   else if(['SET','HSET','SADD','ZADD'].includes(String(c[0]))) made.add(String(c[1]));
  }
  return confirmationLocalPipeline(commands);
 };
 const realNow = Date.now;
 const grant = (revision:number) => ({ ...recovery(), revision, startsAt:realNow()-1000, until:realNow()+3600000 });
 try {
  const clock=realNow();let posts=0;
  const input={statsId:'recovery_physical_synthetic',session:'cs_test_recoveryShipment000001',authorizedAt:clock,
   shipped:{at:Math.floor(clock/1000),tracking:'https://example.test/track'},message:{from:'Store <mail@example.test>',to:'buyer@example.test',subject:'Original shipment',text:'Immutable original',replyTo:'owner@example.test'}};
  const old=shipmentPolicy(clock);
  const runtime={lifecycle:'active' as const,policy:{...old,maximumChecks:1},pipeline,now:()=>clock};
  assert.equal((await enqueueShipmentMail(input,runtime)).ok,true);
  assert.equal((await runShipmentMail(clock+30000,async()=> 'waiting',runtime)).waiting,1);
  const id=shipmentMailId(input.statsId,input.session),rk='nl:ship:mail:row:'+id;
  const [original,parked]=await pipeline([['GET',rk],['ZSCORE','nl:ship:mail:due',id]]);
  assert.equal(parked,'-1');assert.equal(JSON.parse(String(original)).checks,1);
  const successor={...old,reviewId:'SYNTHETIC_RECOVERY_FIRST',continuedReviewIds:[old.reviewId],maximumChecks:2,recovery:grant(1)};
  const renewed={...runtime,policy:successor};
  const sent=await runShipmentMail(clock+30000,async(message,barrier)=>{assert.equal(JSON.stringify(message),JSON.stringify(input.message));assert.equal(await barrier(),true);posts++;return 'accepted';},renewed);
  assert.equal(sent.accepted,1);assert.equal(posts,1);
  assert.equal((await pipeline([['GET',rk]]))[0],null);

  // Create the genuine original source73h in the past using the production
  // checkout with only its explicit fixture provider/ACK boundaries synthetic.
  let f:Awaited<ReturnType<typeof physicalPaidFixture>>,session:Record<string,unknown>,confirmationId:string;
  const descriptor=Object.getOwnPropertyDescriptor(Date,'now')!;
  try {
   Date.now=()=>clock-73*3600000;
   f=await physicalPaidFixture();
   const checkout=await createCheckout(f.store,f.product,'https://example.test',undefined,{},f.runtime);
   session=f.sessions.get(checkout.id)!;
   Object.assign(session,{status:'complete',payment_status:'paid',amount_total:4000,customer_details:{email:'buyer@example.test'},
    payment_intent:{object:'payment_intent',status:'succeeded',amount_received:4000,currency:'usd',latest_charge:{object:'charge',paid:true,amount:4000,amount_refunded:0,currency:'usd',refunded:false}},
    shipping_details:{name:'Original Buyer',address:{line1:'1 Original Street',city:'Test City',country:'US'}}});
   confirmationId=originId();
  }finally{Object.defineProperty(Date,'now',descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(Date,'now'),descriptor);}
  const source=await readConfirmationOrigin(confirmationId!,f!.runtime);assert.ok(source);
  const row=source.row;
  const keys=[confirmationOriginRowKey(confirmationId!),`nl:order-confirmation:source:${confirmationId!}`,'nl:order-confirmation:due',
   `nl:order-confirmation:store:${row.statsId}`,`nl:order-confirmation:person:${row.statsId}:${row.person}`,pool,`nl:ship:mail:pool:${row.statsId}`,all,
   `nl:order-confirmation:closed:${row.statsId}`,`nl:order-confirmation:erased:${row.statsId}:${row.person}`];
  keys.forEach(k=>made.add(k));
  await pipeline([['SET',keys[0],source.raw],['SET',keys[1],row.sourceValue],['ZADD',keys[2],row.next,row.id],
   ...[3,4,7].map(i=>['SADD',keys[i],row.id]),['HSET',pool,'items',1,'bytes',row.bytes],['HSET',keys[6],'items',1,'bytes',row.bytes]]);
  let settled=false;
  const physical={...f!.runtime,now:realNow,policy:{...f!.runtime.policy!,maximumChecks:1},pipeline:async(commands:(string|number)[][])=>{
   for(const c of commands)if(c[0]==='EVAL'&&c[1]===COMMIT_ORDER_CONFIRMATION&&!settled){settled=true;
    c.slice(3,9).forEach(k=>made.add(String(k)));
    await pipeline([['HSET',String(c[5]),String(c[10]),2],['HSET',String(c[6]),String(c[10]),2*Number(c[11])]]);}
   return pipeline(commands);
  }};
  assert.equal((await runOrderConfirmationMail(realNow()+30000,async()=> 'waiting',physical)).waiting,1);
  const preserved=await readConfirmationOrigin(confirmationId!,physical);assert.ok(preserved?.payload.message);
  assert.equal(preserved.row.checks,1);assert.equal(preserved.row.next,0);
  const newPolicy={...physical.policy,reviewId:'SYNTHETIC_RECOVERY_SECOND',continuedReviewIds:[physical.policy.reviewId],maximumChecks:3,recovery:grant(2)};
  const resumed={...physical,policy:newPolicy};
  // Both normal workers run on the same cron; shipment's acknowledged missing
  // family position advances before the confirmation pass can consume it.
  let physicalPosts=0,accepted=0;
  // This new source was already present when the funded review renewed the
  // older active list. The SAME review must finish that list and capture one
  // fresh snapshot, using only its remaining finite discovery budget.
  for(let pass=0;pass<4;pass++){
   const results=await Promise.all([
    runShipmentMail(realNow()+30000,async()=>{throw Error('No shipment remains');},resumed),
    runOrderConfirmationMail(realNow()+30000,async(message,barrier)=>{
     assert.equal(JSON.stringify(message),JSON.stringify(preserved.payload.message));assert.equal(await barrier(),true);physicalPosts++;return 'accepted';
    },resumed),
   ]);
   accepted+=results[1].accepted;
  }
  assert.equal(accepted,1);assert.equal(physicalPosts,1);
  const [finishedSnapshot]=await pipeline([['HGET',pool,'pendingRecovery']]);
  assert.equal(JSON.parse(String(finishedSnapshot)).phase,'done','the funded refresh is performed only once');
  assert.equal(f!.calls.filter(c=>c.method==='POST').length,1,'only the original synthetic checkout POST');
 }finally{
  await confirmationLocalPipeline([['DEL',...made]]);
  if(priorPool.length) await confirmationLocalPipeline([['HSET',pool,...priorPool.map(String)]]);
 }
});

/** Each opt-in owns only its captured keys, never a database-wide reset. */
async function isolatedRecoveryProof(body:(pipeline:typeof confirmationLocalPipeline,pool:string,all:string)=>Promise<void>) {
 const pool='nl:ship:mail:pool',all='nl:ship:mail:all';
 const [prior,items,bytes,count]=await confirmationLocalPipeline([['HGETALL',pool],['HGET',pool,'items'],['HGET',pool,'bytes'],['SCARD',all]]);
 assert.ok(Array.isArray(prior));assert.equal(count,0);assert.ok(items===null||items==='0');assert.ok(bytes===null||bytes==='0');
 const made=new Set([pool,all]);
 const pipeline:typeof confirmationLocalPipeline=async commands=>{
  for(const c of commands){if(c[0]==='EVAL')c.slice(3,3+Number(c[2])).forEach(k=>made.add(String(k)));else if(['SET','HSET','SADD','ZADD'].includes(String(c[0])))made.add(String(c[1]));}
  return confirmationLocalPipeline(commands);
 };
 try {await body(pipeline,pool,all);}finally{await confirmationLocalPipeline([['DEL',...made]]);if(prior.length)await confirmationLocalPipeline([['HSET',pool,...prior.map(String)]]);}
}
const redisOptIn=process.env.MARKTMORGEN_REDIS_INTEGRATION!=='1'||!process.env.CONFIRMATION_ORIGIN_REDIS_PORT;

test('expired preparation with a historical index hole cannot hide later original shipment mail', {skip:redisOptIn}, async()=>{
 await isolatedRecoveryProof(async(pipeline,pool)=>{
  const clock=Date.now,old=shipmentPolicy();
  const runtime={lifecycle:'active' as const,policy:{...old,maximumChecks:1},pipeline,now:clock};
  const ids:string[]=[];
  for(const tag of ['one','two']){
   const input={statsId:'review_recovery_original',session:'cs_test_reviewRecovery00000'+tag,authorizedAt:clock(),
    shipped:{at:Math.floor(clock()/1000),tracking:'https://example.test/track'},message:{from:'Store <mail@example.test>',to:'buyer@example.test',subject:'Original '+tag,text:'Immutable '+tag,replyTo:'owner@example.test'}};
   assert.equal((await enqueueShipmentMail(input,runtime)).ok,true);ids.push(shipmentMailId(input.statsId,input.session));
  }
  ids.sort();
  // Model a stopped preparation and a historical index hole after genuine
  // enqueue/sealing. The selected message/fingerprint/source never changes.
  for(const [i,id]of ids.entries()){
   const key='nl:ship:mail:row:'+id,[raw]=await pipeline([['GET',key]]),row=JSON.parse(String(raw));
   Object.assign(row,{state:i===0?'preparing':'queued',owner:i===0?'e'.repeat(48):'',leaseUntil:i===0?clock()-1000:0,next:i===0?clock()-1000:0,checks:1});
   await pipeline([['SET',key,JSON.stringify(row)],['ZREM','nl:ship:mail:due',id]]);
  }
  const renewed={...runtime,policy:{...old,reviewId:'SYNTHETIC_REVIEW_PREPARATION',continuedReviewIds:[old.reviewId],maximumChecks:2,
   recovery:{...recovery(),startsAt:clock()-1000,until:clock()+3600000}}};
  assert.equal((await runShipmentMail(clock()+30000,async()=> 'waiting',renewed)).waiting,1,'the expired preparation must rejoin its normal bounded claim');
  const [cursor]=await pipeline([['HGET',pool,'pendingRecovery']]);assert.equal(JSON.parse(String(cursor)).index,2,'the later snapshot position is reachable');
  let sends=0;
  const result=await runShipmentMail(clock()+30000,async(message,beforePost)=>{assert.match(message.subject,/^Original /);assert.equal(await beforePost(),true);sends++;return 'accepted';},renewed);
  assert.equal(result.accepted,1);assert.equal(sends,1);assert.equal((await pipeline([['GET','nl:ship:mail:row:'+ids[1]]]))[0],null);
 });
});

test('a genuine lost creation ACK after73h is recovered by normal workers without another checkout POST', {skip:redisOptIn}, async()=>{
 await isolatedRecoveryProof(async(pipeline,pool,all)=>{
  const clock=Date.now,started=clock(),descriptor=Object.getOwnPropertyDescriptor(Date,'now')!;
  let f!:Awaited<ReturnType<typeof physicalPaidFixture>>;
  try{
   Date.now=()=>started-73*3600000;f=await physicalPaidFixture();const original=f.runtime.provider!;
   f.runtime.provider=async(...args)=>{const response=await original(...args);if(args[0]==='POST')throw Error('Synthetic lost original creation ACK');if(args[2].split('?')[0]==='/checkout/sessions')return {object:'list',has_more:false,data:[]};return response;};
   await assert.rejects(()=>createCheckout(f.store,f.product,'https://example.test',undefined,{},f.runtime));
  }finally{Object.defineProperty(Date,'now',descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(Date,'now'),descriptor);}
  const id=originId(),source=await readConfirmationOrigin(id,f.runtime);assert.ok(source&&!source.row.session);
  const row=source.row,keys=[confirmationOriginRowKey(id),`nl:order-confirmation:source:${id}`,'nl:order-confirmation:due',
   `nl:order-confirmation:store:${row.statsId}`,`nl:order-confirmation:person:${row.statsId}:${row.person}`,pool,`nl:ship:mail:pool:${row.statsId}`,all];
  await pipeline([['SET',keys[0],source.raw],['SET',keys[1],row.sourceValue],['ZADD',keys[2],row.next,id],
   ...[3,4,7].map(i=>['SADD',keys[i],id]),['HSET',pool,'items',1,'bytes',row.bytes],['HSET',keys[6],'items',1,'bytes',row.bytes]]);
  let available=false;const original=f.runtime.provider!;
  const runtime={...f.runtime,pipeline,now:clock,policy:{...f.runtime.policy!,maximumChecks:1},provider:async(...args:Parameters<typeof original>)=>{
   if(args[0]==='POST')throw Error('Recovery must never create another checkout');
   if(args[2].split('?')[0]==='/checkout/sessions'&&available)return {object:'list',has_more:false,data:[...f.sessions.values()]};
   return original(...args);
  }};
  assert.equal((await runOrderConfirmationMail(clock()+30000,async()=>{throw Error('No paid email');},runtime)).waiting,1);
  const held=await readConfirmationOrigin(id,runtime);assert.ok(held);assert.equal(held.row.phase,'creation_unknown');assert.equal(held.row.checks,1);assert.equal(held.row.next,0);
  available=true;
  const renewed={...runtime,policy:{...runtime.policy,reviewId:'SYNTHETIC_REVIEW_CREATION_ACK',continuedReviewIds:[runtime.policy.reviewId],maximumChecks:2,
   recovery:{...recovery(),startsAt:clock()-1000,until:clock()+3600000}}};
  await runShipmentMail(clock()+30000,async()=>{throw Error('No shipment');},renewed);
  assert.equal((await runOrderConfirmationMail(clock()+30000,async()=>{throw Error('No paid email');},renewed)).waiting,1);
  const found=await readConfirmationOrigin(id,renewed);assert.ok(found?.row.session,'the ordinary worker must bind the original recovered session');
  assert.equal(found.row.bodyDigest,held.row.bodyDigest);assert.equal(found.row.intentFingerprint,held.row.intentFingerprint);assert.equal(found.row.created,held.row.created);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1,'only the original synthetic creation POST');
 });
});

test('newly funded discovery at cap10000 recovers a lost ticket without resetting9999 original checks', {skip:redisOptIn}, async()=>{
 await isolatedRecoveryProof(async(pipeline,pool)=>{
  const clock=Date.now,old=shipmentPolicy();
  const input={statsId:'same_cap_original',session:'cs_test_sameCapOriginal0000001',authorizedAt:clock(),
   shipped:{at:Math.floor(clock()/1000),tracking:'https://example.test/track'},message:{from:'Store <mail@example.test>',to:'buyer@example.test',subject:'Original capped shipment',text:'Original selected text',replyTo:'owner@example.test'}};
  const original={lifecycle:'active' as const,policy:{...old,maximumChecks:10000},pipeline,now:clock};
  assert.equal((await enqueueShipmentMail(input,original)).ok,true);
  const id=shipmentMailId(input.statsId,input.session),key='nl:ship:mail:row:'+id,[stored]=await pipeline([['GET',key]]),row=JSON.parse(String(stored));
  // Model9999 previously funded checks and a historical DUE hole; the
  // authentic encrypted payload/source/identity and captured time stay exact.
  Object.assign(row,{checks:9999,next:0});const held=JSON.stringify(row);
  await pipeline([['SET',key,held],['ZREM','nl:ship:mail:due',id]]);
  let lose=true;
  const oneAttempt={...original,policy:{...old,reviewId:'SYNTHETIC_DISCOVERY_ONE',continuedReviewIds:[old.reviewId],maximumChecks:10000,
   recovery:{...recovery(),startsAt:clock()-1000,until:clock()+3600000,maximumAttempts:1,maximumCommandUnits:64,maximumReadBytes:1048576,maximumTriggerInvocations:1}},
   pipeline:async(commands:(string|number)[][])=>{const reply=await pipeline(commands);if(lose&&commands.some(c=>c[0]==='EVAL'&&String(c[1]).includes('marktmorgen:pending-mail-recovery:v1')&&c[5]==='next')){lose=false;throw Error('Synthetic lost recovery ticket ACK');}return reply;}};
  await runShipmentMail(clock()+30000,async()=>{throw Error('The unknown ticket cannot send');},oneAttempt);
  await runShipmentMail(clock()+30000,async()=>{throw Error('The exhausted grant cannot send');},oneAttempt);
  const [checkpoint,unchanged]=await pipeline([['HGET',pool,'pendingRecovery'],['GET',key]]);
  const spent=JSON.parse(String(checkpoint));assert.equal(spent.attempts,1);assert.equal(spent.units,64);assert.equal(spent.readBytes,1048576);assert.equal(unchanged,held);
  const successor={...original,policy:{...old,reviewId:'SYNTHETIC_DISCOVERY_TWO',continuedReviewIds:[old.reviewId],maximumChecks:10000,
   recovery:{...recovery(),revision:2,startsAt:clock()-1000,until:clock()+3600000}}};
  let posts=0;
  const outcome=await runShipmentMail(clock()+30000,async(message,beforePost)=>{
   assert.equal(JSON.stringify(message),JSON.stringify(input.message));
   const [current]=await pipeline([['GET',key]]),claimed=JSON.parse(String(current));
   assert.equal(claimed.checks,10000);assert.equal(claimed.created,row.created);assert.equal(claimed.fingerprint,row.fingerprint);assert.equal(claimed.sourceValue,row.sourceValue);
   assert.equal(await beforePost(),true);posts++;return 'accepted';
  },successor);
  assert.equal(outcome.accepted,1);assert.equal(posts,1);assert.equal((await pipeline([['GET',key]]))[0],null);
 });
});

test('recovery descriptors preserve the original closing fallback for unknown suffixes', async()=>{
 const {closingFamilyOf,closingOf,countedInRoom}=await import('@/lib/data-families');
 for(const key of ['nl:order-confirmation:','nl:order-confirmation:unregistered:synthetic','nl:ship:mail:','nl:ship:mail:unregistered:synthetic']){
  assert.equal(closingFamilyOf(key),'nl:','an undeclared suffix must retain its original fallback');
  assert.deepEqual(closingOf(key),{how:'erase'});assert.equal(countedInRoom(key),false);
 }
 for(const prefix of ['nl:order-confirmation:row:','nl:order-confirmation:source:','nl:order-confirmation:closed:','nl:order-confirmation:erased:',
  'nl:ship:mail:row:','nl:ship:mail:closed:','nl:ship:mail:erased:','nl:ship:mail:pool:']){
  const key=prefix+'SyntheticStableId1234567890';assert.equal(closingFamilyOf(key),prefix);assert.deepEqual(closingOf(key),{how:'company'});assert.equal(countedInRoom(key),false);
 }
});

test('small funded successor grants compose both normal workers through an unsupported prefix to the original paid confirmation', {skip:redisOptIn}, async()=>{
 await isolatedRecoveryProof(async(pipeline,pool,all)=>{
  const clock=Date.now,started=clock(),descriptor=Object.getOwnPropertyDescriptor(Date,'now')!;
  let f!:Awaited<ReturnType<typeof physicalPaidFixture>>,id!:string;
  try{
   Date.now=()=>started-73*3600000;
   f=await physicalPaidFixture();
   const checkout=await createCheckout(f.store,f.product,'https://example.test',undefined,{},f.runtime);
   const session=f.sessions.get(checkout.id)!;
   Object.assign(session,{status:'complete',payment_status:'paid',amount_total:4000,customer_details:{email:'buyer@example.test'},
    payment_intent:{object:'payment_intent',status:'succeeded',amount_received:4000,currency:'usd',latest_charge:{object:'charge',paid:true,amount:4000,amount_refunded:0,currency:'usd',refunded:false}},
    shipping_details:{name:'Original Buyer',address:{line1:'1 Original Street',city:'Test City',country:'US'}}});
   id=originId();
  }finally{Object.defineProperty(Date,'now',descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(Date,'now'),descriptor);}
  const found=await readConfirmationOrigin(id,f.runtime);assert.ok(found);
  const row=found.row,keys=[confirmationOriginRowKey(id),`nl:order-confirmation:source:${id}`,'nl:order-confirmation:due',
   `nl:order-confirmation:store:${row.statsId}`,`nl:order-confirmation:person:${row.statsId}:${row.person}`,pool,`nl:ship:mail:pool:${row.statsId}`,all,
   `nl:order-confirmation:closed:${row.statsId}`,`nl:order-confirmation:erased:${row.statsId}:${row.person}`];
  await pipeline([['SET',keys[0],found.raw],['SET',keys[1],row.sourceValue],['ZADD',keys[2],row.next,id],
   ...[3,4,7].map(i=>['SADD',keys[i],id]),['HSET',pool,'items',1,'bytes',row.bytes],['HSET',keys[6],'items',1,'bytes',row.bytes]]);
  let settled=false;
  const physical={...f.runtime,now:clock,policy:{...f.runtime.policy!,maximumChecks:1},pipeline:async(commands:(string|number)[][])=>{
   for(const c of commands)if(c[0]==='EVAL'&&c[1]===COMMIT_ORDER_CONFIRMATION&&!settled){settled=true;
    await pipeline([['HSET',String(c[5]),String(c[10]),2],['HSET',String(c[6]),String(c[10]),2*Number(c[11])]]);}
   return pipeline(commands);
  }};
  assert.equal((await runOrderConfirmationMail(clock()+30000,async()=> 'waiting',physical,id)).waiting,1);
  const original=await readConfirmationOrigin(id,physical);assert.ok(original?.payload.message);assert.equal(original.row.checks,1);
  const unsupported={...shipmentPolicy(),reviewId:'SYNTHETIC_UNCOVERED_STAYS',maximumChecks:1};
  let session='';
  for(let i=0;i<1000;i++){const candidate='cs_test_uncoveredPrefix00000'+i;if(shipmentMailId('continuation_uncovered',candidate)<id){session=candidate;break;}}
  assert.notEqual(session,'','the deterministic unsupported source must precede the original confirmation');
  const input={statsId:'continuation_uncovered',session,authorizedAt:clock(),shipped:{at:Math.floor(clock()/1000),tracking:'https://example.test/track'},
   message:{from:'Store <mail@example.test>',to:'other@example.test',subject:'Uncovered original',text:'Do not send under another review',replyTo:'owner@example.test'}};
  const unsupportedRuntime={lifecycle:'active' as const,policy:unsupported,pipeline,now:clock};
  assert.equal((await enqueueShipmentMail(input,unsupportedRuntime)).ok,true);
  const firstId=shipmentMailId(input.statsId,input.session);
  assert.equal((await runShipmentMail(clock()+30000,async()=> 'waiting',unsupportedRuntime,firstId)).waiting,1);
  const [firstRaw]=await pipeline([['GET','nl:ship:mail:row:'+firstId]]);
  let accepted=0,passes=0;const observed:{ids:string[];index:number;family:string;phase:string;attempts:number;units:number;readBytes:number}[]=[];
  for(let revision=1;revision<=6;revision++){
   const policy={...physical.policy,reviewId:'SYNTHETIC_PROGRESS_'+revision,continuedReviewIds:[physical.policy.reviewId],maximumChecks:2,
    recovery:{...recovery(),revision,startsAt:started-1000,until:started+3600000,maximumAttempts:1,maximumCommandUnits:640,maximumReadBytes:10485760,maximumTriggerInvocations:10}};
   const renewed={...physical,policy};
   const results=await Promise.all([
    runShipmentMail(clock()+30000,async()=>{throw Error('Unsupported shipping review must never send');},renewed),
    runOrderConfirmationMail(clock()+30000,async(message,beforePost)=>{
     assert.equal(JSON.stringify(message),JSON.stringify(original.payload.message));
     const current=await readConfirmationOrigin(id,renewed);assert.ok(current);
     assert.equal(current.row.created,original.row.created);assert.equal(current.row.intentFingerprint,original.row.intentFingerprint);
     assert.equal(current.row.checks,2,'only the ordinary claim consumes the remaining provider check');
     assert.equal(await beforePost(),true);accepted++;return 'accepted';
    },renewed),
   ]);
   assert.equal(results[0].accepted,0);
   const [checkpoint]=await pipeline([['HGET',pool,'pendingRecovery']]);const progress=JSON.parse(String(checkpoint));observed.push(progress);passes++;
   assert.ok(progress.attempts<=1);assert.equal(progress.units,progress.attempts*64);assert.equal(progress.readBytes,progress.attempts*1048576);
   if(progress.phase==='done')break;
  }
  assert.equal(accepted,1,'finite newly funded small grants must reach and send the original paid confirmation');
  assert.ok(passes<=6);assert.equal(observed.at(-1)!.phase,'done');
  for(const checkpoint of observed.slice(0,-1))assert.deepEqual(checkpoint.ids,[firstId,id],'snapshot IDs remain original, even after row membership changes');
  assert.equal((await pipeline([['GET','nl:ship:mail:row:'+firstId]]))[0],firstRaw,'unsupported source remains intact');
  assert.equal((await pipeline([['GET',keys[0]]]))[0],null);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1,'only the original checkout was created');
 });
});
