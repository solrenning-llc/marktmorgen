/** Integrity join only. No trusted catalog ownership, financial review, funded
 * source, accounting winner, provider observation or checkout permission. */
import {createHash} from 'node:crypto';
import {unseal} from '@/lib/secret-box';
import {confirmationBodyDigest} from '@/lib/order-confirmation-outbox';
import {captureCheckoutQuestions} from '@/lib/checkout-question-candidate';
import {DEMO_CONNECTED_ACCOUNT} from '@/lib/demo-account';
export const CHECKOUT_QUESTION_ORIGIN='physical-questions-v1';
function own(value:unknown,max:number):Record<string,unknown>|null{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
 const keys=Reflect.ownKeys(value);if(keys.length>max)return null;const out:Record<string,unknown>=Object.create(null);
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d||!Object.hasOwn(d,'value'))return null;out[key]=d.value;}return out;
}
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function captureOriginalCheckoutQuestions(fields:unknown,body:unknown,preintent:unknown,identity:unknown,maximumBytes:unknown,now=Date.now()){
 try{
  if(!Number.isSafeInteger(now)||now<0||typeof maximumBytes!=='number')return null;
  const who=own(identity,3),p=own(preintent,3);
  if(!who||!exact(who,['owner','accountId','nonce'])||typeof who.owner!=='string'||!who.owner||who.owner.length>320||
   typeof who.accountId!=='string'||!/^acct_[A-Za-z0-9]{6,128}$/.test(who.accountId)||who.accountId===DEMO_CONNECTED_ACCOUNT||
   typeof who.nonce!=='string'||!/^[a-f0-9]{64}$/.test(who.nonce)||
   !p||!exact(p,['token','expiresAtMs','intentFingerprint'])||typeof p.token!=='string'||p.token.length>4000||
   typeof p.expiresAtMs!=='number'||!Number.isSafeInteger(p.expiresAtMs)||now>=p.expiresAtMs||p.intentFingerprint!==hash(p.token))return null;
  const questions=captureCheckoutQuestions(fields,body,maximumBytes);if(!questions||typeof body!=='string')return null;
  const form=new URLSearchParams(body),entries=[...form];
  if(form.toString()!==body||new Set(entries.map(([key])=>key)).size!==entries.length||form.get('mode')!=='payment'||
   form.get('metadata[mm_order_origin]')!==CHECKOUT_QUESTION_ORIGIN||form.get('metadata[mm_order_intent]')!==who.nonce)return null;
  const bodyDigest=confirmationBodyDigest(body);if(form.get('metadata[mm_order_hash]')!==bodyDigest)return null;
  const opened=unseal(p.token,`order-confirmation-preintent|${who.nonce}`);if(!opened.ok||opened.value.length>2500)return null;
  const proof=own(JSON.parse(opened.value),5),original=own(proof?.original,12);
  if(!proof||!exact(proof,['version','nonce','accountId','bodyDigest','original'])||proof.version!==1||proof.nonce!==who.nonce||
   proof.accountId!==who.accountId||proof.bodyDigest!==bodyDigest||!original||original.version!==1||original.owner!==who.owner||
   original.until!==p.expiresAtMs||typeof original.captured!=='number'||!Number.isSafeInteger(original.captured)||original.captured<0||original.captured>now||
   original.reference!==`preintent:${who.accountId}:${who.nonce}:${bodyDigest}`)return null;
  const candidate=Object.freeze({kind:'checkout-question-origin-candidate' as const,admitted:false as const,permitsCheckout:false as const,
   body,bodyDigest,identity:Object.freeze({owner:who.owner,accountId:who.accountId,nonce:who.nonce}),questions,
   preintent:Object.freeze({token:p.token,expiresAtMs:p.expiresAtMs,intentFingerprint:p.intentFingerprint as string})});
  return Buffer.byteLength(JSON.stringify(candidate))<=maximumBytes?candidate:null;
 }catch{return null;}
}
