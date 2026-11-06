/** Exercise the real queued worker: unknown erasure evidence must not permit email. */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceUpdate, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const person = "update-person@example.test";
async function setup() {
  redis.clear();
  const owner = "update-owner@example.test";
  const batches: { to: string | string[] }[][] = [];
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const data = url.pathname === "/v1/checkout/sessions" ? [{
      id: "cs_update_evidence", object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86400, amount_total: 2700, currency: "usd",
      customer_details: { email: person }, metadata: { store: "updateproof", product: productId },
    }] : [];
    return Response.json({ object: "list", data, has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "updateproof", "Update Proof", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_UpdateProof", subscriptionId: "sub_UpdateProof", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Update Proof", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Update evidence", "", "27", null);
  assert.ok(made.ok);
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/update");
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, productId))!;
  const started = await startUpdate(shop, product, "A verified update");
  assert.ok(started.ok, JSON.stringify(started));
  return { shop, job: started.job, batches, original: redis.pipeline.bind(redis) };
}


test("AA: recipient counter read failure waits then recovers a permitted buyer",async()=>{
 const r=await setup();const before=await usedThisMonth(r.shop.listId,windowId(r.shop));
 redis.pipeline=async cs=>{if(cs.some(c=>c[0]==="HEXISTS" && c[1]===`nl:erased:${r.shop.listId}`))throw new Error("synthetic unavailable");return r.original(cs);};
 try{const held=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);assert.deepEqual([held?.status,held?.done,held?.sent],["waiting",0,0]);assert.equal(r.batches.length,0);assert.equal(await usedThisMonth(r.shop.listId,windowId(r.shop)),before);
 redis.pipeline=r.original;const next=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);assert.deepEqual([next?.status,next?.done,next?.sent],["sent",1,1]);assert.equal(r.batches.flat().length,1);
 }finally{redis.pipeline=r.original;}
});
for(const reply of [[1,null,0],[0,JSON.stringify({unsub:true}),0],[0,null,1]])test("AA: each explicit opt-out is excluded: "+JSON.stringify(reply),async()=>{
 const r=await setup();redis.pipeline=async cs=>cs.some(c=>c[0]==="HEXISTS"&&c[1]===`nl:erased:${r.shop.listId}`)?reply:r.original(cs);
 try{const out=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);assert.deepEqual([out?.status,out?.done,out?.sent],["sent",1,0]);assert.equal(r.batches.length,0);}finally{redis.pipeline=r.original;}
});
test("AA: unknown recipient queue must not be discarded as completed",async()=>{
 const r=await setup();redis.pipeline=async cs=>cs.some(c=>c[0]==="LRANGE"&&c[1]===`nl:upd:job:${r.job.id}:to`)?[]:r.original(cs);
 try{const out=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);assert.deepEqual({status:out?.status,done:out?.done,sent:out?.sent,remaining:redis.run(["LRANGE",`nl:upd:job:${r.job.id}:to`,0,-1])},{status:"waiting",done:0,sent:0,remaining:[person]});assert.equal(r.batches.length,0);}finally{redis.pipeline=r.original;}
});

test("Q: an expired recipient list fails terminally instead of waiting forever",async()=>{
 const r=await setup();const recipients=`nl:upd:job:${r.job.id}:to`;redis.advance(59*86_400_000);
 redis.pipeline=async cs=>{if(cs.some(c=>c[0]==="HEXISTS"&&c[1]===`nl:erased:${r.shop.listId}`))throw new Error("synthetic pause before recipient proof");return r.original(cs);};
 try{
  const held=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);
  assert.deepEqual([held?.status,held?.done,held?.sent,r.batches.length],["waiting",0,0,0]);
  redis.advance(2*86_400_000);
  // Real Redis answers a missing LRANGE with an empty list without recreating
  // the key; avoid the test double's list helper materialising an empty key.
  redis.pipeline=async cs=>cs.length===1&&cs[0][0]==="LRANGE"&&cs[0][1]===recipients&&redis.run(["EXISTS",recipients])===0?[[]]:r.original(cs);
  const expired=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);
  assert.deepEqual({status:expired?.status,done:expired?.done,sent:expired?.sent,mail:r.batches.flat().length,queued:redis.run(["SISMEMBER","nl:updq",r.job.id]),recipients:redis.run(["EXISTS",recipients])},{status:"failed",done:0,sent:0,mail:0,queued:0,recipients:0});
  assert.match(expired?.note??"",/expired/i);
 }finally{redis.pipeline=r.original;}
});

