/** Same-process preparation only. Persist a separately funded immutable source
 * before POST/URL; this receipt grants no checkout, delivery or access. */
import {types} from "node:util";
import {createHash} from "node:crypto";
import {captureDigitalOptionRequestSnapshot,type DigitalOptionRequestSnapshot} from "@/lib/digital-option-body";
import {prepareOrderConfirmationPreintent,type OrderConfirmationPreintent} from "@/lib/orders";
import type {Admission} from "@/lib/order-admission";
import {canSeal,unseal} from "@/lib/secret-box";
import {DELAYED_METHODS} from "@/lib/instant-pay";
import {LANGUAGES,type LanguageCode} from "@/lib/store-language";
import type {Store} from "@/lib/store";

type Data=Record<string,unknown>;
function own(value:unknown,maximum=128):Data|null{
 if(!value||typeof value!=="object"||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
 const keys=Reflect.ownKeys(value);if(keys.length>maximum)return null;const out:Data=Object.create(null);
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=="string"||!d||!Object.hasOwn(d,"value"))return null;out[key]=d.value;}return out;
}
function originalStore(value:unknown):Readonly<Data>|null{
 const source=own(value);if(!source)return null;const out:Data=Object.create(null);
 for(const key of ["email","sid","statsId","stripeAccountId","handle","name","currency","language","extra","shared","subscriptionActive","subscriptionId","trialEnds","tier","planEndedAt","cycle"]){
  const v=source[key];if(v!==undefined){if(v!==null&&!["string","number","boolean"].includes(typeof v)||typeof v==="number"&&!Number.isSafeInteger(v))return null;out[key]=v;}
 }
 for(const [key,max] of Object.entries({email:320,sid:32,statsId:128,stripeAccountId:128,handle:128,name:300,currency:3,language:12,subscriptionId:128,tier:16,planEndedAt:64,cycle:5}))if(typeof out[key]==="string"&&(out[key] as string).length>max)return null;
 if(source.period!==undefined&&source.period!==null){
  const p=own(source.period,4);if(!p||Object.keys(p).some(k=>!["start","end","renews","funded"].includes(k))||!Number.isSafeInteger(p.start)||!Number.isSafeInteger(p.end)||typeof p.renews!=="boolean"||p.funded!==undefined&&typeof p.funded!=="boolean")return null;
  out.period=Object.freeze(p);
 }else if(source.period===null)out.period=null;
 return Object.freeze(out);
}
/** Narrow request shape only; never legal consent, catalog or funding proof. */
function supportedShape(snapshot:DigitalOptionRequestSnapshot,store:Readonly<Data>):boolean{
 try{
  const form=new URLSearchParams(snapshot.body),language=store.language;
  if(typeof language!=="string"||!Object.hasOwn(LANGUAGES,language)||form.get("locale")!==LANGUAGES[language as LanguageCode].stripe||form.get("adaptive_pricing[enabled]")!=="false")return false;
  const allowed=new Set(["mode","locale","success_url","cancel_url","adaptive_pricing[enabled]",
   ...["store","product","option","title","dc","mm_order_origin","mm_order_intent","mm_order_hash","mm_admit"].map(k=>`metadata[${k}]`),
   ...["store","product","option","dc"].map(k=>`payment_intent_data[metadata][${k}]`),
   "line_items[0][quantity]","line_items[0][price_data][currency]","line_items[0][price_data][unit_amount]","line_items[0][price_data][product_data][name]","line_items[0][price_data][product_data][description]",
   ...DELAYED_METHODS.map((_,i)=>`excluded_payment_method_types[${i}]`)]);
  if([...form.keys()].some(k=>!allowed.has(k))||DELAYED_METHODS.some((method,i)=>form.get(`excluded_payment_method_types[${i}]`)!==method))return false;
  const success=form.get("success_url"),cancel=form.get("cancel_url");if(!success||!cancel)return false;
  const url=new URL(success);
  return url.protocol==="https:"&&!url.username&&!url.password&&!url.hash&&url.pathname===`/@${snapshot.identity.storeHandle}/thanks`&&url.search==="?session_id={CHECKOUT_SESSION_ID}"&&cancel===`${url.origin}/@${snapshot.identity.storeHandle}`;
 }catch{return false;}
}
export type DigitalOptionPreintentReceipt=Readonly<{
 kind:"digital-option-pre-url-candidate";authority:"same-process-only";
 admitted:false;permitsCheckout:false;grantsAccess:false;
 nonce:string;bodyDigest:string;expiresAtMs:number;
}>;
type Prepared=Readonly<{snapshot:DigitalOptionRequestSnapshot;store:Readonly<Data>;preintent:Readonly<OrderConfirmationPreintent>;preparedAtMs:number}>;
const prepared=new WeakMap<object,Prepared>();
export async function prepareDigitalOptionPreintent(input:unknown):Promise<DigitalOptionPreintentReceipt|null>{
 try{
  const value=own(input,9),names=["store","product","optionId","folder","body","nonce","consent","maximumBytes","admission"];
  if(!value||Object.keys(value).length!==names.length||!names.every(k=>Object.hasOwn(value,k))||!canSeal()||Object.getOwnPropertyDescriptor(Object.prototype,"toJSON"))return null;
  const store=originalStore(value.store);if(!store)return null;
  const fields=Object.fromEntries(names.filter(k=>k!=="admission").map(k=>[k,k==="store"?store:value[k]]));
  const snapshot=captureDigitalOptionRequestSnapshot(fields);if(!snapshot||!supportedShape(snapshot,store))return null;
  const now=Date.now();if(!Number.isSafeInteger(now))return null;
  // Retain the actual Admission reference: a JSON copy loses its WeakMap proof.
  const result=await prepareOrderConfirmationPreintent(store as unknown as Store,value.admission as Admission,{nonce:snapshot.nonce,accountId:snapshot.accountId,bodyDigest:snapshot.bodyDigest},{now:()=>now});
  const finished=Date.now();
  if(!result||!Number.isSafeInteger(finished)||finished<now||!Number.isSafeInteger(result.expiresAtMs)||finished>=result.expiresAtMs||typeof result.token!=="string"||Buffer.byteLength(result.token)>4096||result.intentFingerprint!==createHash("sha256").update(result.token).digest("hex"))return null;
  const opened=unseal(result.token,`order-confirmation-preintent|${snapshot.nonce}`);if(!opened.ok||Buffer.byteLength(opened.value)>2500)return null;
  const proof=own(JSON.parse(opened.value),5),original=proof&&own(proof.original,12),form=new URLSearchParams(snapshot.body);
  if(!proof||!original||proof.version!==1||proof.nonce!==snapshot.nonce||proof.accountId!==snapshot.accountId||proof.bodyDigest!==snapshot.bodyDigest||original.version!==1||original.folder!==snapshot.folder||original.until!==result.expiresAtMs||original.reference!==`preintent:${snapshot.accountId}:${snapshot.nonce}:${snapshot.bodyDigest}`||!Number.isSafeInteger(original.captured)||Number(original.captured)>finished||
     (original.hour===null?form.has("metadata[mm_admit]"):!Number.isSafeInteger(original.hour)||Number(original.hour)<0||form.get("metadata[mm_admit]")!==String(original.hour)))return null;
  const receipt=Object.freeze({kind:"digital-option-pre-url-candidate" as const,authority:"same-process-only" as const,admitted:false as const,permitsCheckout:false as const,grantsAccess:false as const,nonce:snapshot.nonce,bodyDigest:snapshot.bodyDigest,expiresAtMs:result.expiresAtMs});
  prepared.set(receipt,Object.freeze({snapshot,store,preintent:Object.freeze({...result}),preparedAtMs:finished}));return receipt;
 }catch{return null;}
}
/** Only the actual returned object can supply its original prepared values.
 * Restart recovery needs the future sealed source, never reconstructed receipt. */
export function readDigitalOptionPreintent(receipt:unknown):Prepared|null{
 if(!receipt||typeof receipt!=="object")return null;const found=prepared.get(receipt);const now=Date.now();return found&&Number.isSafeInteger(now)&&now>=found.preparedAtMs&&now<found.preintent.expiresAtMs?found:null;
}
