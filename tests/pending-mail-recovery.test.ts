import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueShipmentMail, runShipmentMail, shipmentMailPolicy, shipmentMailId, recoverPendingMail } from '@/lib/shipment-mail-outbox';
import { shipmentPolicy } from './shipment-mail-outbox-fixture';
import { physicalPaidFixture, originId, confirmationLocalPipeline } from './order-confirmation-paid-fixture';
import { createCheckout } from '@/lib/store-checkout';
import { readConfirmationOrigin, runOrderConfirmationMail, confirmationOriginRowKey } from '@/lib/order-confirmation-outbox';
import { COMMIT_ORDER_CONFIRMATION } from '@/lib/orders';
import {createLocalRedisPool} from './redis-connection-pool';

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

test('explicit recovery origin coverage admits a bounded hundred without changing legacy encoding', () => {
 const legacy={...shipmentPolicy(now),recovery:recovery()};
 const captured=shipmentMailPolicy(legacy,now,false);assert.ok(captured?.recovery);
 assert.equal(Object.hasOwn(captured.recovery,'maximumOrigins'),false);
 assert.equal(JSON.stringify(captured.recovery),JSON.stringify(recovery()),'the legacy grant bytes remain identical');
 const larger=shipmentMailPolicy({...legacy,recovery:{...recovery(),maximumOrigins:100}},now,false);
 assert.ok(larger?.recovery,'explicitly financed100-origin capacity must be captured');
 assert.equal(Object.getOwnPropertyDescriptor(larger.recovery,'maximumOrigins')?.value,100);
});

test('paged recovery requires explicit total checkpoint capacity for a thousand origins', () => {
 const legacy={...shipmentPolicy(now),recovery:recovery()};
 for(const maximumOrigins of [101,1000]){
  const grant={...recovery(),maximumOrigins,checkpointTotalBytes:100000};
  const captured=shipmentMailPolicy({...legacy,recovery:grant},now,false);
  assert.ok(captured?.recovery,'an explicitly bounded paged grant must be captured');
  assert.equal(JSON.stringify(captured.recovery),JSON.stringify(grant));
 }
 for(const change of [{maximumOrigins:1001,checkpointTotalBytes:100000},{maximumOrigins:1000},
  {maximumOrigins:1000,checkpointTotalBytes:90431},{maximumOrigins:1000,checkpointTotalBytes:100001},
  {maximumOrigins:100,checkpointTotalBytes:100000},{maximumOrigins:1000,checkpointTotalBytes:undefined}])
  assert.equal(shipmentMailPolicy({...legacy,recovery:{...recovery(),...change}},now,false),null);
});

test('paged capacity and ticket corruption refuse before source observation', async()=>{
 const policy={...shipmentPolicy(now),recovery:{...recovery(),maximumOrigins:1000,checkpointTotalBytes:100000}};
 let reads=0,calls=0;
 for(const value of [
  Object.assign(Object.create({checkpointTotalBytes:100000}),{...recovery(),maximumOrigins:1000}),
  Object.defineProperty({...recovery(),maximumOrigins:1000},'checkpointTotalBytes',{get(){reads++;return 100000;}}),
  {...recovery(),maximumOrigins:1000,checkpointTotalBytes:NaN},
 ]){
  assert.equal(shipmentMailPolicy({...policy,recovery:value},now,false),null);
  await recoverPendingMail('shipment',now+1000,{lifecycle:'active',policy:{...policy,recovery:value} as typeof policy,now:()=>now,
   pipeline:async()=>{calls++;return [['done']];}},async()=>{reads++;return null;});
 }
 assert.equal(reads,0);assert.equal(calls,0);
 const page=JSON.stringify(['a'.repeat(64)]),{createHash}=await import('node:crypto');
 const checksum=createHash('sha1').update(page).digest('hex');
 for(const metadata of [
  {index:1,page,checksum:'f'.repeat(40),snapshot:'b'.repeat(40)},
  {index:1,page:'x'.repeat(8193),checksum,snapshot:'b'.repeat(40)},
  {index:1,page,checksum,snapshot:'bad'},
  {index:1001,page,checksum,snapshot:'b'.repeat(40)},
  {index:1,page,checksum,snapshot:'b'.repeat(40),extra:true},
 ]){
  let commands=0;
  await recoverPendingMail('shipment',now+1000,{lifecycle:'active',policy,now:()=>now,
   pipeline:async()=>{commands++;return [['ticket','a'.repeat(64),JSON.stringify(metadata)]];}},async()=>{reads++;return null;});
  assert.equal(commands,1);
 }
 assert.equal(reads,0);
});

