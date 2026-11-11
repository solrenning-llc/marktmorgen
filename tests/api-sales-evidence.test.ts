/**
 * Codex G2 on #1899, kept as permanent tests: through the real route, a sale whose amount or currency Stripe did not
 * send as one, a list that is not one, an own checkout without its status, and a cursor missing where more comes, are
 * each unknown (502), never a confirmed zero, USD or end; and the listings read for titles are paid before they are read.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '@/app/api/v1/sales/route';
import {makeKey} from '@/lib/api-keys';
import {addDraftProducts,claimHandle,ensureStatsId,setStripeAccount,setSubscription,storeForEmail} from '@/lib/store';
import {productIds} from '@/lib/catalog';
import {paidPeriod} from './billing-period-fixture';
import {listingKeysRead,listingValues} from './listing-reads';
import {store as redis} from './redis-stub';
const owner='g2-api-sales@example.test',handle='g2-api-sales',account='acct_G2ApiSales';
// A paid checkout carries its expanded payment, as Stripe sends it: one without it is unknown (Codex G2's second proof on #1899).
const session=(patch:Record<string,unknown>={})=>({id:'cs_test_G2Sale',object:'checkout.session',status:'complete',payment_status:'paid',mode:'payment',created:1790000000,amount_total:4900,currency:'eur',total_details:{amount_discount:0},metadata:{store:handle,title:'Known guide'},custom_fields:[{key:'private',text:{value:'G2_PRIVATE_ANSWER'}}],payment_intent:{id:'pi_test_G2Sale',object:'payment_intent',latest_charge:{id:'ch_test_G2Sale',object:'charge',created:1790000060,amount_refunded:0,disputed:false}},...patch});
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
test('control: known sale and custom answers remain correctly scoped',async()=>{
 const f=await fixture(),r=await f.call(page([session(),session({id:'cs_test_Foreign',metadata:{store:'another-store'}})]));
 assert.equal(r.status,200);assert.equal(r.calls,1);assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].amount_cents,4900);assert.equal(r.body.data[0].currency,'eur');assert.equal(JSON.stringify(r.body).includes('G2_PRIVATE_ANSWER'),false);
});
test('control: explicit zero amount and USD remain a confirmed zero',async()=>{
 const f=await fixture(),r=await f.call(page([session({amount_total:0,currency:'usd',payment_status:'no_payment_required'})]));
 assert.equal(r.status,200);assert.equal(r.body.data[0].amount_cents,0);assert.equal(r.body.data[0].currency,'usd');
});
for(const bad of [undefined,null,'4900',-1,1.5,Number.MAX_SAFE_INTEGER+1])test('unknown/invalid amount must not be a confirmed sale: '+String(bad),async()=>{
 const f=await fixture(),r=await f.call(page([session({amount_total:bad})]));console.log('G2_BAD_AMOUNT',String(bad),JSON.stringify(r));assert.equal(r.status,502);
});
for(const bad of [undefined,null,'',{},'US'])test('unknown/invalid currency must not become USD or a confirmed currency: '+String(bad),async()=>{
 const f=await fixture(),r=await f.call(page([session({currency:bad})]));console.log('G2_BAD_CURRENCY',String(bad),JSON.stringify(r));assert.equal(r.status,502);
});
for(const reply of [page([],true),page([{}],true),{data:[],has_more:false},page([session({status:undefined})]),page([session({payment_status:undefined})])])test('unconfirmed list/status/cursor cannot certify a terminal or empty page '+JSON.stringify(reply),async()=>{
 const f=await fixture(),r=await f.call(reply);console.log('G2_BAD_PAGE',JSON.stringify(r));assert.equal(r.status,502);
});
test('fifty own product lookups must fit the allowance paid before their reads',async()=>{
 const f=await fixture(true),ids=productIds(f.shop),base=redis.pipeline.bind(redis);assert.equal(ids.length,50);
 let bytes=0,reads=0,paidBeforeFirst:number|null=null;const debits:number[]=[];
 redis.pipeline=async batch=>{
  if(batch.some(c=>listingKeysRead(c).length>0)&&paidBeforeFirst===null)paidBeforeFirst=debits.reduce((a,b)=>a+b,0);
  const answers=await base(batch);
  batch.forEach(c=>{if(c[0]==='INCRBY'&&String(c[1]).includes(':api:'))debits.push(Number(c[2]));});
  // Each listing record read, alone or in an MGET (lib/catalog.ts getMany), and the bytes it answered.
  for(const r of listingValues(batch,answers)){reads++;bytes+=Buffer.byteLength(String(r.value));}return answers;
 };
 try {
  const r=await f.call(page(ids.map((id,i)=>session({id:'cs_test_Cost'+i,metadata:{store:handle,product:id}}))));
  assert.equal(r.status,200);assert.equal(r.body.data.length,50);assert.ok(reads>=20);
  console.log('G2_COST',JSON.stringify({reads,bytes,debits,paidBeforeFirst}));
  assert.ok(bytes<=20000*(paidBeforeFirst??0),'actual listing bytes exceed the API units admitted before their GETs');
 }finally{redis.pipeline=base;}
});