const unknownPresenceReplies: unknown[] = [
 [], [null], [2], ["0"], [0, 0], Array(1), Object.assign(Object.create({ 0: 0 }), { length: 1 }),
];
for (const presence of unknownPresenceReplies) test("Q: unknown recipient-list presence remains retryable: "+JSON.stringify(presence),async()=>{
 const r=await setup();const recipients=`nl:upd:job:${r.job.id}:to`;
 redis.pipeline=async cs=>{
  if(cs.length===1&&cs[0][0]==="LRANGE"&&cs[0][1]===recipients)return [[]];
  if(cs.length===1&&cs[0][0]==="EXISTS"&&cs[0][1]===recipients)return presence as never;
  return r.original(cs);
 };
 try{
  const held=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);
  assert.deepEqual({status:held?.status,done:held?.done,sent:held?.sent,mail:r.batches.flat().length,queued:redis.run(["SISMEMBER","nl:updq",r.job.id]),recipients:redis.run(["LRANGE",recipients,0,-1])},{status:"waiting",done:0,sent:0,mail:0,queued:1,recipients:[person]});
 }finally{redis.pipeline=r.original;}
});


/**
 * Q / C5 SET NX regression: only confirmed ownership may create or advance an
 * update. The existing claim-mark contract reads an ambiguous SET back; an
 * exact own value is positive evidence, not a reason to reject healthy work.
 * All stores, buyers, mail transport and Redis effects below are synthetic.
 */
type QUpdateClaimMode = {
 name: string;
 unknown: boolean;
 applied: boolean;
 readback: "real" | "unreadable" | "foreign";
 outcome: "ours" | "taken" | "unknown";
};
import { nextUpdateAt as qNextUpdateAt, UPDATE_GAP_SECONDS as qUpdateGap } from "@/lib/product-updates";
const qUpdateClaimModes: QUpdateClaimMode[] = [
 {name:"healthy",unknown:false,applied:true,readback:"real",outcome:"ours"},
 {name:"confirmed taken",unknown:false,applied:false,readback:"real",outcome:"taken"},
 {name:"lost ACK with exact own readback",unknown:true,applied:true,readback:"real",outcome:"ours"},
 {name:"unapplied lost ACK with confirmed absence",unknown:true,applied:false,readback:"real",outcome:"unknown"},
 {name:"applied lost ACK with unreadable readback",unknown:true,applied:true,readback:"unreadable",outcome:"unknown"},
 {name:"unapplied lost ACK with unreadable readback",unknown:true,applied:false,readback:"unreadable",outcome:"unknown"},
 {name:"lost ACK with another owner's exact value",unknown:true,applied:false,readback:"foreign",outcome:"taken"},
];
const qUpdateOtherOwner = "0.000000001";

async function qUpdateClaimSetup(starting: boolean) {
 const r=await setup();
 const mark="nl:upd:last:"+r.shop.statsId+":"+r.job.product;
 const lock="nl:upd:job:"+r.job.id+":lock";
 if(starting){
  // Remove only this fixture's initial healthy job, keeping the real store,
  // product, synthetic sales reader and allowance admission for the action.
  await r.original([
   ["DEL",mark,"nl:upd:job:"+r.job.id,"nl:upd:job:"+r.job.id+":to","nl:upd:latest:"+r.shop.statsId+":"+r.job.product],
   ["SREM","nl:updq",r.job.id],
  ]);
 }
 const product=(await readListing(r.shop,r.job.product))!;
 assert.ok(product);
 return {...r,mark,lock,product};
}

