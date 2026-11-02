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
 maximumAttempts: 100, maximumCommandUnits: 6400,
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
  { checkpointBytes: 1 }, { startsAt: now + 1 }, { until: now },
  { revision: 0 }, { maximumTriggerInvocations: 0 }, { triggerEvidence: '' },
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
  await runShipmentMail(realNow()+30000,async()=>{throw Error('No shipment remains');},resumed);
  let physicalPosts=0;
  const outcome=await runOrderConfirmationMail(realNow()+30000,async(message,barrier)=>{
   assert.equal(JSON.stringify(message),JSON.stringify(preserved.payload.message));assert.equal(await barrier(),true);physicalPosts++;return 'accepted';
  },resumed);
  assert.equal(outcome.accepted,1);assert.equal(physicalPosts,1);
  assert.equal(f!.calls.filter(c=>c.method==='POST').length,1,'only the original synthetic checkout POST');
 }finally{
  await confirmationLocalPipeline([['DEL',...made]]);
  if(priorPool.length) await confirmationLocalPipeline([['HSET',pool,...priorPool.map(String)]]);
 }
});
