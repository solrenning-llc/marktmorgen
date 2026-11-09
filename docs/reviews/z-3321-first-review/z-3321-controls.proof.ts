import test from "node:test";
import assert from "node:assert/strict";
import { readStoreDisputes, readStoreRefunds } from "@/lib/stats";
import { disputesSince, settleLine } from "@/lib/affiliates";
import { keptIn, type Entry } from "@/lib/retained-revenue";
import { owedOnFee, settleFee } from "@/lib/share-settle";
import type { Store } from "@/lib/store";
const fee={id:"fee_Z3321Proof01",account:"acct_Z3321Proof01",charge:"ch_Z3321Proof01",amount:625,refunded:0,currency:"usd"};
const since=1790000000,now=1800000000,pi="pi_Z3321Proof01";
const shop={stripeAccountId:fee.account} as Store;
const row={object:"dispute",id:"du_Z3321Proof01",charge:fee.charge,payment_intent:pi,currency:"usd",created:since+10,amount:10000,status:"prevented"};
function world(options:{status?:string;list?:unknown;refund?:boolean;badReceipt?:boolean;chargePatch?:Record<string,unknown>}={}){
 const calls:{path:string;method:string;headers:Headers;body:URLSearchParams}[]=[];
 const reply=options.list??{object:"list",has_more:false,data:[{...row,status:options.status??"prevented"}]};
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input)),method=init?.method??"GET",headers=new Headers(init?.headers),body=new URLSearchParams(String(init?.body??""));
  assert.equal(u.origin,"https://api.stripe.com");calls.push({path:u.pathname,method,headers,body});
  if(u.pathname==="/v1/charges/"+fee.charge)return Response.json({object:"charge",id:fee.charge,currency:"usd",amount:10000,amount_refunded:0,disputed:true,invoice:null,payment_intent:{object:"payment_intent",id:pi,currency:"usd",amount:10000,latest_charge:fee.charge,metadata:{share_bps:"625",share_base:"10000"}},...options.chargePatch});
  if(u.pathname==="/v1/disputes")return Response.json(reply);
  if(u.pathname==="/v1/refunds")return Response.json({object:"list",has_more:false,data:options.refund?[{object:"refund",id:"re_Z3321Proof01",payment_intent:pi,currency:"usd",amount:10000,status:"succeeded",created:since+10}]:[]});
  if(u.pathname===`/v1/application_fees/${fee.id}/refunds`)return Response.json({object:"fee_refund",id:"fr_Z3321Proof01",fee:options.badReceipt?"fee_Foreign0001":fee.id,amount:Number(body.get("amount")),currency:"usd"});
  throw Error("Unexpected synthetic endpoint "+u.pathname);
 };
 process.env.STRIPE_SECRET_KEY="sk_test_z3321_synthetic_only";
 return {calls,posts:()=>calls.filter(c=>c.method==="POST")};
}
const entries=(rows:{created:number;cents:number;currency:string}[]):Entry[]=>rows.map(x=>({day:new Date(x.created).toISOString().slice(0,10),cents:x.cents,currency:x.currency,source:"direct"}));
const referral={ref:"ref_Z3321",pi,aff:"aff_Z3321",at:since,product:"product_Z3321",title:"Synthetic",base:10000,total:10000,currency:"usd",rate:10,self:false,how:"click" as const};

