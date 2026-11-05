import assert from "node:assert/strict";
import {test} from "node:test";
import {prepareCourseOriginBinding,openCourseOriginBinding} from "@/lib/course-origin-binding";
import {confirmationBodyDigest} from "@/lib/order-confirmation-outbox";
import {captureCourseConfirmationCandidate,courseConfirmationConstructionState} from "@/lib/course-confirmation-origin";
import {admitOrders} from "@/lib/order-admission";
import {unseal} from "@/lib/secret-box";
import type {Store} from "@/lib/store";
import {store as redis} from "./redis-stub";
import {courseCandidateWorld} from "./order-confirmation-course-world";
import {DIGITAL_CONSENT_WORDS} from "@/lib/buyer-words/digital-consent";

process.env.NIMBUS_DATA_KEY="SYNTHETIC_ONLY_course_origin_binding_key_2026";
globalThis.fetch=async()=>{throw Error("No provider may be called in course binding tests");};
async function fixture(){
 redis.clear();const world=courseCandidateWorld(),at=Date.now()-1000;
 const store={...world.store,extra:false,shared:false,subscriptionActive:true,subscriptionId:"sub_SyntheticCourseBinding",
  trialEnds:0,tier:"creator",planEndedAt:"",cycle:"month",period:{start:Math.floor(at/1000)-86400,end:Math.floor(at/1000)+86400,renews:true}} as Store;
 const pipeline=redis.pipeline;let admission;
 try{redis.pipeline=async()=>[1];admission=await admitOrders(store,1,at,1);}finally{redis.pipeline=pipeline;}
 assert.ok(admission.ok);
 const metadata={...world.metadata,mm_admit:String(admission.hour)},nonce="c".repeat(64);
 const form=new URLSearchParams({mode:"payment","line_items[0][quantity]":"1",
  "line_items[0][price_data][currency]":store.currency,"line_items[0][price_data][unit_amount]":String(world.product.priceCents),
  "line_items[0][price_data][product_data][name]":world.product.title,
  ...Object.fromEntries(Object.entries(metadata).map(([k,v])=>[`metadata[${k}]`,v])),
  "metadata[mm_order_intent]":nonce,"metadata[mm_order_origin]":"course-v1",
  success_url:"https://example.test/thanks?session_id={CHECKOUT_SESSION_ID}",cancel_url:"https://example.test/cancel"});
 form.set("metadata[mm_order_hash]",confirmationBodyDigest(form.toString()));
 return {input:{store,product:world.product,metadata,body:form.toString(),nonce,admission},at};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function rehash(f:Fixture,change:(form:URLSearchParams)=>void){const form=new URLSearchParams(f.input.body);change(form);form.set("metadata[mm_order_hash]",confirmationBodyDigest(form.toString()));f.input.body=form.toString();}
function closed(value:{admitted:boolean;permitsCheckout:boolean;grantsAccess:boolean}){assert.equal(value.admitted,false);assert.equal(value.permitsCheckout,false);assert.equal(value.grantsAccess,false);}

test("genuine admission issues an authenticated original snapshot, never a checkout/payment capability",async()=>{
 const f=await fixture(),pipeline=redis.pipeline;let calls=0;
 redis.pipeline=async()=>{calls++;throw Error("Issuer cannot perform Redis IO");};
 try{
  const token=await prepareCourseOriginBinding(f.input);assert.ok(token);closed(token);assert.equal(calls,0);
  const binding=openCourseOriginBinding(token.token,token.nonce);assert.ok(binding);closed(binding);
  assert.equal(binding.authority,"selected-snapshot-only");assert.equal(binding.candidate.identity.sid,f.input.store.sid);
  assert.equal(binding.candidate.identity.statsId,f.input.store.statsId);assert.equal(binding.candidate.identity.courseId,f.input.product.course.id);
  assert.equal(binding.body,f.input.body);assert.equal(binding.expiresAtMs,token.expiresAtMs);
  const proof=unseal(binding.preintent.token,`order-confirmation-preintent|${token.nonce}`);assert.ok(proof.ok);
  assert.equal(binding.expiresAtMs,JSON.parse(proof.value).original.until);
  assert.equal(binding.bodyDigest,confirmationBodyDigest(f.input.body));
  assert.deepEqual(courseConfirmationConstructionState(),{admitted:false,accessReview:null,fundingReview:null});
  assert.ok(Object.isFrozen(binding)&&Object.isFrozen(binding.candidate.identity));
 }finally{redis.pipeline=pipeline;}
});

test("boolean/clone/foreign admissions cannot produce a signed course binding",async()=>{
 for(const kind of ["boolean","clone","owner","account"]){
  const f=await fixture();
  if(kind==="boolean")f.input.admission={ok:true,hour:0};
  if(kind==="clone")f.input.admission={...f.input.admission};
  if(kind==="owner")f.input.store.email="other-owner@example.test";
  if(kind==="account")f.input.store.stripeAccountId="acct_ForeignCourse01";
  assert.equal(await prepareCourseOriginBinding(f.input),null,kind);
 }
});

test("the reader rejects changed token/context and expired or pre-capture time",async()=>{
 const f=await fixture(),token=await prepareCourseOriginBinding(f.input);assert.ok(token);
 // Change significant ciphertext bits, not a last base64url padding alias.
 const start=token.token.lastIndexOf(".")+1,changed=token.token[start]==="A"?"B":"A";
 assert.equal(openCourseOriginBinding(token.token.slice(0,start)+changed+token.token.slice(start+1),token.nonce),null);
 assert.equal(openCourseOriginBinding(token.token,"d".repeat(64)),null);
 assert.equal(openCourseOriginBinding(token.token,token.nonce,token.expiresAtMs),null);
 assert.equal(openCourseOriginBinding(token.token,token.nonce,f.at-1),null);
 assert.equal(openCourseOriginBinding("x".repeat(16_385),token.nonce),null);
});

test("canonical one-course price/currency/consent/nonce/hour must match exactly",async()=>{
 for(const [key,value]of [["mode","subscription"],["line_items[0][quantity]","2"],["line_items[0][price_data][unit_amount]","1"],
  ["line_items[0][price_data][currency]","eur"],["metadata[store]","other-store"],["metadata[product]","other-product"],
  ["metadata[dc]","no"],["metadata[mm_order_intent]","d".repeat(64)],["metadata[mm_admit]","0"],
  ["metadata[mm_order_origin]","physical-v1"],["line_items[1][quantity]","1"],["discounts[0][coupon]","a-coupon"]]){
  const f=await fixture();rehash(f,form=>form.set(key,value));assert.equal(await prepareCourseOriginBinding(f.input),null,key);
 }
 const duplicate=await fixture();rehash(duplicate,form=>form.append("mode","payment"));assert.equal(await prepareCourseOriginBinding(duplicate.input),null);
 const malformed=await fixture();malformed.input.body+="&";assert.equal(await prepareCourseOriginBinding(malformed.input),null);
 const wrongHash=await fixture();wrongHash.input.body=wrongHash.input.body.replace(/metadata%5Bmm_order_hash%5D=[^&]+/,"metadata%5Bmm_order_hash%5D="+"0".repeat(64));assert.equal(await prepareCourseOriginBinding(wrongHash.input),null);
 const hour=await fixture();hour.input.metadata.mm_admit="0";rehash(hour,form=>form.set("metadata[mm_admit]","0"));assert.equal(await prepareCourseOriginBinding(hour.input),null,"even matching caller hour must match private admission");
});

test("mutating caller data across the hash await cannot change the authenticated snapshot",async()=>{
 const f=await fixture(),original={sid:f.input.store.sid,stats:f.input.store.statsId,course:f.input.product.course.id,body:f.input.body,price:f.input.product.priceCents,title:f.input.product.title,dc:f.input.metadata.dc};
 const pending=prepareCourseOriginBinding(f.input);
 f.input.store.sid="f".repeat(32);f.input.store.statsId="e".repeat(32);f.input.store.period!.end=1;
 f.input.product.course.id="1".repeat(32);f.input.product.priceCents=1;f.input.product.title="Changed after capture";
 f.input.metadata.dc="no";f.input.body="changed";f.input.nonce="2".repeat(64);
 const token=await pending;assert.ok(token);const opened=openCourseOriginBinding(token.token,token.nonce);assert.ok(opened);
 assert.deepEqual([opened.candidate.identity.sid,opened.candidate.identity.statsId,opened.candidate.identity.courseId,opened.body,opened.candidate.original.priceCents,opened.candidate.original.title,opened.candidate.metadata.dc],
  [original.sid,original.stats,original.course,original.body,original.price,original.title,original.dc]);
});

test("selected fields are own data; getter/JSON hooks do not execute",async()=>{
 let getters=0;
 for(const which of ["body","store","period","course","metadata"]){
  const f=await fixture();
  if(which==="body")Object.defineProperty(f.input,"body",{get(){getters++;return "";}});
  if(which==="store")Object.defineProperty(f.input.store,"sid",{get(){getters++;return "a".repeat(32);}});
  if(which==="period")Object.defineProperty(f.input.store.period!,"start",{get(){getters++;return 1;}});
  if(which==="course")Object.defineProperty(f.input.product.course,"id",{get(){getters++;return "d".repeat(32);}});
  if(which==="metadata")Object.defineProperty(f.input.metadata,"dc",{get(){getters++;return "no";}});
  assert.equal(await prepareCourseOriginBinding(f.input),null,which);
 }
 assert.equal(getters,0);
 const f=await fixture();Object.defineProperty(f.input.store,"toJSON",{get(){getters++;throw Error("JSON hook");}});
 const token=await prepareCourseOriginBinding(f.input);assert.ok(token);assert.ok(openCourseOriginBinding(token.token,token.nonce));assert.equal(getters,0);
});

test("unsupported rights and oversized snapshots cannot be signed or silently reduced",async()=>{
 for(const mutate of [(f:Fixture)=>f.input.product.priceCents=0,(f:Fixture)=>f.input.product.title="x".repeat(1001),
  (f:Fixture)=>f.input.product.options.push({} as never),(f:Fixture)=>f.input.body="x".repeat(16_385),
  (f:Fixture)=>Object.setPrototypeOf(f.input.metadata,{dc:f.input.metadata.dc})]){
  const f=await fixture();mutate(f);assert.equal(await prepareCourseOriginBinding(f.input),null);
 }
});

test("one admission binds one original body; signatures are not an immutable CAS winner",async()=>{
 const f=await fixture(),first=await prepareCourseOriginBinding(f.input);assert.ok(first);
 const second=await prepareCourseOriginBinding(f.input);assert.ok(second);assert.notEqual(first.token,second.token);
 const a=openCourseOriginBinding(first.token,first.nonce),b=openCourseOriginBinding(second.token,second.nonce);assert.ok(a&&b);closed(a);closed(b);assert.equal(a.bodyDigest,b.bodyDigest);
 rehash(f,form=>form.set("locale","en"));assert.equal(await prepareCourseOriginBinding(f.input),null);
});

test("a new issuer-selected identity is sealed, not a claim that caller data came from a database",async()=>{
 const f=await fixture();f.input.store.sid="e".repeat(32);f.input.product.course.id="f".repeat(32);
 const token=await prepareCourseOriginBinding(f.input);assert.ok(token);
 const opened=openCourseOriginBinding(token.token,token.nonce);assert.ok(opened);assert.equal(opened.authority,"selected-snapshot-only");
 assert.equal(opened.candidate.identity.sid,"e".repeat(32));assert.equal(opened.candidate.identity.courseId,"f".repeat(32));closed(opened);
 // A producer must obtain these selected values from its trusted server reads.
 assert.ok(captureCourseConfirmationCandidate(f.input.store,f.input.product,f.input.metadata));
});

test("an authenticated historical consent snapshot survives later changes to current wording",async()=>{
 const f=await fixture(),token=await prepareCourseOriginBinding(f.input);assert.ok(token);
 const original=openCourseOriginBinding(token.token,token.nonce);assert.ok(original);
 const words=DIGITAL_CONSENT_WORDS.en,box=words.box.digital,line=words.email.now;
 try{
  words.box.digital="New wording after this order was captured.";
  words.email.now=()=>"A later confirmation template must not replace original text.";
  const recovered=openCourseOriginBinding(token.token,token.nonce);assert.ok(recovered);
  assert.deepEqual(recovered.candidate.consent,original.candidate.consent);
  assert.equal(recovered.candidate.captureFingerprint,original.candidate.captureFingerprint);
 }finally{words.box.digital=box;words.email.now=line;}
});

test("a preexisting inherited JSON hook neither executes nor issues a new binding",async()=>{
 const f=await fixture(),token=await prepareCourseOriginBinding(f.input);assert.ok(token);
 const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,"toJSON");let hooks=0,issued,opened;
 try{
  Object.defineProperty(Object.prototype,"toJSON",{configurable:true,get(){hooks++;return undefined;}});
  issued=await prepareCourseOriginBinding(f.input);
  opened=openCourseOriginBinding(token.token,token.nonce);
 }finally{
  if(descriptor)Object.defineProperty(Object.prototype,"toJSON",descriptor);else Reflect.deleteProperty(Object.prototype,"toJSON");
 }
 assert.equal(hooks,0);assert.equal(issued,null);assert.ok(opened);
});