function qUpdateClaimWire(
 r: Awaited<ReturnType<typeof qUpdateClaimSetup>>,
 key: string,
 mode: QUpdateClaimMode,
 releaseUnavailable = false,
) {
 const state={attempts:0,readbacks:0,value:"",blindDeletes:0,releaseAttempts:0};
 redis.pipeline=async commands=>{
  if(commands.some(c=>c[0]==="DEL"&&c[1]===key))state.blindDeletes++;
  if(commands.length===1&&commands[0][0]==="SET"&&commands[0][1]===key&&commands[0].includes("NX")){
   state.attempts++;
   state.value=String(commands[0][2]);
   if(!mode.unknown)return r.original(commands);
   if(mode.applied)await r.original(commands);
   if(mode.readback==="foreign")await r.original([["SET",key,qUpdateOtherOwner,"EX",90]]);
   return [];
  }
  if(state.attempts&&commands.length===1&&commands[0][0]==="GET"&&commands[0][1]===key){
   state.readbacks++;
   if(mode.readback==="unreadable")return [];
  }
  if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][3]===key&&String(commands[0][1]).startsWith("-- marktmorgen:release:v1")){
   state.releaseAttempts++;
   if(releaseUnavailable)return [];
  }
  return r.original(commands);
 };
 return state;
}

for(const mode of qUpdateClaimModes)test("Q NX start: "+mode.name,async()=>{
 const priorFetch=globalThis.fetch;
 const r=await qUpdateClaimSetup(true);
 try{
  if(mode.name==="confirmed taken")await r.original([["SET",r.mark,qUpdateOtherOwner,"EX",90]]);
  const state=qUpdateClaimWire(r,r.mark,mode);
  let answer: Awaited<ReturnType<typeof startUpdate>> | undefined;
  let rejected=false;
  const nowSeconds=Math.floor(Date.now()/1000);
  try{answer=await startUpdate(r.shop,r.product,"Synthetic claim evidence",nowSeconds);}catch{rejected=true;}
  const [queued,held]=await r.original([["SMEMBERS","nl:updq"],["GET",r.mark]]);
  const count=Array.isArray(queued)?queued.length:-1;
  console.log("Q NX observation",JSON.stringify({operation:"start",mode:mode.name,accepted:answer?.ok===true,rejected,queued:count,attempts:state.attempts,readbacks:state.readbacks}));
  assert.equal(state.attempts,1,"the claim is attempted once, never replayed");
  assert.equal(r.batches.length,0,"starting an update does not send mail itself");
  if(mode.outcome==="ours"){
   assert.deepEqual({accepted:answer?.ok===true,rejected,queued:count},{accepted:true,rejected:false,queued:1});
   assert.equal(held,state.value);
   if(mode.name==="healthy"){
    const [ttl]=await r.original([["TTL",r.mark]]);
    // The existing visible weekly interval is measured in seconds. A unique
    // fractional suffix may identify the claim; milliseconds must not leak in.
    assert.equal(Math.floor(await qNextUpdateAt(r.shop,r.job.product)),nowSeconds+qUpdateGap);
    assert.ok(Number(held)>=nowSeconds&&Number(held)<nowSeconds+1);
    assert.ok(typeof ttl==="number"&&ttl>0&&ttl<=qUpdateGap);
   }
   if(mode.unknown)assert.equal(state.readbacks,1,"lost ACK continues only after an exact own-value readback");
  }else{
   assert.deepEqual({accepted:answer?.ok===true,queued:count},{accepted:false,queued:0},"unowned claims never publish a job or recipient queue");
   if(mode.outcome==="taken"){
    assert.ok(answer&&!answer.ok);
    assert.equal(answer.reason,"soon");
    assert.equal(held,qUpdateOtherOwner,"another owner's mark survives");
   }else{
    if(answer&&!answer.ok)assert.notEqual(answer.reason,"soon","unknown is not a confirmed competing claim");
    assert.equal(held,mode.applied?state.value:null,"no rollback of an uncertain applied claim");
   }
  }
 }finally{redis.pipeline=r.original;globalThis.fetch=priorFetch;}
});

