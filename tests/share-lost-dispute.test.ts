import test from "node:test";
import assert from "node:assert/strict";
import { owedOnFee, settleFee } from "@/lib/share-settle";
const fee={id:"fee_DisputeProof01",account:"acct_Receipt0001",charge:"ch_DisputeProof01",amount:625,refunded:0,currency:"usd"};
const now=1800000000;
function world(disputed=true) {
 const calls:{url:URL;method:string;headers:Headers;body:URLSearchParams}[]=[];
 let answer:unknown={object:"list",has_more:false,data:[{id:"du_DisputeProof01",object:"dispute",charge:fee.charge,currency:"usd",status:"lost"}]};
 let code=200;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));const method=init?.method??"GET",headers=new Headers(init?.headers),body=new URLSearchParams(String(init?.body??""));calls.push({url,method,headers,body});
  assert.equal(url.origin,"https://api.stripe.com");
  if(url.pathname==="/v1/charges/"+fee.charge)return Response.json({object:"charge",id:fee.charge,currency:"usd",amount:10000,amount_refunded:0,disputed,invoice:null,payment_intent:{object:"payment_intent",id:"pi_DisputeProof01",currency:"usd",amount:10000,latest_charge:fee.charge,metadata:{share_bps:"625",share_base:"10000"}}});
  if(url.pathname==="/v1/disputes")return Response.json(answer,{status:code});
  if(url.pathname===`/v1/application_fees/${fee.id}/refunds`)return Response.json({object:"fee_refund",id:"fr_DisputeProof01",fee:fee.id,amount:Number(body.get("amount")),currency:"usd"});
  throw Error("Unexpected synthetic endpoint");
 };
 process.env.STRIPE_SECRET_KEY="sk_test_fee_refund_only_a_stand_in";
 return {calls,set:(value:unknown,status=200)=>{answer=value;code=status;}};
}
test("a lost dispute without the removed charge.dispute field reverses the actual fee once",async()=>{
 const w=world();assert.equal(await owedOnFee(fee,now,true),0);
 assert.equal(await settleFee(fee,now,true),625);
 const writes=w.calls.filter(c=>c.method==="POST");assert.equal(writes.length,1);
 assert.equal(writes[0].headers.get("Stripe-Account"),null);assert.equal(writes[0].headers.get("Idempotency-Key"),`share-back:${fee.id}:0:625`);
 assert.deepEqual(Object.fromEntries(writes[0].body),{amount:"625"});
 assert.equal(await settleFee({...fee,refunded:625},now,true),0);assert.equal(w.calls.filter(c=>c.method==="POST").length,1);
 for(const c of w.calls.filter(c=>c.method==="GET")){
  assert.equal(c.headers.get("Stripe-Account"),fee.account);assert.equal(c.headers.get("Stripe-Version"),"2024-06-20");
  assert.equal(c.url.searchParams.getAll("expand[]").includes("dispute"),false);
  if(c.url.pathname==="/v1/disputes")assert.deepEqual(Object.fromEntries(c.url.searchParams),{charge:fee.charge,limit:"100"});
 }
});
test("ordinary charges keep their one-read path; non-lost disputes keep their fee",async()=>{
 const ordinary=world(false);assert.equal(await owedOnFee(fee,now,true),625);assert.equal(ordinary.calls.length,1);
 for(const status of ["won","needs_response","under_review","warning_needs_response","warning_under_review","warning_closed"]){
  const w=world();w.set({object:"list",has_more:false,data:[{id:"du_DisputeProof01",object:"dispute",charge:fee.charge,currency:"usd",status}]});assert.equal(await owedOnFee(fee,now,true),625);assert.equal(w.calls.length,2);
 }
});
test("incomplete, foreign or unknown dispute evidence cannot issue a refund",async()=>{
 const row={id:"du_DisputeProof01",object:"dispute",charge:fee.charge,currency:"usd",status:"lost"};
 for(const answer of [null,{},[],{object:"list",has_more:true,data:[row]},{object:"list",has_more:false,data:[]},{object:"list",data:[row]},...['charge','currency','status','id','object'].map(key=>({object:"list",has_more:false,data:[{...row,[key]:"wrong"}]})),{object:"list",has_more:false,data:[row,row]},{object:"list",has_more:false,data:[row,...Array(100).fill(row)]}]){
  const w=world();w.set(answer);await assert.rejects(settleFee(fee,now,true));assert.equal(w.calls.filter(c=>c.method==="POST").length,0);
 }
 const w=world();w.set({error:{message:"Synthetic unavailable"}},503);await assert.rejects(settleFee(fee,now,true));assert.equal(w.calls.filter(c=>c.method==="POST").length,0);
});

test("a complete multi-row result uses the matching lost outcome and accepts expanded charge IDs",async()=>{
 const w=world();w.set({object:"list",has_more:false,data:[{id:"du_WonProof01",object:"dispute",charge:fee.charge,currency:"usd",status:"won"},{id:"du_LostProof01",object:"dispute",charge:{id:fee.charge},currency:"usd",status:"lost"}]});
 assert.equal(await owedOnFee(fee,now,true),0);assert.equal(w.calls.length,2);
});
