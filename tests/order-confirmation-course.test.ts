import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { captureCourseConfirmationCandidate, courseConfirmationConstructionState, resolveCourseDoorCandidate } from "@/lib/course-confirmation-origin";
import { GET } from "@/app/open/[sid]/course/[product]/route";
import { CONSENT_WORDS_FINGERPRINT } from "@/lib/digital-consent";
import { DIGITAL_CONSENT_WORDS } from "@/lib/buyer-words/digital-consent";
import { courseCandidateWorld, realCourseCandidateWorld } from "./order-confirmation-course-world";
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("a course candidate captures original identity and quoted consent but is never admitted or authenticated",()=>{
  const f=courseCandidateWorld(),candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);assert.ok(candidate);
  assert.equal(candidate.kind,"course-v1-candidate");assert.equal(candidate.admitted,false);assert.equal(candidate.provenance,"unverified-producer-input");
  assert.deepEqual(candidate.identity,{sid:f.store.sid,statsId:f.store.statsId,accountId:f.store.stripeAccountId,productId:f.product.id,courseId:f.product.course.id});
  assert.equal(candidate.consent.metadata,f.metadata.dc);assert.equal(candidate.consent.wordsFingerprint,CONSENT_WORDS_FINGERPRINT);
  assert.equal(candidate.consent.checkedSentence,DIGITAL_CONSENT_WORDS.en.box.digital);assert.ok(candidate.consent.emailLines[1].includes(candidate.consent.version));
  assert.equal(candidate.publicPath,`/open/${f.store.sid}/course/${f.product.id}?course=${f.product.course.id}`);
  assert.equal(/token|session_id|email=|pass=/.test(candidate.publicPath),false);
  assert.equal(Object.isFrozen(candidate),true);assert.equal(Object.isFrozen(candidate.identity),true);assert.equal(Object.isFrozen(candidate.consent.emailLines),true);
  assert.deepEqual(courseConfirmationConstructionState(),{admitted:false,accessReview:null,fundingReview:null});
});

test("arbitrarily late candidates retain the original title, currency, language and literal consent",()=>{
  const f=courseCandidateWorld(),candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);assert.ok(candidate);const original=JSON.stringify(candidate);
  const realNow=Date.now;try{Date.now=()=>realNow()+5000*86_400_000;
    f.store.name="Changed store";f.store.currency="eur";f.store.language="de";f.product.title="Changed course";f.metadata.dc="yes:2099-01-01.1:m:1999999999";
    assert.equal(JSON.stringify(candidate),original);assert.equal(candidate.original.title,"Original course title");assert.equal(candidate.original.currency,"usd");
    assert.equal(candidate.original.language,"en");assert.equal(candidate.consent.checkedSentence,DIGITAL_CONSENT_WORDS.en.box.digital);
  }finally{Date.now=realNow;}
});

test("renaming the same stable store resolves only its canonical public course door without an access grant",()=>{
  const f=courseCandidateWorld(),candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);assert.ok(candidate);
  const door=resolveCourseDoorCandidate(candidate,{...f.store,handle:"renamed-original-store"},f.product);
  assert.deepEqual(door,{kind:"public-course-door-candidate",grantsAccess:false,location:`https://marktmorgen.com/@renamed-original-store/course/${f.product.id}`});
  assert.equal(resolveCourseDoorCandidate(candidate,{...f.store,sid:"e".repeat(32)},f.product),null,"a reused old handle cannot select another tenant");
});

test("account, stats identity, product or course changes and removed courses cannot become another original door",()=>{
  const f=courseCandidateWorld(),candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);assert.ok(candidate);
  for(const store of [{...f.store,statsId:"f".repeat(32)},{...f.store,stripeAccountId:"acct_ForeignCourse01"},{...f.store,handle:"//evil.example"},{...f.store,sid:undefined}])assert.equal(resolveCourseDoorCandidate(candidate,store,f.product),null);
  for(const product of [{...f.product,id:"e".repeat(32)},{...f.product,course:{id:"e".repeat(32),lessons:4}},{...f.product,course:null},{...f.product,recurring:{interval:"month"}},null])assert.equal(resolveCourseDoorCandidate(candidate,f.store,product),null);
});

test("unknown or substituted consent and coupled fulfillment are rejected rather than invented",()=>{
  const f=courseCandidateWorld();
  for(const dc of [undefined,"yes:2026-10-30.1:d:1793556000",f.metadata.dc.replace(":d:",":m:"),"yes","yes:2099-01-01.1:d:1793556000"])assert.equal(captureCourseConfirmationCandidate(f.store,f.product,{...f.metadata,dc}),null);
  for(const extra of [{news:"yes"},{bundle:"x"},{preorder:"yes"},{token:"not-an-access-proof"}])assert.equal(captureCourseConfirmationCandidate(f.store,f.product,{...f.metadata,...extra}),null);
  for(const key of ["call","podcast","recurring","bundle","keys","file","link","plan","pwyw","callPackage","shipping"])assert.equal(captureCourseConfirmationCandidate(f.store,{...f.product,[key]:{}},f.metadata),null);
  for(const extra of [{options:[{id:"variant"}]},{fields:[{id:"question"}]},{note:true},{priceCents:0},{course:{lessons:4}}])assert.equal(captureCourseConfirmationCandidate(f.store,{...f.product,...extra},f.metadata),null);
});

