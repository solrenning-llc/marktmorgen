import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {restartPlan,fundedRestartRequestBody} from "@/lib/billing";
import type {OwnedRestartIntent} from "@/lib/contract-funding";
import {PLAN_PRICES} from "@/lib/plan";
const VERSION="2025-09-30.clover";
test("returning from a legacy pause posts explicit classic with pinned version and original idempotency",async()=>{
 process.env.STRIPE_SECRET_KEY="sk_test_tax_journey_only";
 const original=globalThis.fetch;let posts=0;const now=Math.floor(Date.now()/1000);
 const price={id:"price_RestartClassic01",active:true,currency:"usd",unit_amount:PLAN_PRICES.creator.month,lookup_key:"nimbus_labs_creator_month",recurring:{interval:"month",interval_count:1}};
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.hostname,"api.stripe.com");
  if(url.pathname==="/v1/prices")return Response.json({object:"list",data:[price],has_more:false});
  assert.equal(url.pathname,"/v1/subscriptions");assert.equal(init?.method,"POST");posts++;
  const body=new URLSearchParams(String(init?.body)),headers=new Headers(init?.headers);
  assert.equal(body.get("billing_mode[type]"),"classic");assert.equal(headers.get("Stripe-Version"),VERSION);
  assert.equal(headers.get("Idempotency-Key"),"restart-synthetic-classic");assert.equal(headers.has("Stripe-Account"),false);
  assert.equal(body.get("customer"),"cus_RestartClassic01");assert.equal(body.get("default_payment_method"),"pm_RestartClassic01");assert.equal(body.get("items[0][price]"),price.id);
  return Response.json({id:"sub_RestartClassic01",status:"active",customer:"cus_RestartClassic01",trial_end:null,metadata:{tier:"creator"},items:{data:[{quantity:1,current_period_start:now-10,current_period_end:now+30*86400,price}]}});
 };
 try {await restartPlan({store:{handle:"restart-classic"},customerId:"cus_RestartClassic01",paymentMethod:"pm_RestartClassic01",tier:"creator",idempotencyKey:"restart-synthetic-classic"});assert.equal(posts,1);}finally{globalThis.fetch=original;}
});
test("funded restart freezes classic into the body before its hash and permanent submission barrier",()=>{
 const source="ctr_SourceClassic01",subscription="sub_SourceClassic01";
 const intent={handle:"restart-classic",claim:"claim_RestartClassic01",grant:{id:"ctr_NewClassic01",reviewId:"review_classic",key:"creator_month",action:"restart",sourceSubscriptionId:subscription},source:{binding:source+"|"+subscription},paused:JSON.stringify({customer:"cus_RestartClassic01",paymentMethod:"pm_RestartClassic01",tier:"creator",subscription,funding:{version:1,grantId:source}})} as OwnedRestartIntent;
 const before=JSON.stringify(intent),body=fundedRestartRequestBody(intent,"price_RestartClassic01");
 assert.equal(body.get("billing_mode[type]"),"classic");assert.equal(body.get("metadata[restart_source]"),subscription);assert.equal(JSON.stringify(intent),before);
 const code=readFileSync("lib/billing.ts","utf8");
 assert.match(code,/onPlatform\("POST", "\/subscriptions", body, \{idempotencyKey:armed.idempotencyKey, version: "2025-09-30.clover"\}\)/);
 assert.ok(code.indexOf("const body = fundedRestartRequestBody(intent,priceId)")<code.indexOf("const armed = await armRestartSubmission"));
});
