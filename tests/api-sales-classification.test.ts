/**
 * Codex G2's proof on #1899 (codex/g2-review-1899-classification-red, 9f4c3b4be), kept as permanent tests: an own
 * checkout whose status, payment status or mode is not one Stripe documents, or a row that is not a checkout, is
 * unknown (502), never a confirmed page without sales; an expanded payment, charge or invoice that is not of its own
 * kind with its own id, or missing on a paid checkout, is unknown, never a confirmed zero refund, no dispute or no
 * payment moment; and /developers no longer promises a null currency.
 */
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/sales/route';
import {makeKey} from '@/lib/api-keys';
import {addDraftProducts,claimHandle,ensureStatsId,setStripeAccount,setSubscription,storeForEmail} from '@/lib/store';
import {productIds} from '@/lib/catalog';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
const owner='g2-api-sales@example.test',handle='g2-api-sales',account='acct_G2ApiSales';
const session=(patch:Record<string,unknown>={})=>({id:'cs_test_G2Sale',object:'checkout.session',status:'complete',payment_status:'paid',mode:'payment',created:1790000000,amount_total:4900,currency:'eur',total_details:{amount_discount:0},metadata:{store:handle,title:'Known guide'},custom_fields:[{key:'private',text:{value:'G2_PRIVATE_ANSWER'}}],...patch});
const page=(data:unknown[]=[],has_more=false)=>({object:'list',data,has_more});
async function fixture(drafts=false){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_g2_sales_synthetic';
 await claimHandle(owner,handle,'Synthetic sales','');await ensureStatsId(owner);
 await setSubscription(owner,{customerId:'cus_G2Sales',subscriptionId:'sub_G2Sales',active:true,tier:'pro',cycle:'month',period:paidPeriod()});
 await setStripeAccount(owner,account,true);
 if(drafts)assert.equal((await addDraftProducts(owner,Array.from({length:50},(_,i)=>({title:'Guide '+i+' '+'€'.repeat(70),summary:'€'.repeat(300),priceCents:1900,link:'https://example.test/guide'})))).ok,true);
 const shop=(await storeForEmail(owner))!,key=await makeKey(shop.sid,'Synthetic sales reader');assert.ok(key.ok);if(!key.ok)throw Error('key');
 return {shop,call:async(reply:unknown)=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,'https://api.stripe.com');assert.equal(url.pathname,'/v1/checkout/sessions');assert.equal(init?.method,'GET');assert.equal(new Headers(init.headers).get('Stripe-Account'),account);calls++;return Response.json(reply);};
  try {const response=await GET(new Request('https://marktmorgen.com/api/v1/sales',{headers:{authorization:'Bearer '+key.key}}));return {status:response.status,body:await response.json(),calls};}
  finally{globalThis.fetch=old;}
 }};
}

const charge={id:'ch_G2Expanded',object:'charge',created:1790000060,amount_refunded:0,disputed:false};
const intent=(extra:Record<string,unknown>={})=>({id:'pi_G2Expanded',object:'payment_intent',latest_charge:charge,...extra});
test('control: a confirmed expanded charge reports its own time and explicit zeros',async()=>{
 const f=await fixture(),r=await f.call(page([session({payment_intent:intent()})]));assert.equal(r.status,200);assert.equal(r.body.data[0].refunded_cents,0);assert.equal(r.body.data[0].disputed,false);assert.equal(r.body.data[0].paid_at,new Date(charge.created*1000).toISOString());
});
test('control: known open checkout and complete foreign checkout remain excluded',async()=>{
 const f=await fixture(),r=await f.call(page([session({status:'open',payment_status:'unpaid'}),session({metadata:{store:'other-store'}})]));assert.equal(r.status,200);assert.deepEqual(r.body.data,[]);
});
for(const row of [{},session({status:'future_status'}),session({payment_status:'future_status'}),session({mode:'future_mode'})])test('unknown checkout classification cannot certify no sales '+JSON.stringify(row),async()=>{
 const f=await fixture(),r=await f.call(page([row]));console.log('G2_SALES_CLASS',JSON.stringify(r));assert.equal(r.status,502);
});
const expansions:[string,Record<string,unknown>][]=[
 ['charge kind missing',{payment_intent:intent({latest_charge:{...charge,object:undefined}})}],
 ['charge is an invoice',{payment_intent:intent({latest_charge:{...charge,object:'invoice'}})}],
 ['charge id missing',{payment_intent:intent({latest_charge:{...charge,id:undefined}})}],
 ['payment resource is an invoice',{payment_intent:intent({object:'invoice'})}],
 ['payment resource primitive',{payment_intent:0}],
 ['payment resource array',{payment_intent:[]}],
 ['payment resource missing on paid amount',{payment_intent:undefined,invoice:undefined}],
 ['invoice resource is a charge',{mode:'subscription',payment_intent:null,invoice:{id:'in_G2Expanded',object:'charge',status_transitions:{paid_at:1790000060}}}],
 ['invoice object incomplete',{mode:'subscription',payment_intent:null,invoice:{}}],
 ['invoice primitive',{mode:'subscription',payment_intent:null,invoice:0}],
 ['invoice array',{mode:'subscription',payment_intent:null,invoice:[]}],
];
for(const [label,patch] of expansions)test('unknown expanded payment must not become confirmed financial fields: '+label,async()=>{
 const f=await fixture(),r=await f.call(page([session(patch)]));console.log('G2_SALES_EXPANSION',label,JSON.stringify(r));assert.equal(r.status,502);
});
test('developer copy does not promise a null currency when missing currency makes the page unavailable',()=>{
 const page=readFileSync('app/developers/page.tsx','utf8');assert.equal(page.includes('<code className="font-mono">currency</code> is <code className="font-mono">null</code> if Stripe did not give'),false);
});
