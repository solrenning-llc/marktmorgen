/** Retention construction only. Real admission and source code; fake provider.
 * Native CAS/accounting uses the opt-in disposable Redis runner as well. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import * as origin from "@/lib/order-confirmation-outbox";
import {prepareDigitalOptionPreintent} from "@/lib/digital-option-preintent";
import {admitOrders} from "@/lib/order-admission";
import {storeFolder,storeRef} from "@/lib/store";
import {DELAYED_METHODS} from "@/lib/instant-pay";
import {LANGUAGES} from "@/lib/store-language";
import {shipmentMailPolicy,SHIPMENT_MAIL_SCRIPT} from "@/lib/shipment-mail-outbox";
import {physicalPaidFixture,confirmationLocalPipeline} from "./order-confirmation-paid-fixture";
import {store as redis} from "./redis-stub";

async function fixture(){
 const f=await physicalPaidFixture(),folder=await storeFolder(storeRef(f.store)),nonce=randomBytes(32).toString("hex");
 const option={id:"edition01",label:"Original PDF",priceCents:6500,file:{pathname:`stores/${folder}/edition01/book.pdf`,name:"Book.pdf",bytes:1200,contentType:"application/pdf",addedAt:"2026-11-01T00:00:00.000Z"},link:null,details:[],best:false};
 const product={id:"product01",title:"Original book",summary:"Original summary",options:[option],fields:[]};
 const name=`${product.title} (${option.label})`,consent="yes:2026-10-30.2:d:1790000000";
 const admission=await admitOrders(f.store,1);assert.ok(admission.ok);
 const form=new URLSearchParams({mode:"payment",locale:LANGUAGES[f.store.language].stripe,"adaptive_pricing[enabled]":"false",
  success_url:`https://example.test/@${f.store.handle}/thanks?session_id={CHECKOUT_SESSION_ID}`,cancel_url:`https://example.test/@${f.store.handle}`,
  "metadata[store]":f.store.handle,"metadata[product]":product.id,"metadata[option]":option.id,"metadata[title]":name,"metadata[dc]":consent,
  "payment_intent_data[metadata][store]":f.store.handle,"payment_intent_data[metadata][product]":product.id,"payment_intent_data[metadata][option]":option.id,"payment_intent_data[metadata][dc]":consent,
  "line_items[0][quantity]":"1","line_items[0][price_data][unit_amount]":"6500","line_items[0][price_data][currency]":f.store.currency,
  "line_items[0][price_data][product_data][name]":name,"line_items[0][price_data][product_data][description]":product.summary,
  "metadata[mm_order_origin]":"digital-option-v1","metadata[mm_order_intent]":nonce,...(admission.hour===null?{}:{"metadata[mm_admit]":String(admission.hour)})});
 DELAYED_METHODS.forEach((method,i)=>form.set(`excluded_payment_method_types[${i}]`,method));
 form.set("metadata[mm_order_hash]",origin.confirmationBodyDigest(form.toString()));
 const request={store:f.store,product,optionId:option.id,folder,nonce,body:form.toString(),consent,maximumBytes:60000,admission};
 const receipt=await prepareDigitalOptionPreintent(request);assert.ok(receipt);
 f.runtime.policy={...f.runtime.policy!,coveredOrigins:["digital-option-retention"],digitalOptionRetentionEvidence:"SYNTHETIC ONLY: full bounded pending lifetime, not provider or access funding"};
 return {...f,request,receipt};
}
const reserve=(...args:Parameters<typeof origin.reserveDigitalOptionRetention>)=>origin.reserveDigitalOptionRetention(...args);

test("G2: incomplete enqueue receipts never confirm and never discard the committed original",async()=>{
 const variants=[
  {name:"empty outer",reply:(_raw:string)=>[]},
  {name:"missing row",reply:(_raw:string)=>[["queued"]]},
  {name:"null row",reply:(_raw:string)=>[["queued",null]]},
  {name:"extra tuple item",reply:(raw:string)=>[["queued",raw,"extra"]]},
  {name:"extra outer item",reply:(raw:string)=>[["queued",raw],null]},
  {name:"sparse outer",reply:(_raw:string)=>new Array(1)},
 ];
 for(const vector of variants){
  const f=await fixture(),pipeline=f.runtime.pipeline!;let altered=false;
  const runtime={...f.runtime,pipeline:async(commands:(string|number)[][])=>{
   const reply=await pipeline(commands);
   if(!altered&&commands.some(c=>c[0]==="EVAL")){altered=true;return vector.reply((reply[0] as string[])[1]) as unknown[];}
   return reply;
  }};
  assert.deepEqual(await reserve(f.receipt,runtime),{ok:false},vector.name);
  const id=origin.confirmationOriginId(f.store.statsId!,f.request.nonce),retained=await origin.readDigitalOptionRetention(id,f.runtime);
  assert.ok(retained,vector.name+": original committed liability remains");
  assert.equal(retained.payload.body,f.request.body);
  const retry=await reserve(f.receipt,f.runtime);assert.ok(retry.ok);
  assert.equal((await origin.readDigitalOptionRetention(id,f.runtime))?.raw,retained.raw);
 }
});
test("G2: a partial readback never reports successful retention",async()=>{
 const f=await fixture(),pipeline=f.runtime.pipeline!;let altered=false;
 const runtime={...f.runtime,pipeline:async(commands:(string|number)[][])=>{
  const reply=await pipeline(commands);
  if(!altered&&commands.length===3&&commands[0][0]==="TYPE"){altered=true;return [...reply,null];}
  return reply;
 }};
 assert.deepEqual(await reserve(f.receipt,runtime),{ok:false});
 assert.ok(await origin.readDigitalOptionRetention(origin.confirmationOriginId(f.store.statsId!,f.request.nonce),f.runtime));
 assert.ok((await reserve(f.receipt,f.runtime)).ok);
});
