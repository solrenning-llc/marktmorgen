import test from "node:test";
import assert from "node:assert/strict";
import { readStoreDisputes, readStoreRefunds } from "@/lib/stats";
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
const moves=(...amounts:number[])=>amounts.map((amount,i)=>({object:"balance_transaction",id:`txn_ZFocal0${i}`,amount,currency:"usd"}));
const list=(movement:unknown)=>({object:"list",has_more:false,data:[{...row,balance_transactions:movement}]});
const asEntries=(rows:{created:number;cents:number;currency:string}[]):Entry[]=>rows.map(x=>({day:new Date(x.created).toISOString().slice(0,10),cents:x.cents,currency:x.currency,source:"direct"}));
const entry={day:new Date((since+10)*1000).toISOString().slice(0,10),cents:10000,currency:"usd",source:"direct"};
function kept(rows:Entry[],complete:boolean,refunds:Entry[]=[]){return keptIn({sales:{entries:[entry],complete:true},renewals:null,refunds:{entries:refunds,complete:true},disputes:{entries:rows,complete}},entry.day,"usd").lines[0].keptCents;}
test("block and reinstatement preserve the fee and retained revenue",async()=>{
 for(const movement of [[],moves(-10000,10000)]){
  const w=world({list:list(movement)});assert.equal(await settleFee(fee,now,true),0);assert.equal(w.posts().length,0);
  const r=await readStoreDisputes(shop,since);assert.equal(r.partial,false);assert.equal(kept(asEntries(r.rows),!r.partial),10000);
 }
});
test("resolution uses amount rather than net and keeps refund idempotency",async()=>{
 const movement=[{...moves(-10000)[0],fee:1500,net:-11500}];const w=world({list:list(movement)});
 assert.equal(await owedOnFee(fee,now,true),0);assert.equal(await settleFee(fee,now,true),625);assert.equal(w.posts().length,1);assert.equal(w.posts()[0].headers.get("Idempotency-Key"),`share-back:${fee.id}:0:625`);
 const count=w.calls.length;assert.equal(await settleFee({...fee,refunded:625},now,true),0);assert.equal(w.calls.length,count);
 const r=await readStoreDisputes(shop,since);assert.equal(kept(asEntries(r.rows),!r.partial),0);
});
test("unreadable own movement is partial revenue and cannot refund",async()=>{
 for(const movement of [null,["txn_Unknown0001"],[{object:"balance_transaction",amount:"-10000"}],moves(10000)]){
  const w=world({list:list(movement)});await assert.rejects(settleFee(fee,now,true));assert.equal(w.posts().length,0);
  const r=await readStoreDisputes(shop,since);assert.equal(r.partial,true);assert.equal(kept(asEntries(r.rows),!r.partial),null);
 }
});
test("a healthy resolution survives an unreadable sibling without a complete claim",async()=>{
 const w=world({list:{object:"list",has_more:false,data:[{...row,balance_transactions:moves(-10000)},{...row,id:"du_ZUnknownSibling01",payment_intent:"pi_ZUnknownSibling01",balance_transactions:null}]}});
 const r=await readStoreDisputes(shop,since);assert.equal(r.rows.length,1);assert.equal(r.partial,true);assert.equal(kept(asEntries(r.rows),!r.partial),null);assert.equal(w.posts().length,0);
});
test("a refund and a no-withdrawal prevented row count once",async()=>{
 const w=world({list:list([]),refund:true});const r=await readStoreDisputes(shop,since),f=await readStoreRefunds(shop,since,1);
 assert.equal(r.partial,false);assert.equal(f.partial,false);assert.equal(kept(asEntries(r.rows),!r.partial,asEntries(f.rows)),0);assert.equal(w.posts().length,0);
});