test("descriptor capture refuses inherited fields and getters without running them",()=>{
  const f=courseCandidateWorld();let reads=0;
  for(const [which,key] of [["store","sid"],["product","title"],["metadata","dc"]] as const){
    const target={...f[which]};Object.defineProperty(target,key,{get(){reads++;throw Error("getter must not run");},enumerable:true});
    assert.equal(captureCourseConfirmationCandidate(which==="store"?target:f.store,which==="product"?target:f.product,which==="metadata"?target:f.metadata),null);
  }
  const inherited=Object.create(f.metadata);assert.equal(captureCourseConfirmationCandidate(f.store,f.product,inherited),null);
  assert.equal(reads,0);
});

test("candidate resolution cannot invoke nested JSON hooks or a forged array getter",()=>{
  const f=courseCandidateWorld(),candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);assert.ok(candidate);let reads=0;
  const evil={toJSON(){reads++;return "forged";}};
  assert.equal(resolveCourseDoorCandidate({...candidate,original:{...candidate.original,title:evil}},f.store,f.product),null);
  assert.equal(resolveCourseDoorCandidate({...candidate,publicPath:evil},f.store,f.product),null);
  const lines=["",candidate.consent.emailLines[1]];Object.defineProperty(lines,"1",{get(){reads++;return "forged";}});
  assert.equal(resolveCourseDoorCandidate({...candidate,consent:{...candidate.consent,emailLines:lines}},f.store,f.product),null);
  assert.equal(resolveCourseDoorCandidate({...candidate,identity:{...candidate.identity,toJSON:evil.toJSON}},f.store,f.product),null);
  assert.equal(reads,0);
});

test("mutating the capture or disguising an admitted source cannot pass the pure resolver",()=>{
  const f=courseCandidateWorld(),candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);assert.ok(candidate);
  for(const altered of [{...candidate,admitted:true},{...candidate,kind:"confirmation"},{...candidate,publicPath:"https://evil.example"},{...candidate,identity:{...candidate.identity,courseId:"e".repeat(32)}},{...candidate,consent:{...candidate.consent,checkedSentence:"New words"}}])assert.equal(resolveCourseDoorCandidate(altered,f.store,f.product),null);
  const altered={...candidate,admitted:true};const{captureFingerprint:_ignored,...rest}=altered;void _ignored;
  assert.equal(resolveCourseDoorCandidate({...altered,captureFingerprint:hash(rest)},f.store,f.product),null,"a new caller hash cannot manufacture admission");
});

test("the actual stable route is503 before all IO for valid or forged requests and grants no cookie or redirect",async()=>{
  const realFetch=globalThis.fetch;let io=0;globalThis.fetch=async()=>{io++;throw Error("No provider IO may run");};
  try{
    for(const value of ["https://marktmorgen.com/open/a/course/b?course=c","https://evil.example/open/a/course/b?account=acct_Foreign&token=forged"]){
      const request=new Request(value,{headers:{"x-forwarded-host":"evil.example","x-course-review":"approved"}});
      const response=await (GET as (r:Request,c:unknown)=>Promise<Response>)(request,{get params(){io++;throw Error("No identity lookup before absent review");}});
      assert.equal(response.status,503);assert.equal(response.headers.get("Location"),null);assert.equal(response.headers.get("Set-Cookie"),null);assert.equal(response.headers.get("Cache-Control"),"no-store");
      assert.equal(await response.text(),"This course link is not available yet. Please contact the store.");
    }
    assert.equal(io,0);
  }finally{globalThis.fetch=realFetch;}
});


test("pure capture and resolution never invoke an inherited JSON hook",()=>{
  const f=courseCandidateWorld();let hooks=0,candidate:ReturnType<typeof captureCourseConfirmationCandidate>,door:ReturnType<typeof resolveCourseDoorCandidate>;
  const previous=Object.getOwnPropertyDescriptor(Object.prototype,"toJSON");
  Object.defineProperty(Object.prototype,"toJSON",{configurable:true,value(){hooks++;return "forged";}});
  try {candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);door=resolveCourseDoorCandidate(candidate,f.store,f.product);}
  finally {if(previous)Object.defineProperty(Object.prototype,"toJSON",previous);else Reflect.deleteProperty(Object.prototype,"toJSON");}
  assert.ok(candidate!);assert.ok(door!);assert.equal(hooks,0);
});


test("the real store/catalog product identifier and existing dot/underscore handles are preserved",async()=>{
  const fetchWas=globalThis.fetch;globalThis.fetch=async()=>{throw Error("No real provider is allowed in this store/catalog proof");};
  try {for(const handle of ["teacher.course","teacher_course"]){
    const f=await realCourseCandidateWorld(handle);assert.match(f.product.id,/^[a-f0-9]{10}$/);
    const candidate=captureCourseConfirmationCandidate(f.store,f.product,f.metadata);assert.ok(candidate);
    assert.equal(captureCourseConfirmationCandidate(f.store,f.listing,f.metadata),null,"a reduced listing cannot prove absence of custom fields");
    assert.equal(candidate.identity.productId,f.product.id);assert.equal(candidate.original.handle,handle);
    assert.equal(resolveCourseDoorCandidate(candidate,f.store,f.product)?.location,`https://marktmorgen.com/@${handle}/course/${f.product.id}`);
    for(const productId of ["mk3z9x8w12ab","legacy-id_01","legacy id/encoded"]){
      const product={...f.product,id:productId},metadata={...f.metadata,product:productId};
      const opaque=captureCourseConfirmationCandidate(f.store,product,metadata);assert.ok(opaque);
      assert.equal(opaque.identity.productId,productId);assert.ok(opaque.publicPath.includes(`/course/${encodeURIComponent(productId)}?`));
      assert.equal(resolveCourseDoorCandidate(opaque,f.store,product)?.location,`https://marktmorgen.com/@${handle}/course/${encodeURIComponent(productId)}`);
    }
  }} finally {globalThis.fetch=fetchWas;}
});
