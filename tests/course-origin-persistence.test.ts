import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import * as origin from "@/lib/order-confirmation-outbox";
import {prepareCourseOriginBinding} from "@/lib/course-origin-binding";
import {admitOrders} from "@/lib/order-admission";
import {shipmentMailPolicy} from "@/lib/shipment-mail-outbox";
import type {Store} from "@/lib/store";
import {store as redis} from "./redis-stub";
import {courseCandidateWorld} from "./order-confirmation-course-world";
import {shipmentOutboxFixture,shipmentPolicy} from "./shipment-mail-outbox-fixture";

process.env.NIMBUS_DATA_KEY="SYNTHETIC_ONLY_course_origin_persistence_key_2026";
globalThis.fetch=async()=>{throw Error("No external provider in course persistence proof");};
async function fixture(){
 redis.clear();const world=courseCandidateWorld(),now=Date.now();
 const store={...world.store,extra:false,shared:false,subscriptionActive:true,subscriptionId:"sub_SyntheticCoursePersistence",
  trialEnds:0,tier:"creator",planEndedAt:"",cycle:"month",period:{start:Math.floor(now/1000)-86400,end:Math.floor(now/1000)+86400,renews:true}} as Store;
 const pipeline=redis.pipeline;let admission;
 try{redis.pipeline=async()=>[1];admission=await admitOrders(store,1,now,1);}finally{redis.pipeline=pipeline;}
 assert.ok(admission.ok);
 const metadata={...world.metadata,mm_admit:String(admission.hour)},nonce="e".repeat(64);
 const form=new URLSearchParams({mode:"payment","line_items[0][quantity]":"1",
  "line_items[0][price_data][currency]":store.currency,"line_items[0][price_data][unit_amount]":String(world.product.priceCents),
  "line_items[0][price_data][product_data][name]":world.product.title,
  ...Object.fromEntries(Object.entries(metadata).map(([k,v])=>[`metadata[${k}]`,v])),
  "metadata[mm_order_intent]":nonce,"metadata[mm_order_origin]":"course-v1"});
 form.set("metadata[mm_order_hash]",origin.confirmationBodyDigest(form.toString()));
 const selected={store,product:world.product,metadata,body:form.toString(),nonce,admission};
 const issued=await prepareCourseOriginBinding(selected);assert.ok(issued);
 const ack=shipmentOutboxFixture(),commands:(string|number)[][]=[];
 let lose=false;
 const runtime={lifecycle:"active" as const,policy:{...shipmentPolicy(now),coveredOrigins:["course-confirmation" as const]},now:()=>now,
  pipeline:async(batch:(string|number)[][])=>{
   commands.push(...batch);const answers=[];
   for(const c of batch){
    if(c[0]==="TIME"){answers.push([String(Math.floor(now/1000)),String(now%1000*1000)]);continue;}
    const reply=await ack.pipeline([c]);if(lose&&c[0]==="EVAL"){lose=false;throw Error("Lost durable enqueue ACK");}answers.push(...reply);
   }
   return answers;
  }};
 return {selected,issued,runtime,commands,loseNext:()=>{lose=true;},input:{bindingToken:issued.token,nonce}};
}
const closed={admitted:false,permitsCheckout:false,grantsAccess:false};
test("a course requires explicit coverage in the existing storage review, with no default IO",async()=>{
 const f=await fixture();
 assert.deepEqual(await origin.reserveCourseConfirmationOrigin(f.input,{pipeline:f.runtime.pipeline}),{ok:false});assert.equal(f.commands.length,0);
 assert.deepEqual(await origin.reserveCourseConfirmationOrigin(f.input,{...f.runtime,policy:shipmentPolicy(Date.now())}),{ok:false});assert.equal(f.commands.length,0);
 assert.ok(shipmentMailPolicy(f.runtime.policy));
});
test("the protected immutable course winner is recovered after lost ACK without a new source",async()=>{
 const f=await fixture();f.loseNext();assert.deepEqual(await origin.reserveCourseConfirmationOrigin(f.input,f.runtime),{ok:false});
 const result=await origin.reserveCourseConfirmationOrigin(f.input,f.runtime);assert.equal(result.ok,true);
 assert.ok(result.ok);assert.deepEqual({...closed,admitted:result.admitted,permitsCheckout:result.permitsCheckout,grantsAccess:result.grantsAccess},closed);
 const saved=await origin.readCourseConfirmationOrigin(result.id,f.runtime);assert.ok(saved);
 assert.equal(saved.binding.token,f.issued.token);assert.equal(saved.binding.fingerprint,createHash("sha256").update(f.issued.token).digest("hex"));
 assert.equal(saved.binding.candidate.identity.courseId,f.selected.product.course.id);
 assert.deepEqual(Object.keys(saved.payload.snapshot),["selected"]);
 assert.equal(JSON.stringify(saved.payload.snapshot.selected),JSON.stringify(saved.binding.candidate));
 assert.equal(saved.row.phase,"course_reserved");assert.equal(saved.row.created,f.runtime.now());
 assert.equal(redis.run(["TTL",origin.confirmationOriginRowKey(result.id)]),-1);
 assert.equal(redis.run(["TTL",`nl:order-confirmation:source:${result.id}`]),-1);
 const originalRaw=saved.raw,originalFingerprint=saved.row.courseBindingFingerprint;
 const alternative=await prepareCourseOriginBinding(f.selected);assert.ok(alternative);assert.notEqual(alternative.token,f.issued.token);
 assert.deepEqual(await origin.reserveCourseConfirmationOrigin({...f.input,bindingToken:alternative.token},f.runtime),{ok:false});
 assert.equal((await origin.readCourseConfirmationOrigin(result.id,f.runtime))?.raw,originalRaw);
 assert.equal((await origin.readCourseConfirmationOrigin(result.id,{...f.runtime,now:()=>f.issued.expiresAtMs+73*3600000}))?.row.courseBindingFingerprint,originalFingerprint);
});
test("course reservation cannot become physical checkout, worker, payment or email permission",async()=>{
 const f=await fixture(),result=await origin.reserveCourseConfirmationOrigin(f.input,f.runtime);assert.ok(result.ok);
 const before=f.commands.length;let provider=0,dispatch=0;
 const runtime={...f.runtime,provider:async()=>{provider++;throw Error("No course provider stage implemented");}};
 assert.equal(await origin.readConfirmationOrigin(result.id,runtime),null);
 assert.equal(await origin.claimConfirmationCreation(result.id,runtime),null);
 assert.equal(await origin.openConfirmationOrigin(result.id,runtime),null);
 await origin.runOrderConfirmationMail(f.runtime.now()+10000,async()=>{dispatch++;return "accepted";},runtime,result.id);
 assert.equal(provider,0);assert.equal(dispatch,0);
 assert.equal(f.commands.slice(before).some(c=>c[0]==="EVAL"),false,"unsupported stages must stop before mutation");
 const snapshot={store:{...f.selected.store,sid:"d".repeat(32)},product:f.selected.product};
 assert.deepEqual(await origin.reserveCourseConfirmationOrigin({...f.input,snapshot},f.runtime),{ok:false});
});

