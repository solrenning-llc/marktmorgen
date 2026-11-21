import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claimHandle,setSubscription,storeForEmail} from '@/lib/store';
import {creditKey,OWED_KEY} from '@/lib/creator-invites';
import {settleInvites} from '@/lib/creator-invite-credit';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
const ID='in_X8PostReceipt01', CUSTOMER='cus_X8PostReceipt01', NOW=Date.UTC(2026,10,20);
let patch:Record<string,unknown>={},posts:{key:string|null;amount:string|null}[]=[];
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input));
 if(u.hostname!=='api.stripe.com')throw Error('Unexpected synthetic host');
 if(u.pathname===`/v1/customers/${CUSTOMER}/balance_transactions`){
  if(init?.method==='POST'){
   const b=new URLSearchParams(String(init.body));posts.push({key:new Headers(init.headers).get('idempotency-key'),amount:b.get('amount')});
   return Response.json({id:'cbtxn_X8PostReceipt01',object:'customer_balance_transaction',customer:CUSTOMER,amount:Number(b.get('amount')),currency:b.get('currency'),metadata:{nimbus_invite_credit:b.get('metadata[nimbus_invite_credit]')},...patch});
  }
  return Response.json({object:'list',data:[],has_more:false});
 }
 throw Error('Unexpected synthetic path');
}) as typeof fetch;
async function seed(){
 redis.clear();posts=[];
 await claimHandle('post-credit@example.test','postcredit','Synthetic','');
 await setSubscription('post-credit@example.test',{customerId:CUSTOMER,subscriptionId:'sub_X8PostReceipt01',active:true,period:paidPeriod()});
 const s=(await storeForEmail('post-credit@example.test'))!;
 await redis.pipeline([['SET',creditKey(ID),JSON.stringify({id:ID,kind:'share',to:s.sid,from:'f'.repeat(32),cents:840,cur:'usd',at:Math.floor(NOW/1000),state:'owed'})],['SADD',OWED_KEY,ID]]);
}
const state=async()=>{const [r,on]=await redis.pipeline([['GET',creditKey(ID)],['SISMEMBER',OWED_KEY,ID]]);return [JSON.parse(String(r)).state,on];};
for(const [label,wrong] of Object.entries({debit:{amount:840},zero:{amount:0},short:{amount:-839},customer:{customer:'cus_AnotherCustomer'},currency:{currency:'eur'},object:{object:'invoice'},mark:{metadata:{nimbus_invite_credit:'another'}},missing:{metadata:null}})){
 test(`POST with cbtxn id but ${label} evidence keeps the credit owed`,async()=>{
  process.env.STRIPE_SECRET_KEY='sk_test_x8_post_receipt_only';await seed();patch=wrong;
  const first=await settleInvites(Date.now()+60000,NOW);
  assert.equal(first.added,0);assert.equal(first.complete,false);assert.deepEqual(await state(),['owed',1]);
  patch={};const next=await settleInvites(Date.now()+60000,NOW);
  assert.equal(next.added,1);assert.deepEqual(await state(),['done',0]);
  assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.equal(posts[0].amount,'-840');
 });
}
test('matching POST receipt closes precisely this credit',async()=>{
 process.env.STRIPE_SECRET_KEY='sk_test_x8_post_receipt_only';await seed();patch={};
 const r=await settleInvites(Date.now()+60000,NOW);assert.equal(r.added,1);assert.deepEqual(await state(),['done',0]);assert.equal(posts.length,1);
});
