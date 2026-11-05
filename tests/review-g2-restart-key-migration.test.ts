import { test } from "node:test";
import assert from "node:assert/strict";
import { runBreaks, pauseOf } from "@/lib/plan-pause";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { PLAN_PRICES } from "@/lib/plan";
import { store as redis } from "./redis-stub";

const DAY = 86_400;

async function fixture(handle: string) {
  redis.clear();
  const email = `${handle}@example.test`, now = Math.floor(Date.now() / 1000);
  assert.equal((await claimHandle(email, handle, "Restart contract fixture", "")).ok,true);
  const subscription = `sub_${handle.replaceAll("-", "")}`;
  assert.ok(await setSubscription(email, { customerId: "cus_RestartContract01", subscriptionId: subscription,
    active: false, tier: "creator", cycle: "month" }));
  const store = (await storeForEmail(email))!, ref = storeRef(store);
  const record = { subscription, customer: "cus_RestartContract01", paymentMethod: "pm_RestartContract01",
    tier: "creator", from: now - 31 * DAY, until: now - 1, told: now - 7 * DAY };
  await redis.pipeline([["SET", `nl:pause:${ref}`, JSON.stringify(record)], ["ZADD", "nl:pause:due", record.until, ref]]);
  return { store, ref, record, now, oldKey: `restart:${subscription}:${record.until}` };
}


/** The provider retains an accepted legacy outcome even when its response never reached our local store. */
function world(f:Awaited<ReturnType<typeof fixture>>,priorAccepted=false,loseClassicAck=false){
 const original=globalThis.fetch,price={id:'price_G2RestartMigration',active:true,currency:'usd',unit_amount:PLAN_PRICES.creator.month,lookup_key:'nimbus_labs_creator_month',recurring:{interval:'month',interval_count:1}};
 const oldBody=new URLSearchParams({customer:f.record.customer,'items[0][price]':price.id,'items[0][quantity]':'1',default_payment_method:f.record.paymentMethod,off_session:'true',payment_behavior:'error_if_incomplete','metadata[store]':f.store.handle,'metadata[tier]':'creator','metadata[restarted]':'break'}).toString();
 const bound=new Map<string,string>([[f.oldKey,oldBody]]),accepted=new Map<string,{id:string;status:'active'}>();
 if(priorAccepted)accepted.set(f.oldKey,{id:'sub_G2LegacyAccepted01',status:'active'});
 const calls:{key:string;body:string}[]=[];let lose=loseClassicAck;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,'https://api.stripe.com');
  if(url.pathname==='/v1/prices')return Response.json({object:'list',data:[price],has_more:false});
  assert.equal(url.pathname,'/v1/subscriptions');assert.equal(init?.method,'POST');const key=new Headers(init.headers).get('Idempotency-Key')!,body=String(init.body);calls.push({key,body});
  if(bound.has(key)&&bound.get(key)!==body)return Response.json({error:{type:'idempotency_error',message:'The original key is bound to the earlier body'}},{status:400});
  if(!bound.has(key))bound.set(key,body);
  if(!accepted.has(key))accepted.set(key,{id:'sub_G2ClassicAccepted'+accepted.size,status:'active'});
  if(lose){lose=false;throw Error('Synthetic accepted classic response lost');}
  return Response.json({id:accepted.get(key)?.id,status:'active',customer:f.record.customer,trial_end:null,metadata:{tier:'creator'},items:{data:[{quantity:1,current_period_start:f.now-10,current_period_end:f.now+30*DAY,price}]}});
 };
 return {accepted,calls,restore:()=>{globalThis.fetch=original;}};
}
async function cleanup(f:Awaited<ReturnType<typeof fixture>>){await redis.pipeline([['DEL',`nl:pause:${f.ref}`],['ZREM','nl:pause:due',f.ref]]);}
test('control: when no legacy operation was accepted the classic request creates one subscription',async()=>{
 process.env.STRIPE_SECRET_KEY='sk_test_g2_restart_only';const f=await fixture('g2-no-ack'),p=world(f);
 try{assert.equal((await runBreaks(f.now)).restarted,1);assert.equal(p.accepted.size,1);assert.equal(p.calls[0].key,f.oldKey+':classic');}finally{p.restore();await cleanup(f);}
});
test('control: lost classic response retries identical bytes with one accepted operation',async()=>{
 const f=await fixture('g2-classic-retry'),p=world(f,false,true);
 try{assert.equal((await runBreaks(f.now)).failed,1);assert.ok(await pauseOf(f.store));assert.equal((await runBreaks(f.now+1)).restarted,1);assert.equal(p.accepted.size,1);assert.deepEqual(p.calls[1],p.calls[0]);}finally{p.restore();await cleanup(f);}
});
test('an accepted legacy operation with lost local acknowledgment cannot authorize a second classic operation',async()=>{
 const f=await fixture('g2-legacy-ack'),p=world(f,true);
 try{
  assert.equal(p.accepted.size,1);assert.equal(f.store.subscriptionActive,false);
  const result=await runBreaks(f.now),pause=await pauseOf(f.store);
  console.log('G2_RESTART_LEGACY_ACCEPTED',JSON.stringify({accepted:[...p.accepted.values()],keys:p.calls.map(c=>c.key),result,pause}));
  assert.equal(p.accepted.size,1,'changing the request key bypassed the retained accepted legacy outcome and created a second subscription');
 }finally{p.restore();await cleanup(f);}
});
test('control: concurrent workers with the same classic contract create only one operation',async()=>{
 const f=await fixture('g2-classic-race'),p=world(f);
 try{await Promise.all([runBreaks(f.now),runBreaks(f.now)]);assert.equal(p.accepted.size,1);assert.ok(p.calls.length>=1);assert.ok(p.calls.every(c=>c.key===f.oldKey+':classic'&&c.body===p.calls[0].body));}finally{p.restore();await cleanup(f);}
});
