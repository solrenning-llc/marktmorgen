// #4687: a sales page that lists the same checkout twice, or repeats the cursor session, is unknown (502).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/sales/route';
import {makeKey} from '@/lib/api-keys';
import {addDraftProducts,claimHandle,ensureStatsId,setStripeAccount,setSubscription,storeForEmail} from '@/lib/store';
import {productIds} from '@/lib/catalog';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
const owner='m0-api-sales@example.test',handle='m0-api-sales',account='acct_M0ApiSales';
// A paid checkout carries its expanded payment, as Stripe sends it: one without it is unknown (Codex G2's second proof on #1899).
const session=(patch:Record<string,unknown>={})=>({id:'cs_test_M0Sale',object:'checkout.session',status:'complete',payment_status:'paid',mode:'payment',created:1790000000,amount_total:4900,currency:'eur',total_details:{amount_discount:0},metadata:{store:handle,title:'Known guide'},custom_fields:[{key:'private',text:{value:'G2_PRIVATE_ANSWER'}}],payment_intent:{id:'pi_test_M0Sale',object:'payment_intent',latest_charge:{id:'ch_test_M0Sale',object:'charge',created:1790000060,amount_refunded:0,disputed:false}},...patch});
const page=(data:unknown[]=[],has_more=false)=>({object:'list',data,has_more});
async function fixture(drafts=false){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_m0_sales_synthetic';
 await claimHandle(owner,handle,'Synthetic sales','');await ensureStatsId(owner);
 await setSubscription(owner,{customerId:'cus_M0Sales',subscriptionId:'sub_M0Sales',active:true,tier:'pro',cycle:'month',period:paidPeriod()});
 await setStripeAccount(owner,account,true);
 if(drafts)assert.equal((await addDraftProducts(owner,Array.from({length:50},(_,i)=>({title:'Guide '+i+' '+'€'.repeat(70),summary:'€'.repeat(300),priceCents:1900,link:'https://example.test/guide'})))).ok,true);
 const shop=(await storeForEmail(owner))!,key=await makeKey(shop.sid,'Synthetic sales reader');assert.ok(key.ok);if(!key.ok)throw Error('key');
 return {shop,call:async(reply:unknown,cursor?:string)=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,'https://api.stripe.com');assert.equal(url.pathname,'/v1/checkout/sessions');assert.equal(init?.method,'GET');assert.equal(new Headers(init.headers).get('Stripe-Account'),account);calls++;return Response.json(reply);};
  try {const response=await GET(new Request('https://marktmorgen.com/api/v1/sales'+(cursor?'?cursor='+cursor:''),{headers:{authorization:'Bearer '+key.key}}));return {status:response.status,body:await response.json(),calls};}
  finally{globalThis.fetch=old;}
 }};
}

test('control: two distinct sessions on a page are two sales',async()=>{
 const f=await fixture(),r=await f.call(page([session({id:'cs_test_M0A'}),session({id:'cs_test_M0B'})]));
 assert.equal(r.status,200);assert.equal(r.body.data.length,2);
});
test('a page that lists the same session twice is unknown (502), not two sales',async()=>{
 const f=await fixture(),a=session({id:'cs_test_M0A'}),r=await f.call(page([a,a]));
 assert.equal(r.status,502);
});
test('a next page that repeats the starting_after session with has_more is unknown (502), not the same cursor again',async()=>{
 const f=await fixture(),a=session({id:'cs_test_M0A'});
 const r=await f.call(page([a],true),'cs_test_M0A');
 assert.equal(r.status,502);
});
