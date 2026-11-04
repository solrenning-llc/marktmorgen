/** Server-issued integrity of a selected course snapshot BEFORE a payment URL.
 * This is not a source row, provider ACK, payment proof or spending capability.
 * The future producer must supply Store/readProduct from its trusted reads,
 * reserve and persist the whole funded source, and choose an immutable CAS
 * winner before creating/returning any URL. No caller is integrated here.
 */
import {createHash} from "node:crypto";
import {captureCourseConfirmationCandidate,resolveCourseDoorCandidate, type CourseConfirmationCandidate} from "@/lib/course-confirmation-origin";
import {confirmationBodyDigest} from "@/lib/order-confirmation-outbox";
import {prepareOrderConfirmationPreintent, type OrderConfirmationPreintent} from "@/lib/orders";
import type {Admission} from "@/lib/order-admission";
import type {Store} from "@/lib/store";
import {canSeal, seal, unseal} from "@/lib/secret-box";

type Data=Record<string,unknown>;
const HASH=/^[a-f0-9]{64}$/;
const MAX_BYTES=16_384;
const context=(nonce:string)=>`course-confirmation-origin-binding:v1|${nonce}`;
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const exact=(v:Data,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function own(value:unknown,max=128):Data|null{
 try{
  if(!value||typeof value!=="object"||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
  const names=Reflect.ownKeys(value);if(names.length>max)return null;const result:Data=Object.create(null);
  for(const k of names){const d=Object.getOwnPropertyDescriptor(value,k);if(typeof k!=="string"||!d||!Object.hasOwn(d,"value"))return null;result[k]=d.value;}
  return result;
 }catch{return null;}
}
function select(value:unknown,keys:string[]):Data|null{
 try{
  if(!value||typeof value!=="object"||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
  const result:Data=Object.create(null);
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);if(d){if(!Object.hasOwn(d,"value"))return null;result[k]=d.value;}}
  return result;
 }catch{return null;}
}
/** No object/array JSON hooks or accessors execute during capture/encoding. */
function encoded(value:unknown,depth=0,budget={left:256}):string{
 if(--budget.left<0||depth>8)throw Error("Course binding exceeds structural bound");
 if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"&&Number.isSafeInteger(value))return String(value);
 if(Array.isArray(value)){
  const length=Object.getOwnPropertyDescriptor(value,"length")?.value;
  if(Object.getPrototypeOf(value)!==Array.prototype||!Number.isSafeInteger(length)||length>32||Reflect.ownKeys(value).length!==length+1)throw Error("Unknown course binding array");
  const parts:string[]=[];
  for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,"value"))throw Error("Course binding accessor");parts.push(encoded(d.value,depth+1,budget));}
  return `[${parts.join(",")}]`;
 }
 const data=own(value);if(!data)throw Error("Unknown course binding data");
 return `{${Object.keys(data).map(k=>`${JSON.stringify(k)}:${encoded(data[k],depth+1,budget)}`).join(",")}}`;
}
function frozen<T>(value:T):T{
 if(value&&typeof value==="object")for(const child of Object.values(value))frozen(child);
 return Object.freeze(value);
}
function storeSnapshot(value:unknown):Data|null{
 const store=select(value,["sid","statsId","stripeAccountId","handle","name","email","currency","language","extra","shared","subscriptionActive","subscriptionId","trialEnds","tier","planEndedAt","cycle","period"]);
 if(!store)return null;
 for(const [key,max]of Object.entries({sid:32,statsId:32,stripeAccountId:128,handle:128,name:300,email:320,currency:3,language:12,subscriptionId:128,tier:16,planEndedAt:64,cycle:5})){
  if(typeof store[key]==="string"&&(store[key] as string).length>max)return null;
 }
 if(store.period!==null&&store.period!==undefined){const period=select(store.period,["start","end","renews","funded"]);if(!period)return null;store.period=Object.freeze(period);}
 return Object.freeze(store);
}
function productSnapshot(value:unknown):Data|null{
 const product=select(value,["id","title","priceCents","course","call","podcast","recurring","bundle","keys","file","link","plan","pwyw","callPackage","shipping","note","options","fields"]);
 if(!product)return null;
 if(typeof product.id==="string"&&product.id.length>128||typeof product.title==="string"&&product.title.length>1000)return null;
 const course=select(product.course,["id","lessons"]);if(!course)return null;product.course=Object.freeze(course);
 if(typeof course.id==="string"&&course.id.length>32)return null;
 // Capture empty arrays without reading an iterator, item or caller again.
 for(const key of ["options","fields"]){const list=product[key];if(!Array.isArray(list)||Object.getPrototypeOf(list)!==Array.prototype||Reflect.ownKeys(list).length!==1||Object.getOwnPropertyDescriptor(list,"length")?.value!==0)return null;product[key]=Object.freeze([]);}
 return Object.freeze(product);
}
/** Deliberately narrow fixed-price, one-course body construction. Unsupported
 * tax/discount/variant fields need a later reviewed producer, not deletion
 * from a live checkout. There is no live call site for this construction.
 */