test('the omitted origin cap preserves the published grant JSON and fingerprint', async () => {
 let captured:unknown[]|undefined;
 await recoverPendingMail('shipment',now+1000,{lifecycle:'active',policy:{...shipmentPolicy(now),recovery:recovery()},now:()=>now,
  pipeline:async commands=>{captured=commands[0];return [['done']];}},async()=>{throw Error('No source read');});
 assert.ok(captured);
 // Captured from the published d489426d implementation, before this option existed.
 const legacy='{"recovery":{"version":1,"revision":1,"evidence":"SYNTHETIC finite recovery; no actual funding","startsAt":1799999999000,"until":1800003600000,"maximumAttempts":100,"maximumCommandUnits":6400,"maximumReadBytes":104857600,"checkpointBytes":8192,"maximumTriggerInvocations":100,"triggerEvidence":"SYNTHETIC fixed trigger/function/failed-guard funding envelope"},"reviewId":"SYNTHETIC_SHIPMENT_ONLY","maximumChecks":100,"globalItems":100,"globalBytes":10000000,"continuedReviewIds":[]}';
 assert.equal(captured[6],legacy);
 assert.equal(captured[7],'dbc958ec0094658edb189ac5fa777e545200966b67970dd29f773216c499f192');
});

test('extra origin capacity requires explicit bounded own data and checkpoint funding before IO', async () => {
 let calls=0,reads=0;
 const bad:unknown[]=[...[-1,0,101,1.5,Infinity,'100',false,null,undefined].map(maximumOrigins=>({...recovery(),maximumOrigins})),
  {...recovery(),maximumOrigins:100,checkpointBytes:4096},
  {...recovery(),maximumOrigins:26,checkpointBytes:8191},
  {...recovery(),maximumOrigins:100,unreviewed:true},
  Object.assign(Object.create({maximumOrigins:100}),recovery()),
  Object.defineProperty(recovery(),'maximumOrigins',{get(){reads++;return 100;}})];
 for(const value of bad){
  const policy={...shipmentPolicy(now),recovery:value};
  assert.equal(shipmentMailPolicy(policy,now,false),null);
  await recoverPendingMail('shipment',now+1000,{lifecycle:'active',policy:policy as Parameters<typeof recoverPendingMail>[2]['policy'],now:()=>now,
   pipeline:async()=>{calls++;throw Error('Invalid funding must refuse before IO');}},async()=>{throw Error('No source read');});
 }
 for(const maximumOrigins of [1,25,26,100])assert.ok(shipmentMailPolicy({...shipmentPolicy(now),recovery:{...recovery(),maximumOrigins}},now,false));
 assert.ok(shipmentMailPolicy({...shipmentPolicy(now),recovery:{...recovery(),maximumOrigins:25,checkpointBytes:4096}},now,false));
 const prior=Object.getOwnPropertyDescriptor(Object.prototype,'maximumOrigins');
 try{
  Object.defineProperty(Object.prototype,'maximumOrigins',{get(){reads++;return 100;},configurable:true});
  assert.equal(shipmentMailPolicy({...shipmentPolicy(now),recovery:recovery()},now,false),null);
 }finally{if(prior)Object.defineProperty(Object.prototype,'maximumOrigins',prior);else Reflect.deleteProperty(Object.prototype,'maximumOrigins');}
 assert.equal(calls,0);assert.equal(reads,0);
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
 const local=createLocalRedisPool();
 try{
 const pool='nl:ship:mail:pool',all='nl:ship:mail:all';
 const [prior,items,bytes,count]=await local.pipeline([['HGETALL',pool],['HGET',pool,'items'],['HGET',pool,'bytes'],['SCARD',all]]);
 assert.ok(Array.isArray(prior));assert.equal(count,0);assert.ok(items===null||items==='0');assert.ok(bytes===null||bytes==='0');
 const made=new Set([pool,all]);
 const pipeline:typeof confirmationLocalPipeline=async commands=>{
  for(const c of commands){if(c[0]==='EVAL')c.slice(3,3+Number(c[2])).forEach(k=>made.add(String(k)));else if(['SET','HSET','SADD','ZADD'].includes(String(c[0])))made.add(String(c[1]));}
  return local.pipeline(commands);
 };
 // Cleanup uses its own connection even if the proof's scoped transport has
 // failed closed; this never replays any of the proof's uncertain commands.
 try {await body(pipeline,pool,all);}finally{await confirmationLocalPipeline([['DEL',...made]]);if(prior.length)await confirmationLocalPipeline([['HSET',pool,...prior.map(String)]]);}
 }finally{local.close();}
}
const redisOptIn=process.env.MARKTMORGEN_REDIS_INTEGRATION!=='1'||!process.env.CONFIRMATION_ORIGIN_REDIS_PORT;

for (const first of ['shipment','confirmation'] as const) test(`both normal workers complete an explicitly funded hundred-origin snapshot with each original message once (${first} first)`, {skip:redisOptIn}, async()=>{
 await isolatedRecoveryProof(async(pipeline,pool,all)=>{
  const clock=Date.now(),old={...shipmentPolicy(clock),maximumChecks:1};
  const runtime={lifecycle:'active' as const,policy:old,pipeline,now:()=>clock};
  const originals=new Map<string,{source:string;message:{from:string;to:string;subject:string;text:string;replyTo:string}}>();
  for(let i=0;i<100;i++){
   const session='cs_test_HundredRecovery'+String(i).padStart(4,'0');
   const input={statsId:'synthetic_hundred_recovery',session,authorizedAt:clock,
    shipped:{at:Math.floor(clock/1000),tracking:'https://example.test/track/'+i},
    message:{from:'Store <mail@example.test>',to:'buyer@example.test',subject:'Original '+i,text:'Original immutable message '+i,replyTo:'owner@example.test'}};
   assert.equal((await enqueueShipmentMail(input,runtime)).ok,true);
   const id=shipmentMailId(input.statsId,session);
   assert.equal((await runShipmentMail(clock+30000,async()=> 'waiting',runtime,id)).waiting,1);
   const [raw,source,score]=await pipeline([['GET','nl:ship:mail:row:'+id],['GET','nl:ship:done:'+session],['ZSCORE','nl:ship:mail:due',id]]);
   assert.equal(JSON.parse(String(raw)).checks,1);assert.equal(score,'-1');assert.equal(typeof source,'string');
   originals.set(session,{source:String(source),message:input.message});
  }
  assert.equal((await pipeline([['SCARD',all]]))[0],100);
  const renewed={...runtime,policy:{...old,reviewId:'SYNTHETIC_HUNDRED_RENEWED',continuedReviewIds:[old.reviewId],maximumChecks:2,
   recovery:{...recovery(),startsAt:clock-1000,until:clock+3600000,maximumOrigins:100,
    maximumAttempts:1000,maximumCommandUnits:64000,maximumReadBytes:1048576000,maximumTriggerInvocations:1000}}};
  if(first==='confirmation'){
   // Real Redis may receive this worker first even when Promise.all lists
   // shipment first. It must wait for the capture's shipment-family turn.
   await runOrderConfirmationMail(clock+30000,async()=>{throw Error('There is no confirmation source');},renewed);
   const [raw]=await pipeline([['HGET',pool,'pendingRecovery']]);
   const held=JSON.parse(String(raw));
   assert.equal(held.phase,'capturing');assert.equal(held.attempts,0);
   assert.equal(held.units,0);assert.equal(held.readBytes,0);
   assert.equal(held.owner,'');assert.equal(held.leaseUntil,0);
   assert.equal((await pipeline([['SCARD',all]]))[0],100);
  }
  const sent=new Set<string>();let accepted=0,complete:Record<string,unknown>|undefined;
  for(let pass=0;pass<250;pass++){
   const results=await Promise.all([
    runShipmentMail(clock+30000,async(message,barrier)=>{
     const original=[...originals.values()].find(value=>value.message.subject===message.subject);
     assert.ok(original);assert.equal(JSON.stringify(message),JSON.stringify(original.message));
     assert.equal(sent.has(message.subject),false);assert.equal(await barrier(),true);sent.add(message.subject);return 'accepted';
    },renewed),
    runOrderConfirmationMail(clock+30000,async()=>{throw Error('There is no confirmation source');},renewed),
   ]);
   accepted+=results[0].accepted;
   const [raw]=await pipeline([['HGET',pool,'pendingRecovery']]);complete=JSON.parse(String(raw));
   if(complete?.phase==='done')break;
  }
  assert.equal(complete?.phase,'done');assert.equal(complete?.attempts,200);
  assert.equal(complete?.units,12800);assert.equal(complete?.readBytes,209715200);
  assert.equal(accepted,100);assert.equal(sent.size,100);assert.equal((await pipeline([['SCARD',all]]))[0],0);
  for(const [session,original] of originals){
   assert.equal((await pipeline([['GET','nl:ship:done:'+session]]))[0],original.source);
   assert.equal((await pipeline([['GET','nl:ship:mail:row:'+shipmentMailId('synthetic_hundred_recovery',session)]]))[0],null);
  }
 });
});

for (const count of [101,1000]) test(`both normal workers recover ${count} genuine mixed origins through paged funded grants`, {skip:redisOptIn}, async()=>{
 await isolatedRecoveryProof(async(pipeline,pool,all)=>{
  const clock=Date.now(),now=Date.now;
  const old={...shipmentPolicy(clock),maximumChecks:1,globalItems:1000,storeItems:1000,globalBytes:100000000,storeBytes:100000000};
  const runtime={lifecycle:'active' as const,policy:old,pipeline,now};
  // Capture one genuine original paid-checkout source through the existing
  // explicit fixture provider; copy its exact encrypted bytes into owned Redis.
  let f!:Awaited<ReturnType<typeof physicalPaidFixture>>;
  const descriptor=Object.getOwnPropertyDescriptor(Date,'now')!;
  try {
  Date.now=()=>clock-73*3600000;
  f=await physicalPaidFixture();
  const checkout=await createCheckout(f.store,f.product,'https://example.test',undefined,{},f.runtime);
  const session=f.sessions.get(checkout.id)!;
  Object.assign(session,{status:'complete',payment_status:'paid',amount_total:4000,customer_details:{email:'buyer@example.test'},
   payment_intent:{object:'payment_intent',status:'succeeded',amount_received:4000,currency:'usd',latest_charge:{object:'charge',paid:true,amount:4000,amount_refunded:0,currency:'usd',refunded:false}},
   shipping_details:{name:'Original Buyer',address:{line1:'1 Original Street',city:'Test City',country:'US'}}});
  }finally{Object.defineProperty(Date,'now',descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(Date,'now'),descriptor);}
  const confirmationId=originId(),source=await readConfirmationOrigin(confirmationId,f.runtime);assert.ok(source);
  const row=source.row,keys=[confirmationOriginRowKey(confirmationId),`nl:order-confirmation:source:${confirmationId}`,'nl:order-confirmation:due',
   `nl:order-confirmation:store:${row.statsId}`,`nl:order-confirmation:person:${row.statsId}:${row.person}`,pool,`nl:ship:mail:pool:${row.statsId}`,all,
   `nl:order-confirmation:closed:${row.statsId}`,`nl:order-confirmation:erased:${row.statsId}:${row.person}`];
  await pipeline([['SET',keys[0],source.raw],['SET',keys[1],row.sourceValue],['ZADD',keys[2],row.next,row.id],
   ...[3,4,7].map(i=>['SADD',keys[i],row.id]),['HSET',pool,'items',1,'bytes',row.bytes],['HSET',keys[6],'items',1,'bytes',row.bytes]]);
  let settled=false;
  const physical={...f.runtime,now,policy:{...f.runtime.policy!,maximumChecks:1,globalItems:1000,globalBytes:100000000},pipeline:async(commands:(string|number)[][])=>{
   for(const c of commands)if(c[0]==='EVAL'&&c[1]===COMMIT_ORDER_CONFIRMATION&&!settled){settled=true;
    // Only the preexisting synthetic accounting fixture boundary is supplied;
    // the actual paid/origin Lua and encrypted original source run unchanged.
    await pipeline([['HSET',String(c[5]),String(c[10]),2],['HSET',String(c[6]),String(c[10]),2*Number(c[11])]]);}
   return pipeline(commands);
  }};
  const initial=await runOrderConfirmationMail(now()+30000,async()=> 'waiting',physical);
  assert.equal(initial.waiting,1,JSON.stringify(initial));
  const preserved=await readConfirmationOrigin(confirmationId,physical);assert.ok(preserved?.payload.message);
  const originalConfirmation=JSON.stringify(preserved.payload.message);
  assert.equal(preserved.row.checks,1);assert.equal(preserved.row.next,0);
  const originals=new Map<string,string>();
  for(let i=0;i<count-1;i++){
   const input={statsId:'synthetic_paged_recovery_'+count,session:'cs_test_PagedRecovery'+count+String(i).padStart(4,'0'),authorizedAt:clock,
    shipped:{at:Math.floor(clock/1000),tracking:'https://example.test/track/'+i},
    message:{from:'Store <mail@example.test>',to:'buyer@example.test',subject:'Original '+count+' '+i,text:'Immutable original '+i,replyTo:'owner@example.test'}};
   assert.equal((await enqueueShipmentMail(input,runtime)).ok,true);
   const id=shipmentMailId(input.statsId,input.session);originals.set(input.message.subject,JSON.stringify(input.message));
   assert.equal((await runShipmentMail(now()+30000,async()=> 'waiting',runtime,id)).waiting,1);
  }
  assert.equal((await pipeline([['SCARD',all]]))[0],count);
  let revision=1,grants=1,accepted=0,confirmationAccepted=0;
  const sent=new Set<string>();
  const funded=(revision:number)=>({...old,reviewId:'SYNTHETIC_PAGED_'+count+'_'+revision,continuedReviewIds:[old.reviewId,f.runtime.policy!.reviewId],maximumChecks:2,
   recovery:{...recovery(),revision,startsAt:clock-1000,until:clock+3600000,maximumOrigins:1000,checkpointTotalBytes:100000,
    maximumAttempts:1000,maximumCommandUnits:64000,maximumReadBytes:1048576000,maximumTriggerInvocations:1000}});
  let policy=funded(revision),complete:Record<string,unknown>|undefined;
  for(let pass=0;pass<2500;pass++){
   const result=await Promise.all([
    runShipmentMail(now()+30000,async(message,barrier)=>{
     assert.equal(JSON.stringify(message),originals.get(message.subject));assert.equal(sent.has(message.subject),false);
     assert.equal(await barrier(),true);sent.add(message.subject);return 'accepted';
    },{...runtime,policy}),
    runOrderConfirmationMail(now()+30000,async(message,barrier)=>{
     assert.equal(JSON.stringify(message),originalConfirmation);assert.equal(confirmationAccepted,0);
     assert.equal(await barrier(),true);return 'accepted';
    },{...physical,policy}),
   ]);
   accepted+=result[0].accepted;confirmationAccepted+=result[1].accepted;
   complete=JSON.parse(String((await pipeline([['HGET',pool,'pendingRecovery']]))[0]));
   if(complete?.phase==='done')break;
   if(complete?.attempts===1000){
    // Test supplies each separate explicit review; production never fabricates
    // funding or renews these grants on its own.
    revision++;grants++;policy=funded(revision);
   }
  }
  assert.equal(complete?.phase,'done');assert.equal(accepted,count-1);assert.equal(sent.size,count-1);assert.equal(confirmationAccepted,1);
  assert.equal(grants,count===101?1:3);assert.equal((await pipeline([['SCARD',all]]))[0],0);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1,'only the original checkout POST');
  const [fields]=await pipeline([['HKEYS',pool]]);assert.ok(Array.isArray(fields));assert.equal(fields.some(f=>String(f).startsWith('pendingRecoveryPage:')),false);
  const [keptSource]=await pipeline([['GET',keys[1]]]);assert.equal(keptSource,source.row.sourceValue);
 });
});

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

