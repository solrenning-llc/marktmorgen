/** Opt-in real writer/reader/buyer-function evidence; MemoryRedis and Next request boundary. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail } from "@/lib/store";
import { createRequest,readRequest,requestOf } from "@/lib/payment-request-store";
import { createAgreement,readAgreement,agreementOf } from "@/lib/agreement-store";
import { readDraft as requestDraft } from "@/lib/payment-request-rules";
import { readDraft as agreementDraft } from "@/lib/agreement-rules";
import RequestPage from "../app/[handle]/pay/[request]/page";
import AgreementPage from "../app/[handle]/sign/[agreement]/page";
import { renderToStaticMarkup } from "react-dom/server";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

redis.clear();
const fixture=(async()=>{
 const owner="single-record-proof@example.test",handle="singlerecordproof";
 assert.equal((await claimHandle(owner,handle,"Fictional record store","Synthetic evidence.")).ok,true);
 await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:"cus_fixtureSingle",subscriptionId:"sub_fixtureSingle",active:true,tier:"creator",period:paidPeriod()});
 const shop=await storeForEmail(owner);assert.ok(shop?.sid);
 const rd=requestDraft({email:"buyer@example.test",name:"Fictional Buyer",lines:[{text:"Fictional requested work",quantity:1,amount:"12"}],note:"Synthetic request.",consent:true},"usd");assert.ok(rd.ok);
 const ad=agreementDraft({kind:"agreement",email:"buyer@example.test",name:"Fictional Buyer",title:"Fictional agreement",body:"Complete fictional agreement body.",lines:[],consent:true},"usd");assert.ok(ad.ok);
 const request=await createRequest(shop,rd.draft);assert.ok(request.ok,JSON.stringify(request));
 const agreement=await createAgreement(shop,ad.draft);assert.ok(agreement.ok,JSON.stringify(agreement));
 answering(new Request("https://marktmorgen.example.test/@singlerecordproof"));
 return {shop,request:request.request,agreement:agreement.agreement};
})();
type Family="request"|"agreement";
type Mode="missing-envelope"|"extra-envelope"|"wrong-slot"|"malformed-json"|"confirmed-null"|"transport";
async function read(family:Family,scoped=false){const f=await fixture;return family==="request"?(scoped?requestOf(f.shop,f.request.id):readRequest(f.request.id)):(scoped?agreementOf(f.shop,f.agreement.id):readAgreement(f.agreement.id));}
async function page(family:Family){const f=await fixture;return family==="request"?RequestPage({params:Promise.resolve({handle:"@singlerecordproof",request:f.request.id}),searchParams:Promise.resolve({})}):AgreementPage({params:Promise.resolve({handle:"@singlerecordproof",agreement:f.agreement.id}),searchParams:Promise.resolve({})});}
async function altered(family:Family,mode:Mode,task:()=>Promise<void>){
 const f=await fixture,original=redis.pipeline,id=family==="request"?f.request.id:f.agreement.id;
 const key=`nl:${family==="request"?"payreq":"agree"}:r:${id}`;
 const before=await original.call(redis,[["GET",key]]);let hits=0;
 redis.pipeline=async commands=>{
  const answer=await original.call(redis,commands);
  if(commands.length!==1||commands[0]?.[0]!=="GET"||commands[0]?.[1]!==key)return answer;
  hits++;if(mode==="transport")throw new Error("SYNTHETIC_RECORD_TRANSPORT");
  return mode==="missing-envelope"?[]:mode==="extra-envelope"?[...answer,null]:[mode==="confirmed-null"?null:mode==="malformed-json"?"{":false];
 };
 try{await task();}finally{redis.pipeline=original;assert.equal(hits,1,"one intended record read");assert.deepEqual(await original.call(redis,[["GET",key]]),before,"stored record intact");}
}
for(const family of ["request","agreement"] as const){
 test(`${family}: real writer, direct/scoped reader and actual buyer function keep the record`,async()=>{
  const f=await fixture,expected=family==="request"?f.request:f.agreement;
  assert.deepEqual(await read(family),expected);assert.deepEqual(await read(family,true),expected);
  const html=renderToStaticMarkup(await page(family));assert.match(html,family==="request"?/Fictional requested work/:/Complete fictional agreement body/);
 });
 for(const mode of ["missing-envelope","extra-envelope","wrong-slot","malformed-json"] as const)for(const scoped of [false,true])
  test(`${family}: ${scoped?"scoped":"direct"} reader rejects ${mode}`,async context=>{
   await altered(family,mode,async()=>{await assert.rejects(async()=>{const value=await read(family,scoped);context.diagnostic(JSON.stringify({family,mode,scoped,returnedNull:value===null}));});});
  });
 for(const mode of ["missing-envelope","malformed-json"] as const)
  test(`${family}: actual buyer function must not call notFound for ${mode}`,async context=>{
   await altered(family,mode,async()=>{let false404=false;try{await page(family);}catch(error){false404=(error as Error).message==="SYNTHETIC_NOT_FOUND";}context.diagnostic(JSON.stringify({family,mode,false404}));assert.equal(false404,false);});
  });
 test(`${family}: confirmed absence retains null/notFound`,async()=>{
  await altered(family,"confirmed-null",async()=>assert.equal(await read(family),null));
  await altered(family,"confirmed-null",async()=>{await assert.rejects(()=>page(family),/SYNTHETIC_NOT_FOUND/);});
 });
 test(`${family}: foreign store and invalid identity remain refused`,async()=>{
  const f=await fixture;
  assert.equal(family==="request"?await requestOf({sid:"foreign"},f.request.id):await agreementOf({sid:"foreign"},f.agreement.id),null);
  assert.equal(family==="request"?await readRequest("bad"):await readAgreement("bad"),null);
 });
 test(`${family}: thrown transport already propagates`,async()=>{await altered(family,"transport",async()=>{await assert.rejects(()=>read(family),/SYNTHETIC_RECORD_TRANSPORT/);});});
}