function bodyMatches(body:string,candidate:CourseConfirmationCandidate,nonce:string):boolean{
 if(body.length>MAX_BYTES||Buffer.byteLength(body)>MAX_BYTES)return false;
 const form=new URLSearchParams(body),entries=[...form];
 if(form.toString()!==body||entries.length>32||new Set(entries.map(([k])=>k)).size!==entries.length)return false;
 const expected:Record<string,string>={mode:"payment","line_items[0][quantity]":"1",
  "line_items[0][price_data][currency]":candidate.original.currency,
  "line_items[0][price_data][unit_amount]":String(candidate.original.priceCents),
  "line_items[0][price_data][product_data][name]":candidate.original.title,
  ...Object.fromEntries(Object.entries(candidate.metadata).map(([k,v])=>[`metadata[${k}]`,v])),
  "metadata[mm_order_intent]":nonce,"metadata[mm_order_origin]":"course-v1"};
 const optional=new Set(["success_url","cancel_url","locale"]);
 const allowed=new Set([...Object.keys(expected),...optional,"metadata[mm_order_hash]"]);
 if(entries.some(([k])=>!allowed.has(k))||Object.entries(expected).some(([k,v])=>form.get(k)!==v))return false;
 for(const key of ["success_url","cancel_url"])if(form.has(key)){
  try{const url=new URL(form.get(key)!);if(url.protocol!=="https:"||url.username||url.password)return false;}catch{return false;}
 }
 return form.get("metadata[mm_order_hash]")===confirmationBodyDigest(body);
}

/** Minimal dependency on the v1 preintent identity/time shape. This does not
 * reimplement the accounting snapshot parser or establish payment authority.
 */
function preintentMatches(preintent:OrderConfirmationPreintent,nonce:string,bodyDigest:string,candidate:CourseConfirmationCandidate,now:number):boolean{
 const opened=unseal(preintent.token,`order-confirmation-preintent|${nonce}`);
 if(!opened.ok||opened.value.length>2_500||preintent.intentFingerprint!==hash(preintent.token))return false;
 const proof=own(JSON.parse(opened.value),5),snapshot=proof&&own(proof.original,12);
 return Boolean(proof&&exact(proof,["version","nonce","accountId","bodyDigest","original"])&&proof.version===1&&proof.nonce===nonce&&proof.accountId===candidate.identity.accountId&&proof.bodyDigest===bodyDigest&&
  snapshot&&snapshot.version===1&&snapshot.until===preintent.expiresAtMs&&Number.isSafeInteger(snapshot.captured)&&Number(snapshot.captured)<=now&&now<preintent.expiresAtMs&&
  snapshot.reference===`preintent:${candidate.identity.accountId}:${nonce}:${bodyDigest}`&&
  (snapshot.hour===null||Number.isSafeInteger(snapshot.hour)&&Number(snapshot.hour)>=0)&&
  (snapshot.hour===null?!Object.hasOwn(candidate.metadata,"mm_admit"):candidate.metadata.mm_admit===String(snapshot.hour)));
}

type Closed=Readonly<{admitted:false;permitsCheckout:false;grantsAccess:false}>;
const closed:Closed=Object.freeze({admitted:false,permitsCheckout:false,grantsAccess:false});
export type CourseOriginBindingToken=Closed&Readonly<{
 kind:"course-pre-url-snapshot";token:string;nonce:string;fingerprint:string;expiresAtMs:number;
}>;
export type OpenedCourseOriginBinding=Closed&Readonly<{
 kind:"course-pre-url-snapshot";integrity:"verified";
 /** Authenticated selection by this issuer, NOT proof of database ownership,
  * current provider state, an immutable session, buyer or paid access. */
 authority:"selected-snapshot-only";candidate:CourseConfirmationCandidate;
 nonce:string;bodyDigest:string;body:string;preintent:OrderConfirmationPreintent;expiresAtMs:number;
}>;

/** The Admission argument retains object identity; cloning it deliberately
 * loses its private WeakMap proof. All other selected data is captured before
 * the first await, so a pending hash cannot sign a later caller mutation.
 */