// The original confirmation's ID hashes a random nonce, so the unsupported
// source that must sort before it is searched for, not hard-coded. A fixed
// candidate count missed every ID below its lowest hash (~0.073% of runs);
// the search now continues, in the same order, until a candidate precedes the
// ID. Only an ID below every hash up to the ceiling (about1 in4.2 million
// runs) fails, loudly, never with an empty session.
const PRECEDING_SEARCH_CEILING=1<<22;
function sessionPreceding(statsId:string,id:string,ceiling=PRECEDING_SEARCH_CEILING):string{
 for(let i=0;i<ceiling;i++){const candidate='cs_test_uncoveredPrefix00000'+i;if(shipmentMailId(statsId,candidate)<id)return candidate;}
 throw Error(`No unsupported source among ${ceiling} sessions sorts before original ${id}; rerun, the ID is random`);
}

test('the unsupported prefix search finds a preceding source even for a very low original ID', ()=>{
 // Below0x002fe9, the lowest of the first thousand candidates (~0.073% of random IDs).
 const low='0000ffff'+'f'.repeat(56),session=sessionPreceding('continuation_uncovered',low);
 assert.notEqual(session,'','a low random original ID must still get a preceding unsupported source');
 assert.ok(shipmentMailId('continuation_uncovered',session)<low);
 // Nothing can precede the all-zero ID: the search stops at its ceiling with a clear error.
 assert.throws(()=>sessionPreceding('continuation_uncovered','0'.repeat(64),1000),/No unsupported source among 1000 sessions sorts before original 0{64}/);
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
  const session=sessionPreceding('continuation_uncovered',id);
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
   if(accepted===1)break;
  }
  assert.equal(accepted,1,'finite newly funded small grants must reach and send the original paid confirmation');
  assert.ok(passes<=6);
  for(const checkpoint of observed.slice(0,-1))assert.deepEqual(checkpoint.ids,[firstId,id],'snapshot IDs remain original, even after row membership changes');
  // The final one-ticket grant has spent its capacity finishing the retained
  // list. Another explicitly financed grant may complete the pending refresh;
  // neither the original check quota nor any old grant is replenished.
  const drain={...physical,policy:{...physical.policy,reviewId:'SYNTHETIC_PROGRESS_DRAIN',continuedReviewIds:[physical.policy.reviewId],maximumChecks:2,
   recovery:{...recovery(),revision:100,startsAt:started-1000,until:started+3600000}}};
  for(let pass=0;pass<3;pass++)await Promise.all([
   runShipmentMail(clock()+30000,async()=>{throw Error('Uncovered origin may not send');},drain),
   runOrderConfirmationMail(clock()+30000,async()=>{throw Error('An accepted origin may not send again');},drain),
  ]);
  const [complete]=await pipeline([['HGET',pool,'pendingRecovery']]);assert.equal(JSON.parse(String(complete)).phase,'done');
  assert.equal((await pipeline([['GET','nl:ship:mail:row:'+firstId]]))[0],firstRaw,'unsupported source remains intact');
  assert.equal((await pipeline([['GET',keys[0]]]))[0],null);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1,'only the original checkout was created');
 });
});