test("prevented reaches actual readers, retained revenue and affiliate settlement",async()=>{
 const w=world();const stats=await readStoreDisputes(shop,since),aff=await disputesSince(shop,since);
 assert.equal(stats.partial,false);assert.equal(aff.complete,true);
 const entry={day:new Date((since+10)*1000).toISOString().slice(0,10),cents:10000,currency:"usd",source:"direct"};
 const kept=keptIn({sales:{entries:[entry],complete:true},renewals:null,refunds:{entries:[],complete:true},disputes:{entries:entries(stats.rows),complete:!stats.partial}},entry.day,"usd");
 assert.equal(kept.lines[0].keptCents,0);assert.equal(kept.byChannel?.reduce((sum,c)=>sum+c.keptCents,0),0);
 assert.equal(settleLine(referral,aff.byIntent.get(pi)??0).commission,0);assert.equal(w.posts().length,0);
});
test("prevented refund replay keeps one key and a confirmed fully refunded fee performs no reads",async()=>{
 const w=world();assert.equal(await settleFee(fee,now,true),625);assert.equal(await settleFee(fee,now,true),625);
 assert.equal(w.posts().length,2);assert.deepEqual(w.posts().map(c=>c.headers.get("Idempotency-Key")),Array(2).fill(`share-back:${fee.id}:0:625`));
 assert.deepEqual(w.posts().map(c=>Object.fromEntries(c.body)),Array(2).fill({amount:"625"}));
 const before=w.calls.length;assert.equal(await settleFee({...fee,refunded:625},now,true),0);assert.equal(w.calls.length,before);
 // Two requests are NOT evidence of two provider effects: only a live provider can enforce this key.
});
test("unconfirmed refund receipt retries the same difference with the same key",async()=>{
 const w=world({badReceipt:true});await assert.rejects(settleFee(fee,now,true),/receipt was not confirmed/);await assert.rejects(settleFee(fee,now,true),/receipt was not confirmed/);
 assert.equal(w.posts().length,2);assert.equal(w.posts()[0].headers.get("Idempotency-Key"),w.posts()[1].headers.get("Idempotency-Key"));
});
test("prevented GET bindings retain the exact account, charge and pinned version",async()=>{
 const w=world();assert.equal(await owedOnFee(fee,now,true),0);assert.equal(w.calls.length,2);
 for(const c of w.calls){assert.equal(c.headers.get("Stripe-Account"),fee.account);assert.equal(c.headers.get("Stripe-Version"),"2024-06-20");}
 assert.equal(w.posts().length,0);
});
test("partial, foreign, duplicate and unknown dispute evidence cannot refund",async()=>{
 for(const list of [{object:"list",has_more:true,data:[row]},{object:"list",has_more:false,data:[{...row,charge:"ch_Foreign0001"}]},{object:"list",has_more:false,data:[{...row,currency:"eur"}]},{object:"list",has_more:false,data:[row,row]},{object:"list",has_more:false,data:[{...row,status:"future_unknown"}]}]){
  const w=world({list});await assert.rejects(settleFee(fee,now,true));assert.equal(w.posts().length,0);
 }
});
test("unknown charge amount or currency never becomes a refund entitlement",async()=>{
 for(const chargePatch of [{amount:null},{amount_refunded:undefined},{currency:"eur"}]){const w=world({chargePatch});await assert.rejects(settleFee(fee,now,true));assert.equal(w.posts().length,0);}
});
test("won keeps the fee while legacy and case-variant statuses fail closed",async()=>{
 const w=world({status:"won"});assert.equal(await settleFee(fee,now,true),0);assert.equal(w.posts().length,0);
 for(const status of ["charge_refunded","PREVENTED"]){const u=world({status});await assert.rejects(settleFee(fee,now,true));assert.equal(u.posts().length,0);}
});
test("conditional refund plus prevented composition is observed without claiming live co-occurrence",async()=>{
 const w=world({refund:true});const refunds=await readStoreRefunds(shop,since,1),disputes=await readStoreDisputes(shop,since),aff=await disputesSince(shop,since);
 assert.equal(refunds.partial,false);assert.equal(disputes.partial,false);assert.equal(refunds.rows[0].paymentIntent,pi);
 const entry={day:new Date((since+10)*1000).toISOString().slice(0,10),cents:10000,currency:"usd",source:"direct"};
 const kept=keptIn({sales:{entries:[entry],complete:true},renewals:null,refunds:{entries:entries(refunds.rows),complete:true},disputes:{entries:entries(disputes.rows),complete:true}},entry.day,"usd");
 const commission=settleLine(referral,refunds.rows[0].cents+(aff.byIntent.get(pi)??0)).commission;
 console.log("Z_CONDITIONAL_COMPOSITION",JSON.stringify({refunds:refunds.rows.length,disputes:disputes.rows.length,kept:kept.lines[0].keptCents,commission,liveCooccurrenceProven:false}));assert.equal(commission,0);assert.equal(w.posts().length,0);
});
