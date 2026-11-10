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
test("digital option retention needs its own complete funding scope before IO",async()=>{
 const f=await fixture();
 assert.deepEqual(await reserve(f.receipt,{pipeline:f.runtime.pipeline}),{ok:false});assert.equal(f.commands.length,0);
 for(const coveredOrigins of [undefined,["physical-option-confirmation"],["course-confirmation"],["single-digital-confirmation"]] as const){
  assert.deepEqual(await reserve(f.receipt,{...f.runtime,policy:{...f.runtime.policy!,coveredOrigins:coveredOrigins?[...coveredOrigins]:undefined}}),{ok:false});
 }
 for(const patch of [{digitalOptionRetentionEvidence:undefined},{digitalOptionRetentionEvidence:" "},{ongoingStorageFunded:false},{maxPayloadBytes:1},{storeBytes:1},{admissionsUntil:1}]){
  assert.deepEqual(await reserve(f.receipt,{...f.runtime,policy:{...f.runtime.policy!,...patch}}),{ok:false});
 }
 assert.equal(f.commands.some(c=>c[0]==="EVAL"),false);assert.ok(shipmentMailPolicy(f.runtime.policy));
});
test("only the actual private prepared receipt supplies original values",async()=>{
 const f=await fixture();let traps=0;
 const proxy=new Proxy(f.receipt,{get(){traps++;throw Error("No executable input");},getPrototypeOf(){traps++;throw Error("No reflection");}});
 for(const receipt of [JSON.parse(JSON.stringify(f.receipt)),{...f.receipt},proxy,null])assert.deepEqual(await reserve(receipt,f.runtime),{ok:false});
 assert.equal(traps,0);assert.equal(f.commands.length,0);
});
test("a sealed immutable option source is retained without polling or payment authority",async()=>{
 const f=await fixture(),result=await reserve(f.receipt,f.runtime);assert.ok(result.ok);
 assert.deepEqual([result.admitted,result.permitsCheckout,result.grantsAccess],[false,false,false]);
 const saved=await origin.readDigitalOptionRetention(result.id,f.runtime);assert.ok(saved);
 assert.equal(saved.row.phase,"digital_option_reserved");assert.equal(saved.row.originKind,"digital_option");
 assert.equal(saved.row.next,0);assert.equal(saved.row.session,"");
 assert.equal(saved.payload.body,f.request.body);assert.equal(saved.payload.snapshot.selected.selected.file.pathname,f.request.product.options[0].file.pathname);
 assert.equal(saved.raw.includes("Book.pdf"),false);
 assert.equal(redis.run(["TTL",origin.confirmationOriginRowKey(result.id)]),-1);
 assert.equal(redis.run(["TTL",`nl:order-confirmation:source:${result.id}`]),-1);
 assert.equal(redis.run(["ZSCORE",origin.CONFIRMATION_ORIGIN_DUE,result.id]),null);
 assert.deepEqual(await reserve(f.receipt,f.runtime),result);
 f.request.product.options[0].file.pathname="stores/changed/edition01/another.pdf";
 assert.equal((await origin.readDigitalOptionRetention(result.id,f.runtime))?.raw,saved.raw);
 assert.equal((await origin.readDigitalOptionRetention(result.id,{...f.runtime,now:()=>f.receipt.expiresAtMs+73*3600000}))?.raw,saved.raw);
 let provider=0,dispatch=0;const runtime={...f.runtime,provider:async()=>{provider++;throw Error("Closed");}};
 const before=f.commands.length;
 assert.equal(await origin.readConfirmationOrigin(result.id,runtime),null);assert.equal(await origin.claimConfirmationCreation(result.id,runtime),null);assert.equal(await origin.openConfirmationOrigin(result.id,runtime),null);
 await origin.runOrderConfirmationMail(Date.now()+10000,async()=>{dispatch++;return "accepted";},runtime,result.id);
 assert.equal(provider,0);assert.equal(dispatch,0);assert.equal(f.commands.slice(before).some(c=>c[0]==="EVAL"),false);
});
test("lost enqueue acknowledgement keeps the original source and cannot replace its file",async()=>{
 const f=await fixture(),pipeline=f.runtime.pipeline!;let lost=false;
 f.runtime.pipeline=async commands=>{const reply=await pipeline(commands);if(!lost&&commands.some(c=>c[0]==="EVAL")){lost=true;throw Error("Committed, ACK lost");}return reply;};
 assert.deepEqual(await reserve(f.receipt,f.runtime),{ok:false});
 const result=await reserve(f.receipt,f.runtime);assert.ok(result.ok);const first=await origin.readDigitalOptionRetention(result.id,f.runtime);assert.ok(first);
 f.request.product.options[0].file.pathname=`stores/${f.request.folder}/edition01/substituted.pdf`;
 const admission=await admitOrders(f.store,1);assert.ok(admission.ok);
 const replacement=await prepareDigitalOptionPreintent({...f.request,admission});assert.ok(replacement);
 assert.deepEqual(await reserve(replacement,f.runtime),{ok:false});assert.equal((await origin.readDigitalOptionRetention(result.id,f.runtime))?.raw,first.raw);
});
test("an enqueue-looking response without a persisted winner cannot report success",async()=>{
 const f=await fixture(),pipeline=f.runtime.pipeline!;
 f.runtime.pipeline=async commands=>commands.some(c=>c[0]==="EVAL")?[["queued",commands[0][15]]]:pipeline(commands);
 assert.deepEqual(await reserve(f.receipt,f.runtime),{ok:false});
});

