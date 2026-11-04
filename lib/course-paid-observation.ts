/** Unadmitted observation only. No authenticated course-source issuer,
 * authenticated-principal receipt or funded read capability exists here.
 * These pure helpers never confer access or turn a hash/boolean into proof.
 * All fields and clocks are unverified input, including successful replies.
 */
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";

type Data = Record<string, unknown>;
function own(value: unknown): Data | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return null;
    const keys=Reflect.ownKeys(value);if(keys.length>64)return null;
    const out:Data=Object.create(null);
    for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=="string"||!d||!Object.hasOwn(d,"value"))return null;out[key]=d.value;}
    return out;
  }catch{return null;}
}
function array(value:unknown, expected:number):unknown[]|null{
  try{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
    const ds=Object.getOwnPropertyDescriptors(value) as unknown as Record<string,PropertyDescriptor>,n=ds.length.value;if(n!==expected||Reflect.ownKeys(value).length!==n+1)return null;
    const out:unknown[]=[];for(let i=0;i<n;i++){const d=ds[i];if(!d||!Object.hasOwn(d,"value"))return null;out.push(d.value);}return out;
  }catch{return null;}
}
const id=(v:unknown,re:RegExp):v is string=>typeof v==="string"&&re.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const string=(v:unknown,max=500):v is string=>typeof v==="string"&&v.length>0&&Buffer.byteLength(v)<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const exact=(r:Data,names:readonly string[])=>Object.keys(r).length===names.length&&names.every(k=>Object.hasOwn(r,k));
const keys=["kind","provenance","admitted","storeId","statsId","accountId","productId","courseId","buyerEmail","sessionId","paymentIntentId","chargeId","currency","subtotalCents","totalCents","createdSeconds","nonce","bodyDigest","metadata"] as const;
export type UnverifiedCoursePaidReference=Readonly<{
  kind:"unverified-new-course-paid-reference";provenance:"unverified-producer-input";admitted:false;
  storeId:string;statsId:string;accountId:string;productId:string;courseId:string;buyerEmail:string;
  sessionId:string;paymentIntentId:string;chargeId:string;currency:string;subtotalCents:number;totalCents:number;createdSeconds:number;
  nonce:string;bodyDigest:string;metadata:Readonly<Record<string,string>>;
}>;
/** Structural capture, NOT issuance of an authentic source/principal. */
export function captureUnverifiedCoursePaidReference(value:unknown):UnverifiedCoursePaidReference|null{
  const r=own(value);if(!r||!exact(r,keys)||r.kind!=="unverified-new-course-paid-reference"||r.provenance!=="unverified-producer-input"||r.admitted!==false)return null;
  if(![r.storeId,r.statsId,r.courseId].every(x=>id(x,/^[a-f0-9]{32}$/))||!id(r.accountId,/^acct_[A-Za-z0-9]{8,64}$/)||
    !string(r.productId,128)||r.productId==="."||r.productId===".."||!string(r.buyerEmail,320)||r.buyerEmail!==r.buyerEmail.trim().toLowerCase()||! /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(r.buyerEmail)||
    !id(r.sessionId,/^cs_(test|live)_[A-Za-z0-9]{10,200}$/)||!id(r.paymentIntentId,/^pi_[A-Za-z0-9]{10,200}$/)||!id(r.chargeId,/^ch_[A-Za-z0-9]{10,200}$/)||
    !id(r.currency,/^[a-z]{3}$/)||!integer(r.subtotalCents)||r.subtotalCents<=0||!integer(r.totalCents)||r.totalCents<r.subtotalCents||!integer(r.createdSeconds)||r.createdSeconds<=0||
    !id(r.nonce,/^[a-f0-9]{64}$/)||!id(r.bodyDigest,/^[a-f0-9]{64}$/))return null;
  const meta=own(r.metadata);if(!meta||Object.keys(meta).length>12||Object.values(meta).some(v=>!string(v))||typeof meta.store!=="string"||!HANDLE_PATTERN.test(meta.store)||
    meta.product!==r.productId||meta.mm_order_origin!=="course-v1"||meta.mm_order_intent!==r.nonce||meta.mm_order_hash!==r.bodyDigest||!string(meta.dc))return null;
  const metadata=Object.freeze({...meta}) as Readonly<Record<string,string>>;
  return Object.freeze({...r,metadata}) as UnverifiedCoursePaidReference;
}
export type UnverifiedCourseReadPlan=Readonly<{authority:"unverified";admitted:false;grantsAccess:false;reads:readonly Readonly<{method:"GET";accountId:string;path:string}>[]}>;
/** At most three exact GET descriptors. This creates NO request, reservation,
 * principal receipt or provider permission. No list/search/POST is planned. */
