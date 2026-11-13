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