for(const afterExpiryMs of [0,1])test(`confirmed retention remains evidence when its receipt expires after EVAL (+${afterExpiryMs}ms)`,async t=>{
 const f=await fixture(),pipeline=f.runtime.pipeline!;let wrote=false;
 f.runtime.pipeline=async commands=>{
  const reply=await pipeline(commands);
  if(commands.some(c=>c[0]==="EVAL")){
   assert.equal(wrote,false);wrote=true;
   t.mock.method(Date,"now",()=>f.receipt.expiresAtMs+afterExpiryMs);
  }
  return reply;
 };
 const result=await reserve(f.receipt,f.runtime);
 assert.ok(wrote);assert.ok(result.ok,"the immutable persisted winner confirms retention after its receipt expires");
 assert.deepEqual([result.admitted,result.permitsCheckout,result.grantsAccess],[false,false,false]);
 const saved=await origin.readDigitalOptionRetention(result.id,f.runtime);assert.ok(saved);
 assert.equal(saved.row.expiresAt,f.receipt.expiresAtMs);assert.equal(saved.row.phase,"digital_option_reserved");
 assert.equal(saved.payload.body,f.request.body);
 assert.equal(f.commands.filter(c=>c[0]==="EVAL").length,1);
 const before=f.commands.length;
 assert.deepEqual(await reserve(f.receipt,f.runtime),{ok:false},"an expired receipt cannot start another reservation");
 assert.equal(f.commands.length,before);
 assert.equal(await origin.readConfirmationOrigin(result.id,f.runtime),null);
});

test("a receipt already expired before reservation cannot spend or write",async t=>{
 const f=await fixture();t.mock.method(Date,"now",()=>f.receipt.expiresAtMs);
 assert.deepEqual(await reserve(f.receipt,f.runtime),{ok:false});assert.equal(f.commands.length,0);
});

test("an unknown local clock after the server read cannot create a new retained liability",async()=>{
 const f=await fixture(),pipeline=f.runtime.pipeline!;
 f.runtime.pipeline=async commands=>{const reply=await pipeline(commands);if(commands.some(c=>c[0]==="TIME"))f.runtime.now=()=>NaN;return reply;};
 assert.deepEqual(await reserve(f.receipt,f.runtime),{ok:false});assert.equal(f.commands.some(c=>c[0]==="EVAL"),false);
});
test("retained option sources follow the existing erasure protocol",async()=>{
 const f=await fixture(),result=await reserve(f.receipt,f.runtime);assert.ok(result.ok);
 assert.equal(await origin.forgetOrderConfirmationMail(f.store.statsId,undefined,f.runtime),1);
 assert.equal(await origin.readDigitalOptionRetention(result.id,f.runtime),null);
 assert.ok(Number(redis.run(["TTL",`nl:order-confirmation:source:${result.id}`]))>399*86400);
});
test("actual shared Lua retains one immutable option winner and charges it once",{skip:process.env.MARKTMORGEN_REDIS_INTEGRATION!=="1"||!process.env.CONFIRMATION_ORIGIN_REDIS_PORT},async()=>{
 const f=await fixture(),commands:(string|number)[][]=[];
 f.runtime.pipeline=async batch=>{commands.push(...batch);return confirmationLocalPipeline(batch);};
 let keys:string[]=[];
 try{
  const results=await Promise.all(Array.from({length:16},()=>reserve(f.receipt,f.runtime)));assert.ok(results.every(r=>r.ok));
  const result=results[0];assert.ok(result.ok);
  const enqueue=commands.find(c=>c[0]==="EVAL"&&c[1]===SHIPMENT_MAIL_SCRIPT);assert.ok(enqueue);keys=enqueue.slice(3,13).map(String);
  const saved=await origin.readDigitalOptionRetention(result.id,f.runtime);assert.ok(saved);
  assert.deepEqual(await confirmationLocalPipeline([["HGET",keys[5],"items"],["HGET",keys[6],"items"],["TTL",keys[0]],["TTL",keys[1]],["ZSCORE",keys[2],result.id]]),["1","1",-1,-1,null]);
  for(const op of ["claim","dispatch","accepted","defer"]){
   assert.deepEqual(await confirmationLocalPipeline([["EVAL",SHIPMENT_MAIL_SCRIPT,10,...keys,op,saved.raw,"",Date.now(),131072,JSON.stringify(f.runtime.policy),"a".repeat(48)]]),[["unknown"]]);
  }
  assert.equal(await origin.forgetOrderConfirmationMail(f.store.statsId,undefined,f.runtime),1);
  assert.deepEqual(await confirmationLocalPipeline([["HGET",keys[5],"items"],["GET",keys[0]]]),["0",null]);
 }finally{if(keys.length)await confirmationLocalPipeline([["DEL",...keys]]);}
});