export function planUnverifiedCoursePaidReads(value:unknown):UnverifiedCourseReadPlan|null{
  const r=captureUnverifiedCoursePaidReference(value);if(!r)return null;
  const paths=[`/checkout/sessions/${encodeURIComponent(r.sessionId)}?expand[]=line_items`,`/payment_intents/${encodeURIComponent(r.paymentIntentId)}`,`/charges/${encodeURIComponent(r.chargeId)}`];
  return Object.freeze({authority:"unverified",admitted:false,grantsAccess:false,reads:Object.freeze(paths.map(path=>Object.freeze({method:"GET" as const,accountId:r.accountId,path})))});
}
export type CoursePaidObservation=Readonly<{authority:"unverified";admitted:false;grantsAccess:false;outcome:"paid"|"not_paid"|"fully_refunded"|"partially_refunded"|"disputed"|"unknown"}>;
const result=(outcome:CoursePaidObservation["outcome"]):CoursePaidObservation=>Object.freeze({authority:"unverified",admitted:false,grantsAccess:false,outcome});
/** Observe already-collected replies. Caller-provided clock evidence is only
 * checked for consistency, never represented as authenticated freshness.
 * The 30s processing window is NOT an authorized supplier-cost allowance. */
export function observeUnverifiedCoursePaidReplies(reference:unknown,trace:unknown):CoursePaidObservation{
  try{
    const r=captureUnverifiedCoursePaidReference(reference),plan=r&&planUnverifiedCoursePaidReads(r),t=own(trace);if(!r||!plan||!t)return result("unknown");
    if(!exact(t,["reads","startedUtcMs","finishedUtcMs","startedMonotonicMs","finishedMonotonicMs","expiresUtcMs","expiresMonotonicMs"])||
      !integer(t.startedUtcMs)||!integer(t.finishedUtcMs)||!integer(t.expiresUtcMs)||t.finishedUtcMs<t.startedUtcMs||r.createdSeconds>Math.floor(t.startedUtcMs/1000)||t.finishedUtcMs>=t.expiresUtcMs||t.expiresUtcMs-t.startedUtcMs>30_000||
      ![t.startedMonotonicMs,t.finishedMonotonicMs,t.expiresMonotonicMs].every(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0)||
      Number(t.finishedMonotonicMs)<Number(t.startedMonotonicMs)||Number(t.finishedMonotonicMs)>=Number(t.expiresMonotonicMs)||Number(t.expiresMonotonicMs)-Number(t.startedMonotonicMs)>30_000)return result("unknown");
    const rows=array(t.reads,3);if(!rows)return result("unknown");const bodies:Data[]=[];
    for(let i=0;i<3;i++){const row=own(rows[i]),expected=plan.reads[i];if(!row||!exact(row,["method","accountId","path","status","body"])||row.method!=="GET"||row.accountId!==expected.accountId||row.path!==expected.path||row.status!==200)return result("unknown");const body=own(row.body);if(!body)return result("unknown");bodies.push(body);}
    const [s,p,c]=bodies,meta=own(s.metadata),details=own(s.customer_details),lineItems=own(s.line_items),lines=array(lineItems?.data,1),line=lines&&own(lines[0]),price=own(line?.price);
    if(s.object!=="checkout.session"||s.id!==r.sessionId||s.mode!=="payment"||s.payment_intent!==r.paymentIntentId||s.created!==r.createdSeconds||s.amount_subtotal!==r.subtotalCents||s.amount_total!==r.totalCents||s.currency!==r.currency||
      !meta||!exact(meta,Object.keys(r.metadata))||Object.keys(r.metadata).some(k=>meta[k]!==r.metadata[k])||!details||!string(details.email,320)||details.email.trim().toLowerCase()!==r.buyerEmail||
      s.customer_email!==undefined&&s.customer_email!==null&&(typeof s.customer_email!=="string"||s.customer_email.trim().toLowerCase()!==r.buyerEmail)||!lineItems||lineItems.has_more!==false||!line||line.quantity!==1||!price||price.unit_amount!==r.subtotalCents||price.currency!==r.currency)return result("unknown");
    if(s.status!=="complete"||s.payment_status!=="paid")return typeof s.status==="string"&&typeof s.payment_status==="string"&&["open","expired","complete"].includes(s.status)&&["unpaid","no_payment_required"].includes(s.payment_status)?result("not_paid"):result("unknown");
    if(p.object!=="payment_intent"||p.id!==r.paymentIntentId||p.latest_charge!==r.chargeId||p.currency!==r.currency||p.amount!==r.totalCents||p.amount_received!==r.totalCents||p.status!=="succeeded"||
      c.object!=="charge"||c.id!==r.chargeId||c.payment_intent!==r.paymentIntentId||c.currency!==r.currency||c.amount!==r.totalCents||c.amount_captured!==r.totalCents||c.status!=="succeeded"||c.paid!==true||c.captured!==true||typeof c.disputed!=="boolean"||typeof c.refunded!=="boolean"||!integer(c.amount_refunded)||c.amount_refunded>r.totalCents||c.refunded!==(c.amount_refunded===r.totalCents))return result("unknown");
    if(c.disputed)return result("disputed");
    return result(c.refunded?"fully_refunded":c.amount_refunded>0?"partially_refunded":"paid");
  }catch{return result("unknown");}
}
/** No real course-source/auth/funding protocol is issued. Refusal precedes
 * inspecting ANY argument: there is intentionally no test/env/HTTP switch. */
export function observeCurrentCoursePaidSource(..._arguments:unknown[]):Readonly<{authority:"none";admitted:false;grantsAccess:false;outcome:"unavailable";accessReview:null;fundingReview:null}>{
  void _arguments;
  return Object.freeze({authority:"none",admitted:false,grantsAccess:false,outcome:"unavailable",accessReview:null,fundingReview:null});
}
