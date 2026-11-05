/** Independent API-contract boundary: explicit nullable metadata on an unrelated Stripe refund. */
import { ENDING_KEY, SETTLE_SECONDS, findPlanRefund, finishPlanRefunds, partsOutcome } from "@/lib/plan-refund-flow";
import { store as redis } from "./redis-stub";
import { NOW, paidShop, world } from "./plan-refund-stripe-world";
import { done, is, part } from "./check";
async function main():Promise<void>{
  redis.clear();process.env.STRIPE_SECRET_KEY="sk_test_g_refund_nullable";
  const sid="g-null-metadata-store";
  const ours={id:"re_Ours000001",amount:123,currency:"usd",status:"succeeded",metadata:{plan_refund:sid}};
  const unrelated={id:"re_Other00001",amount:1,currency:"usd",status:"succeeded",metadata:null};
  const provider=globalThis.fetch;let data:unknown[]=[];
  globalThis.fetch=(async()=>new Response(JSON.stringify({data,has_more:false}),{status:200,headers:{"content-type":"application/json"}})) as typeof fetch;
  try{
    part("Valid Stripe metadata null is not an unknown refund row");
    data=[ours];is("owned refund control",(await findPlanRefund(sid,NOW-60,NOW)).kind,"found");
    data=[unrelated,ours];
    is("owned refund remains readable beside nullable unrelated metadata",(await findPlanRefund(sid,NOW-60,NOW)).kind,"found");
    is("charge outcome remains readable beside nullable unrelated metadata",(await partsOutcome(sid,[{c:"ch_Owned00001",a:123}])).kind,"found");
    data=[unrelated];is("explicitly absent metadata is not this store's refund",(await findPlanRefund(sid,NOW-60,NOW)).kind,"none");
    data=[{...unrelated,metadata:{}}];is("empty object metadata control",(await findPlanRefund(sid,NOW-60,NOW)).kind,"none");
  }finally{globalThis.fetch=provider;}
  part("Real pending-plan recovery can finish its known refund");
  const shop=await paidShop({stopSet:true});const store=await shop.store();
  const charge=world.charges.find(c=>c.customer===shop.sub().customer)!;
  if(!charge)throw Error("missing synthetic charge");
  const owned={id:"re_Recovery0001",charge:charge.id,payment_intent:charge.payment_intent,amount:6900,currency:"usd",status:"succeeded",created:NOW,metadata:{plan_refund:store.sid}};
  world.refunds.push({...unrelated,charge:"ch_Other00001",created:NOW},owned);
  charge.amount_refunded=6900;
  await redis.pipeline([["HSET",ENDING_KEY,store.sid,JSON.stringify({s:shop.subId,at:NOW-SETTLE_SECONDS-1,t:NOW-SETTLE_SECONDS-1,m:1})]]);
  const beforePosts=world.calls.filter(c=>c==="POST /refunds").length;
  await finishPlanRefunds(Date.now()+10000,NOW);
  is("known owned refund ends plan and removes its legacy note",[shop.sub().status,await shop.note()],["canceled",null]);
  is("recovery creates no new refund",world.calls.filter(c=>c==="POST /refunds").length,beforePosts);
  done();
}
void main();
