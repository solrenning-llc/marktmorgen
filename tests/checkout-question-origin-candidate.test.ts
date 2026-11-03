import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {applyCheckoutFields,type CheckoutField} from '@/lib/checkout-fields';
import {captureOriginalCheckoutQuestions,CHECKOUT_QUESTION_ORIGIN} from '@/lib/checkout-question-origin-candidate';
import {confirmationBodyDigest} from '@/lib/order-confirmation-outbox';
import {admitOrders} from '@/lib/order-admission';
import {prepareOrderConfirmationPreintent} from '@/lib/orders';
import {physicalPaidFixture} from './order-confirmation-paid-fixture';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){
 const f=await physicalPaidFixture(),nonce=randomBytes(32).toString('hex'),accountId=f.store.stripeAccountId!;
 const fields:CheckoutField[]=[{label:'Name on the print',type:'text',optional:false,options:[]}];
 const body=new URLSearchParams({mode:'payment','metadata[mm_order_origin]':CHECKOUT_QUESTION_ORIGIN,'metadata[mm_order_intent]':nonce});
 applyCheckoutFields(body,fields);const digest=confirmationBodyDigest(body.toString());body.set('metadata[mm_order_hash]',digest);
 const admission=await admitOrders(f.store,1,f.created,1);assert.ok(admission.ok);
 const preintent=await prepareOrderConfirmationPreintent(f.store,admission,{nonce,accountId,bodyDigest:digest},{now:f.runtime.now});assert.ok(preintent);
 const identity={owner:f.store.email,accountId,nonce};
 return {...f,fields,body,preintent,identity,capture:()=>captureOriginalCheckoutQuestions(fields,body.toString(),preintent,identity,60000,f.runtime.now!())};
}
test('real admission authenticates original questions without granting checkout or reserving a source',async()=>{
 const f=await fixture(),c=f.capture();assert.ok(c);assert.equal(c.admitted,false);assert.equal(c.permitsCheckout,false);
 assert.equal(c.body,f.body.toString());assert.equal(c.preintent.token,f.preintent.token);assert.equal(c.bodyDigest,confirmationBodyDigest(c.body));
 assert.deepEqual(c.questions.fields,f.fields);assert.equal(f.calls.length,0);assert.equal(f.commands.length,0);
});
test('catalog edits cannot rewrite a captured contract and cannot match its original signed body',async()=>{
 const f=await fixture(),c=f.capture();assert.ok(c);const frozen=JSON.stringify(c);f.fields[0].label='Rewritten';
 assert.equal(f.capture(),null);assert.equal(JSON.stringify(c),frozen);assert.equal(c.questions.fields[0].label,'Name on the print');
});
test('a self-consistent changed question and body hash cannot replace the signed original body',async()=>{
 const f=await fixture();f.fields[0].optional=true;f.body.set('custom_fields[0][optional]','true');
 f.body.set('metadata[mm_order_hash]',confirmationBodyDigest(f.body.toString()));assert.equal(f.capture(),null);
});
test('matching fingerprint of a forged token is not authentic original admission',async()=>{
 const f=await fixture(),token='s1.synthetic-forged-token';
 assert.equal(captureOriginalCheckoutQuestions(f.fields,f.body.toString(),{...f.preintent,token,intentFingerprint:hash(token)},f.identity,60000),null);
});
test('another owner, account or nonce, unknown time and expired original rights deny',async()=>{
 const f=await fixture();for(const patch of [{owner:'other@example.test'},{accountId:'acct_OtherOwner01'},{nonce:'b'.repeat(64)}])
  assert.equal(captureOriginalCheckoutQuestions(f.fields,f.body.toString(),f.preintent,{...f.identity,...patch},60000),null);
 for(const now of [NaN,Infinity,-1,f.created-1000,f.preintent.expiresAtMs,f.preintent.expiresAtMs+73*3600000])
  assert.equal(captureOriginalCheckoutQuestions(f.fields,f.body.toString(),f.preintent,f.identity,60000,now),null);
 assert.equal(f.calls.length,0);
});
test('duplicate metadata, domain downgrade and getter-backed identities cannot manufacture a join',async()=>{
 const f=await fixture();for(const change of [(b:URLSearchParams)=>b.append('metadata[mm_order_intent]',f.identity.nonce),
  (b:URLSearchParams)=>b.set('metadata[mm_order_origin]','physical-v1')]){
  const b=new URLSearchParams(f.body);change(b);b.set('metadata[mm_order_hash]',confirmationBodyDigest(b.toString()));
  assert.equal(captureOriginalCheckoutQuestions(f.fields,b.toString(),f.preintent,f.identity,60000),null);
 }
 let reads=0;const identity=Object.defineProperty({...f.identity},'owner',{get(){reads++;throw Error('no');}});
 assert.equal(captureOriginalCheckoutQuestions(f.fields,f.body.toString(),f.preintent,identity,60000),null);assert.equal(reads,0);
});
test('the original token, identity and complete joined body fit the same explicit byte ceiling',async()=>{
 const f=await fixture(),c=f.capture();assert.ok(c);const bytes=Buffer.byteLength(JSON.stringify(c));
 assert.equal(captureOriginalCheckoutQuestions(f.fields,f.body.toString(),f.preintent,f.identity,bytes-1,f.runtime.now!()),null);
 assert.ok(captureOriginalCheckoutQuestions(f.fields,f.body.toString(),f.preintent,f.identity,bytes,f.runtime.now!()));
});