export async function prepareCourseOriginBinding(input:unknown,runtime:{now?:()=>number}={}):Promise<CourseOriginBindingToken|null>{
 try{
  const data=own(input,6);
  if(!data||!exact(data,["store","product","metadata","body","nonce","admission"])||typeof data.body!=="string"||typeof data.nonce!=="string"||!HASH.test(data.nonce)||!canSeal())return null;
  const store=storeSnapshot(data.store),product=productSnapshot(data.product),metadata=own(data.metadata,4);
  if(!store||!product||!metadata)return null;
  if(Object.values(metadata).some(v=>typeof v!=="string"||v.length>500))return null;
  const candidate=captureCourseConfirmationCandidate(store,product,metadata);
  if(!candidate||!bodyMatches(data.body,candidate,data.nonce))return null;
  const body=data.body,nonce=data.nonce,bodyDigest=confirmationBodyDigest(body);
  const runtimeData=own(runtime,1);if(!runtimeData||runtimeData.now!==undefined&&typeof runtimeData.now!=="function")return null;
  const clock=(runtimeData.now??Date.now) as ()=>number,started=clock();if(!Number.isSafeInteger(started))return null;
  // Capture via a hook-free encoding now, never serialize caller objects.
  const captured=JSON.parse(encoded(candidate)) as CourseConfirmationCandidate;
  // The reused legacy preintent helper serializes a plain proof object.
  // Refuse a preexisting inherited hook without reading/invoking it. This is
  // not isolation from arbitrary concurrent mutation of JavaScript globals.
  if(Object.getOwnPropertyDescriptor(Object.prototype,"toJSON"))return null;
  const preintent=await prepareOrderConfirmationPreintent(store as unknown as Store,data.admission as Admission,
   {nonce,accountId:candidate.identity.accountId,bodyDigest},{now:()=>started});
  const finished=clock();
  if(!preintent||!Number.isSafeInteger(finished)||finished<started||!preintentMatches(preintent,nonce,bodyDigest,candidate,finished))return null;
  const envelope={version:1,kind:"course-confirmation-binding",nonce,bodyDigest,body,candidate:captured,preintent,expiresAtMs:preintent.expiresAtMs};
  const plain=encoded(envelope);if(Buffer.byteLength(plain)>MAX_BYTES)return null;
  const token=seal(plain,context(nonce));
  if(Buffer.byteLength(token)>MAX_BYTES)return null;
  return Object.freeze({...closed,kind:"course-pre-url-snapshot",token,nonce,fingerprint:hash(token),expiresAtMs:preintent.expiresAtMs});
 }catch{return null;}
}

/** Recover the authenticated snapshot only. Expected identity/body may be
 * compared by the next producer, but neither a returned value nor the token
 * authorizes a URL, checkout POST, enrollment or email. Durable CAS is absent.
 */
export function openCourseOriginBinding(tokenValue:unknown,nonceValue:unknown,now=Date.now()):OpenedCourseOriginBinding|null{
 try{
  if(typeof tokenValue!=="string"||tokenValue.length>MAX_BYTES||Buffer.byteLength(tokenValue)>MAX_BYTES||typeof nonceValue!=="string"||nonceValue.length!==64||!HASH.test(nonceValue)||!Number.isSafeInteger(now))return null;
  const opened=unseal(tokenValue,context(nonceValue));if(!opened.ok||Buffer.byteLength(opened.value)>MAX_BYTES)return null;
  const value=own(JSON.parse(opened.value),8);
  if(!value||!exact(value,["version","kind","nonce","bodyDigest","body","candidate","preintent","expiresAtMs"])||value.version!==1||value.kind!=="course-confirmation-binding"||value.nonce!==nonceValue||typeof value.body!=="string"||typeof value.bodyDigest!=="string"||!HASH.test(value.bodyDigest)||confirmationBodyDigest(value.body)!==value.bodyDigest)return null;
  const candidateData=own(value.candidate),identity=candidateData&&own(candidateData.identity),original=candidateData&&own(candidateData.original),consent=candidateData&&own(candidateData.consent),metadata=candidateData&&own(candidateData.metadata,4);
  if(!candidateData||!identity||!original||!consent||!metadata)return null;
  // Reuse the historical candidate validator, NOT the current issuer. A
  // wording/version update cannot rewrite or invalidate already sealed text.
  // These selected values are not a current database or provider read.
  const candidate=candidateData as unknown as CourseConfirmationCandidate;
  if(!resolveCourseDoorCandidate(candidate,{sid:identity.sid,statsId:identity.statsId,stripeAccountId:identity.accountId,handle:original.handle},
   {id:identity.productId,title:original.title,priceCents:original.priceCents,course:{id:identity.courseId,lessons:0},
    call:null,podcast:null,recurring:null,bundle:null,keys:null,file:null,link:null,plan:null,pwyw:null,callPackage:null,shipping:null,note:false,options:[],fields:[]})||!bodyMatches(value.body,candidate,nonceValue))return null;
  const preintent=own(value.preintent,3);
  if(!preintent||!exact(preintent,["token","expiresAtMs","intentFingerprint"])||typeof preintent.token!=="string"||preintent.intentFingerprint!==hash(preintent.token)||preintent.expiresAtMs!==value.expiresAtMs||!Number.isSafeInteger(value.expiresAtMs)||now>=Number(value.expiresAtMs))return null;
  if(!preintentMatches(preintent as OrderConfirmationPreintent,nonceValue,value.bodyDigest,candidate,now))return null;
  return frozen({...closed,kind:"course-pre-url-snapshot",integrity:"verified",authority:"selected-snapshot-only",candidate,
   nonce:nonceValue,bodyDigest:value.bodyDigest,body:value.body,preintent:preintent as OrderConfirmationPreintent,expiresAtMs:Number(value.expiresAtMs)});
 }catch{return null;}
}