for(const mode of qUpdateClaimModes)test("Q NX worker: "+mode.name,async()=>{
 const priorFetch=globalThis.fetch;
 const r=await qUpdateClaimSetup(false);
 try{
  if(mode.name==="confirmed taken")await r.original([["SET",r.lock,qUpdateOtherOwner,"EX",90]]);
  const [beforeJob,beforeRecipients]=await r.original([["GET","nl:upd:job:"+r.job.id],["LRANGE","nl:upd:job:"+r.job.id+":to",0,-1]]);
  const beforeUsed=await usedThisMonth(r.shop.listId,windowId(r.shop));
  const state=qUpdateClaimWire(r,r.lock,mode);
  const answer=await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);
  const [afterJob,afterRecipients,queued,held]=await r.original([["GET","nl:upd:job:"+r.job.id],["LRANGE","nl:upd:job:"+r.job.id+":to",0,-1],["SISMEMBER","nl:updq",r.job.id],["GET",r.lock]]);
  const afterUsed=await usedThisMonth(r.shop.listId,windowId(r.shop));
  console.log("Q NX observation",JSON.stringify({operation:"worker",mode:mode.name,status:answer?.status??null,mail:r.batches.flat().length,queued,attempts:state.attempts,readbacks:state.readbacks,blindDeletes:state.blindDeletes}));
  assert.equal(state.attempts,1,"the worker claim is never replayed");
  if(mode.outcome==="ours"){
   assert.deepEqual([answer?.status,answer?.done,answer?.sent,r.batches.flat().length,queued,held],["sent",1,1,1,0,null]);
   if(mode.unknown)assert.equal(state.readbacks,1,"lost ACK continues only after an exact own-value readback");
  }else{
   assert.deepEqual({answer,job:afterJob,recipients:afterRecipients,queued,mail:r.batches.flat().length,used:afterUsed},{answer:null,job:beforeJob,recipients:beforeRecipients,queued:1,mail:0,used:beforeUsed},"unknown or taken ownership preserves the real pending job without mail or allowance use");
   assert.equal(state.blindDeletes,0,"an unowned worker must never delete the lock");
   assert.equal(held,mode.outcome==="taken"?qUpdateOtherOwner:mode.applied?state.value:null);
  }
 }finally{redis.pipeline=r.original;globalThis.fetch=priorFetch;}
});

test("Q NX release: a timed-out worker never removes a real successor's lock",async()=>{
 const priorFetch=globalThis.fetch;
 const r=await qUpdateClaimSetup(false);
 try{
  const state=qUpdateClaimWire(r,r.lock,qUpdateClaimModes[0]);
  let successors=0;
  const load=async(handle:string)=>{
   redis.advance(91_000);
   assert.deepEqual(await r.original([["SET",r.lock,qUpdateOtherOwner,"NX","EX",90]]),["OK"],"a real successor acquires the expired lock");
   successors++;
   return storeForHandle(handle);
  };
  await advanceUpdate(r.job.id,load,Date.now()+20000);
  const [held]=await r.original([["GET",r.lock]]);
  console.log("Q NX observation",JSON.stringify({operation:"release successor",successors,held,blindDeletes:state.blindDeletes}));
  assert.equal(successors,1);
  assert.equal(held,qUpdateOtherOwner,"release compares ownership atomically and preserves the successor");
  assert.equal(state.blindDeletes,0);
 }finally{redis.pipeline=r.original;globalThis.fetch=priorFetch;}
});

test("Q NX release: an unreadable compare-release leaves the owned lock to expire",async()=>{
 const priorFetch=globalThis.fetch;
 const r=await qUpdateClaimSetup(false);
 try{
  const state=qUpdateClaimWire(r,r.lock,qUpdateClaimModes[0],true);
  await advanceUpdate(r.job.id,storeForHandle,Date.now()+20000);
  const [held,ttl]=await r.original([["GET",r.lock],["TTL",r.lock]]);
  console.log("Q NX observation",JSON.stringify({operation:"release unknown",held,ttl,releaseAttempts:state.releaseAttempts,blindDeletes:state.blindDeletes}));
  assert.equal(held,state.value,"an unavailable release never falls back to deleting the lock");
  assert.equal(state.releaseAttempts,1);
  assert.equal(state.blindDeletes,0);
  assert.ok(typeof ttl==="number"&&ttl>0&&ttl<=90,"the existing lock expires without a new retention period");
 }finally{redis.pipeline=r.original;globalThis.fetch=priorFetch;}
});
