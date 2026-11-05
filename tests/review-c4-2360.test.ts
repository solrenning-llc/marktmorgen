/** Claude 4 review of #2360: real settleShares, synthetic Stripe/Redis only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {settleShares} from '@/lib/share-settle';
import {SHARING_INDEX} from '@/lib/platform-share';
import {claimHandle,setStripeAccount,storeForEmail,storeRef} from '@/lib/store';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
const acct='acct_Receipt0001',now=1800000000,saved=1799827200;
type Opt={subs?:unknown[];events?:unknown[];chargeFails?:boolean;feeReply?:unknown};
async function world(o:Opt){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_fee_refund_only_a_stand_in';
 const owner='c4-review-owner@example.test';
 assert.equal((await claimHandle(owner,'c4-review-owner','Synthetic shop','')).ok,true);
 assert.equal((await setStripeAccount(owner,acct,true)).ok,true);
 const ref=storeRef((await storeForEmail(owner))!);
 await redis.pipeline([['SADD',SHARING_INDEX,ref],['HSET','nl:share:applied',ref,'625'],['HSET','nl:share:read-until',ref,String(saved)]]);
 const calls:{method:string;url:URL;body:string}[]=[];const old=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';calls.push({method,url,body:String(init?.body??'')});
  if(url.pathname==='/v1/application_fees')return Response.json({object:'list',has_more:false,data:[]});
  if(url.pathname==='/v1/events')return Response.json({object:'list',has_more:false,data:o.events??[]});
  if(url.pathname.startsWith('/v1/charges/')){
   if(o.chargeFails)return Response.json({error:{type:'api_error',message:'synthetic outage'}},{status:500});
   return Response.json({id:'ch_C4Review0001',application_fee:'fee_C4Review0001'});
  }
  if(url.pathname==='/v1/application_fees/fee_C4Review0001')return Response.json(o.feeReply);
  if(url.pathname==='/v1/subscriptions/search')return Response.json({object:'search_result',has_more:false,next_page:null,data:o.subs??[]});
  if(method==='POST'&&url.pathname.startsWith('/v1/subscriptions/'))return Response.json({id:url.pathname.split('/').pop(),object:'subscription'});
  throw Error('Unexpected synthetic call '+method+' '+url.pathname);
 };
 try{const counts=await settleShares(Date.now()+60000,now,false);const [readUntil,applied]=await redis.pipeline([['HGET','nl:share:read-until',ref],['HGET','nl:share:applied',ref]]);return {counts,calls,readUntil,applied};}finally{globalThis.fetch=old;}
}
test('C4-A: a membership with no fee (application_fee_percent null) must not block lowering the others',async()=>{
 const {counts,calls,applied}=await world({subs:[{id:'sub_C4NoFee0001',status:'active',application_fee_percent:null},{id:'sub_C4Old00001',status:'active',application_fee_percent:6.25}]});
 const posts=calls.filter(c=>c.method==='POST');
 assert.equal(posts.length,1,'the 6.25% membership must be lowered to the plan target 0');
 assert.equal(posts[0]?.url.pathname,'/v1/subscriptions/sub_C4Old00001');
 assert.equal(new URLSearchParams(posts[0]?.body).get('application_fee_percent'),'0.00');
 assert.equal(counts.failed,0);assert.equal(counts.complete,true);assert.equal(applied,null);
});
test('C4-B: a dispute event whose charge read fails must not be skipped as done',async()=>{
 const {counts,readUntil}=await world({chargeFails:true,events:[{id:'evt_C4Dispute001',data:{object:{charge:'ch_C4Review0001'}}}]});
 assert.equal(counts.complete,false,'a lost-dispute fee that was never read cannot be certified complete');
 assert.equal(counts.failed>=1,true);
 assert.equal(readUntil,String(saved),'the cursor must not move past evidence never read');
});
test('C4-C: a malformed application fee reply on the refund path must not be skipped as done',async()=>{
 const {counts,readUntil}=await world({feeReply:{},events:[{id:'evt_C4Refund0001',data:{object:{id:'ch_C4Review0001',application_fee:'fee_C4Review0001'}}}]});
 assert.equal(counts.complete,false);assert.equal(counts.failed>=1,true);
 assert.equal(readUntil,String(saved));
});
test('C4-A2: switching the commission on applies it to memberships sold with no fee (null percent)',async()=>{
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_fee_refund_only_a_stand_in';
 const {setSubscription}=await import('@/lib/store');
 const owner='c4-review-up@example.test',N=Math.floor(Date.now()/1000);
 assert.equal((await claimHandle(owner,'c4-review-up','Synthetic shop','')).ok,true);
 assert.equal((await setStripeAccount(owner,acct,true)).ok,true);
 await setSubscription(owner,{customerId:'cus_C4Review0001',subscriptionId:'sub_C4Plan00001',active:true,tier:'creator',cycle:'month',trialEnds:N-10*86_400,shared:true,period:paidPeriod()});
 const ref=storeRef((await storeForEmail(owner))!);
 const calls:{method:string;url:URL;body:string}[]=[];const old=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';calls.push({method,url,body:String(init?.body??'')});
  if(url.pathname==='/v1/application_fees'||url.pathname==='/v1/events')return Response.json({object:'list',has_more:false,data:[]});
  if(url.pathname==='/v1/subscriptions/search')return Response.json({object:'search_result',has_more:false,next_page:null,data:[{id:'sub_C4NoFee0001',status:'active',application_fee_percent:null}]});
  if(method==='POST'&&url.pathname.startsWith('/v1/subscriptions/'))return Response.json({id:'sub_C4NoFee0001',object:'subscription'});
  throw Error('Unexpected synthetic call '+method+' '+url.pathname);
 };
 try{
  const counts=await settleShares(Date.now()+60000,N,true);
  const posts=calls.filter(c=>c.method==='POST');
  assert.equal(posts.length,1,'the membership sold before the share must start paying the plan rate');
  assert.equal(new URLSearchParams(posts[0]?.body).get('application_fee_percent'),'6.25');
  assert.equal(counts.failed,0);
  const [applied]=await redis.pipeline([['HGET','nl:share:applied',ref]]);assert.equal(applied,'625');
 }finally{globalThis.fetch=old;}
});
