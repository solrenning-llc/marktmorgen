/** G2 extended return; fixture helpers credited to original classification proof9f4c3b4b. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/sales/route';
import {makeKey} from '@/lib/api-keys';
import {addDraftProducts,claimHandle,ensureStatsId,setStripeAccount,setSubscription,storeForEmail} from '@/lib/store';
import {productIds} from '@/lib/catalog';
import {COMMAND,UNIT_COST} from './plan-cost-registry';
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

for(const patch of [
 {status:'future_status'},
 {payment_intent:intent({latest_charge:{...charge,object:'invoice'}})},
 {payment_intent:null,invoice:null},
 {mode:'subscription',payment_intent:null,invoice:{id:'in_G2Partial',object:'invoice',status_transitions:{}}},
])test('one malformed later sale makes the whole page unavailable without leaking the valid prefix '+JSON.stringify(patch),async()=>{
 const f=await fixture(),valid=session({payment_intent:intent()}),bad=session({...patch,id:'cs_test_G2Later'});
 const r=await f.call(page([valid,bad]));assert.equal(r.status,502);assert.equal(r.body.data,undefined);assert.equal(JSON.stringify(r.body).includes('G2_PRIVATE_ANSWER'),false);assert.equal(r.calls,1);
});
test('explicit no-payment-required/null resources remain confirmed with zero amount and no personal answers',async()=>{
 const f=await fixture(),r=await f.call(page([session({payment_status:'no_payment_required',amount_total:0,payment_intent:null,invoice:null})]));
 assert.equal(r.status,200);assert.equal(r.body.data[0].amount_cents,0);assert.equal(r.body.data[0].paid_at,null);assert.equal(r.body.data[0].refunded_cents,null);assert.equal(r.body.data[0].disputed,null);assert.equal(JSON.stringify(r.body).includes('G2_PRIVATE_ANSWER'),false);
});
test('an explicit paid invoice keeps its own moment while refund and dispute remain unknown',async()=>{
 const f=await fixture(),at=1790000060,r=await f.call(page([session({mode:'subscription',payment_intent:null,invoice:{id:'in_G2Paid',object:'invoice',status_transitions:{paid_at:at}}})]));
 assert.equal(r.status,200);assert.equal(r.body.data[0].paid_at,new Date(at*1000).toISOString());assert.equal(r.body.data[0].refunded_cents,null);assert.equal(r.body.data[0].disputed,null);
});

test('the real fifty-listing read has its monetary lower bound covered before the first GET',async()=>{
 const f=await fixture(true),ids=productIds(f.shop),original=redis.pipeline.bind(redis);assert.equal(ids.length,50);
 let paidBeforeFirst:number|null=null,reads=0;const debits:number[]=[];
 redis.pipeline=async commands=>{
  if(commands.some(c=>c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1])))&&paidBeforeFirst===null)paidBeforeFirst=debits.reduce((sum,n)=>sum+n,0);
  const result=await original(commands);for(const c of commands){if(c[0]==='INCRBY'&&String(c[1]).includes(':api:'))debits.push(Number(c[2]));if(c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1])))reads++;}return result;
 };
 try{
  const result=await f.call(page(ids.map((id,i)=>session({id:'cs_test_Monetary'+i,payment_intent:intent(),metadata:{store:handle,product:id}}))));
  assert.equal(result.status,200);assert.equal(result.body.data.length,50);assert.equal(reads,50);assert.equal(paidBeforeFirst,14);
  const lowerBound=reads*COMMAND,budget=paidBeforeFirst!*UNIT_COST.api;console.log('G2_SALES_MONETARY',JSON.stringify({reads,debits,paidBeforeFirst,lowerBound,budget}));assert.ok(lowerBound<=budget);assert.ok(lowerBound>UNIT_COST.api,'one-unit counterexample is genuinely insufficient in money, independently of byte thresholds');
 }finally{redis.pipeline=original;}
});