test("an issuer-selected original store name cannot be replaced before persistence",async()=>{
 const f=await fixture();const snapshot={store:{...f.selected.store,name:"Changed after issuance"},product:f.selected.product};
 assert.deepEqual(await origin.reserveCourseConfirmationOrigin({...f.input,snapshot},f.runtime),{ok:false});
 assert.equal(f.commands.length,0);
});
test("course financial coverage is own bounded data, with no inherited or executable permission",async()=>{
 const f=await fixture();let getters=0;
 for(const value of [[],["course-confirmation","course-confirmation"],["future"],Object.assign(new Array(1),{}),Object.create(["course-confirmation"])]){
  assert.equal(shipmentMailPolicy({...f.runtime.policy,coveredOrigins:value}),null);
 }
 const accessor=["course-confirmation"];Object.defineProperty(accessor,"0",{get(){getters++;return "course-confirmation";}});
 assert.equal(shipmentMailPolicy({...f.runtime.policy,coveredOrigins:accessor}),null);assert.equal(getters,0);
 const policy=Object.create({coveredOrigins:["course-confirmation"]});Object.assign(policy,shipmentPolicy(Date.now()));
 assert.deepEqual(await origin.reserveCourseConfirmationOrigin(f.input,{...f.runtime,policy}),{ok:false});assert.equal(f.commands.length,0);
});
test("foreign, malformed and forged selected origins fail before persistence IO",async()=>{
 for(const which of ["nonce","token","stats","account","course","product","getter"]){
  const f=await fixture();let getters=0;
  if(which==="nonce")f.input.nonce="d".repeat(64);
  if(which==="token")f.input.bindingToken="s1.not-a-course-proof";
  const snapshot={store:{...f.selected.store},product:{...f.selected.product,course:{...f.selected.product.course}}};
  if(which==="stats")snapshot.store.statsId="f".repeat(32);
  if(which==="account")snapshot.store.stripeAccountId="acct_ForeignCourse01";
  if(which==="course")snapshot.product.course.id="f".repeat(32);
  if(which==="product")snapshot.product.id="another-original-product";
  if(which==="getter")Object.defineProperty(f.input,"bindingToken",{get(){getters++;return f.issued.token;}});
  assert.deepEqual(await origin.reserveCourseConfirmationOrigin(["stats","account","course","product"].includes(which)?{...f.input,snapshot}:f.input,f.runtime),{ok:false},which);
  assert.equal(getters,0);assert.equal(f.commands.length,0,which);
 }
});
test("a course body cannot downgrade through the unchanged physical producer",async()=>{
 const f=await fixture();const {openCourseOriginBinding}=await import("@/lib/course-origin-binding");
 const binding=openCourseOriginBinding(f.issued.token,f.issued.nonce);assert.ok(binding);
 assert.deepEqual(await origin.reserveConfirmationOrigin({statsId:f.selected.store.statsId,nonce:binding.nonce,accountId:f.selected.store.stripeAccountId!,body:binding.body,preintent:binding.preintent,snapshot:{store:f.selected.store,product:f.selected.product}},f.runtime),{ok:false});
 assert.equal(f.commands.length,0);
});
test("an enqueue-looking ACK with no persisted winner cannot report a durable course",async()=>{
 const f=await fixture(),pipeline=f.runtime.pipeline;
 const runtime={...f.runtime,pipeline:async(commands:(string|number)[][])=>{
  if(commands[0]?.[0]==="EVAL")return [["queued",String(commands[0][15])]];
  return pipeline(commands);
 }};
 assert.deepEqual(await origin.reserveCourseConfirmationOrigin(f.input,runtime),{ok:false});
 assert.equal([...redis.keys()].some(k=>k.startsWith("nl:order-confirmation:row:")),false);
});

