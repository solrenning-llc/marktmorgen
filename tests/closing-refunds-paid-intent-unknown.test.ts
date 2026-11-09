/** Codex G on #3120 (review 5814744416): a paid invoice-payment row with unreadable payment_intent is unknown, never a final no-payment settlement. Body and assertions are G's proof (SHA256 6de337ab...) unchanged. */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
const DAY=Date.UTC(2026,10,6),SEC=DAY/1000,SUB="sub_GMissingPi01",INV="in_GMissingPi01",PI="pi_GMissingPi01";
let payment:unknown=PI,empty=false,posts=0;
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const path=new URL(String(input)).pathname;
 if(path==="/v1/balance")return Response.json({object:"balance",available:[{amount:100000,currency:"usd"}]});
 if(path===`/v1/invoices/${INV}`)return Response.json({id:INV,payment_intent:null});
 if(path==="/v1/invoice_payments")return Response.json({object:"list",has_more:false,data:empty?[]:[{id:"inpay_GMissingPi",invoice:INV,status:"paid",payment:{type:"payment_intent",payment_intent:payment}}]});
 if(path===`/v1/payment_intents/${PI}`)return Response.json({id:PI,latest_charge:{id:"ch_GMissingPi01",amount:1000,currency:"usd",amount_refunded:0,disputed:false,balance_transaction:null}});
 if(path==="/v1/refunds"&&init?.method==="POST"){
  posts++;const b=new URLSearchParams(String(init.body));return Response.json({object:"refund",id:"re_GMissingPi01",amount:Number(b.get("amount")),currency:"usd",payment_intent:PI,status:"succeeded"});
 }
 if(path==="/v1/refunds")return Response.json({object:"list",data:[],has_more:false});
 throw Error("G unexpected synthetic request");
}) as typeof fetch;
async function seed(label:string){
 redis.clear();posts=0;
 const email=`g-${label}@example.com`;await claimHandle(email,`gpi${label}`,"G refund","");
 const store={...(await storeForEmail(email))!,stripeAccountId:"acct_GMissing01"} as Store;
 const folder=await storeFolder(email);
 await redis.pipeline([["HSET",paidKey(folder),SUB,JSON.stringify({inv:INV,amt:1000,tot:1000,cur:"usd",ps:SEC-15*86400,pe:SEC+15*86400,e:"member@example.com"})],["HSET",workKey(folder),"calls",30,"rcalls",30]]);
 return {store,folder};
}
async function main(){
 process.env.STRIPE_SECRET_KEY="sk_test_g_missing_pi";
 for(const [label,bad]of [["missing",undefined],["null",null],["invalid","pi_bad"]]as const){
  empty=false;payment=bad;const {store,folder}=await seed(label);
  const first=await giveBackUnused(store,DAY,{final:true});
  is(`${label}: unread paid row fails, never settles none`,typeof first==="object"?[first.failed,first.none,posts]:first,[1,0,0]);
  const [raw]=await redis.pipeline([["HGET",paidKey(folder),SUB]]);
  is(`${label}: its durable row stays unsettled`,JSON.parse(String(raw)).r??null,null);
  payment=PI;const next=await giveBackUnused(store,DAY,{final:true});
  is(`${label}: healthy retry still reaches and refunds the member`,typeof next==="object"?[next.done.map(x=>x.sub),posts]:next,[[SUB],1]);
 }
 empty=true;payment=PI;const no=await seed("empty");const none=await giveBackUnused(no.store,DAY,{final:true});
 is("healthy control: known complete empty list may settle none",typeof none==="object"?[none.failed,none.none,posts]:none,[0,1,0]);
 empty=false;const good=await seed("good");const paid=await giveBackUnused(good.store,DAY,{final:true});
 is("healthy control: own paid row with readable intent refunds once",typeof paid==="object"?[paid.failed,paid.done.map(x=>x.sub),posts]:paid,[0,[SUB],1]);
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