test("an unsigned replacement accounting or mixed product snapshot is not accepted as the selected source",async()=>{
 for(const change of ["tier","period","mixed-course"]){
  const f=await fixture();
  const snapshot={store:{...f.selected.store},product:{...f.selected.product}};
  if(change==="tier")snapshot.store.tier="scale";
  if(change==="period")snapshot.store.period={...snapshot.store.period!,start:1,end:2};
  if(change==="mixed-course")Object.assign(snapshot.product,{call:{minutes:30}});
  assert.deepEqual(await origin.reserveCourseConfirmationOrigin({...f.input,snapshot},f.runtime),{ok:false},change);
  assert.equal(f.commands.length,0);
 }
});

test("real Redis Lua stores and erases an issuer-authenticated reserve-only course",{skip:process.env.MARKTMORGEN_REDIS_INTEGRATION!=="1"},async()=>{
 const {confirmationLocalPipeline}=await import("./order-confirmation-paid-fixture");
 const f=await fixture(),commands:(string|number)[][]=[];
 const runtime={...f.runtime,now:Date.now,pipeline:async(batch:(string|number)[][])=>{commands.push(...batch);return confirmationLocalPipeline(batch);}};
 let id="";
 try{
  const result=await origin.reserveCourseConfirmationOrigin(f.input,runtime);assert.ok(result.ok);id=result.id;
  const saved=await origin.readCourseConfirmationOrigin(id,runtime);assert.ok(saved);
  assert.equal(saved.binding.token,f.issued.token);assert.equal(saved.payload.preintentToken,saved.binding.preintent.token);
  assert.equal(saved.row.next,0);
  assert.deepEqual(await confirmationLocalPipeline([["ZSCORE",origin.CONFIRMATION_ORIGIN_DUE,id]]),[null],"reserve-only course has no worker stage to poll");
  assert.equal(JSON.stringify(saved.payload.snapshot),JSON.stringify({selected:saved.binding.candidate}));
  assert.deepEqual(await confirmationLocalPipeline([["TTL",origin.confirmationOriginRowKey(id)],["TTL",`nl:order-confirmation:source:${id}`]]),[-1,-1]);
  const before=commands.length;
  assert.equal(await origin.claimConfirmationCreation(id,runtime),null);
  assert.equal(commands.slice(before).some(c=>c[0]==="EVAL"),false);
  assert.equal(await origin.forgetOrderConfirmationMail(f.selected.store.statsId,undefined,runtime),1);
  assert.deepEqual(await confirmationLocalPipeline([["EXISTS",origin.confirmationOriginRowKey(id)]]),[0]);
  const [ttl]=await confirmationLocalPipeline([["TTL",`nl:order-confirmation:source:${id}`]]);assert.ok(Number(ttl)>399*86400);
 }finally{
  if(id){
   const localKeys=new Set<string>();
   for(const c of commands)if(c[0]==="EVAL")for(const k of c.slice(3,3+Number(c[2])).map(String))if(k.includes(f.selected.store.statsId!)||k.includes(id))localKeys.add(k);
   if(localKeys.size)await confirmationLocalPipeline([["DEL",...localKeys]]);
  }
 }
});
