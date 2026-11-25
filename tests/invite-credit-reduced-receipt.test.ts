/**
 * A credit sent at less than it was written for (#4514: the invoice it was earned on is read again before the credit is
 * sent, and a share is never more than that invoice's share now) is done on Stripe's receipt for the amount actually
 * sent. Main's receipt check (Codex X8, 4b67dcd549) binds the receipt to the exact adjustment asked for; after the merge
 * of main into #4514 that adjustment is the reduced one, so a receipt for it closes the credit at that amount, and a
 * receipt for the amount first written does not. Stripe is a stand-in; nothing real is charged.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claimHandle,setSubscription,storeForEmail} from '@/lib/store';
import {creditKey,OWED_KEY,inviteCode,recordInvite} from '@/lib/creator-invites';
import {settleInvites} from '@/lib/creator-invite-credit';
import {currentInviteTerms} from '@/lib/creator-invite-rules';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
const ID='in_ReducedReceipt01', CUSTOMER='cus_ReducedReceipt01', NOW=Date.UTC(2026,10,21); // an even UTC day: the job runs
// every second day. The invoice paid 2900 and later had 2000 credited back by a credit note: 900 is left, so the share
// now is under the 840 cents written.
const PAID=2900, CREDITED=2000, NOW_WORTH=Math.floor(((PAID-CREDITED)*currentInviteTerms().sharePercent)/100);
let echo:'sent'|'written'='sent';
const posts:string[]=[];
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input));
 if(u.hostname!=='api.stripe.com')throw Error('Unexpected synthetic host');
 if(u.pathname===`/v1/customers/${CUSTOMER}/balance_transactions`){
  if(init?.method==='POST'){
   const b=new URLSearchParams(String(init.body));posts.push(String(b.get('amount')));
   return Response.json({id:'cbtxn_ReducedReceipt01',object:'customer_balance_transaction',customer:CUSTOMER,amount:echo==='sent'?Number(b.get('amount')):-840,currency:b.get('currency'),metadata:{nimbus_invite_credit:b.get('metadata[nimbus_invite_credit]')}});
  }
  return Response.json({object:'list',data:[],has_more:false});
 }
 if(u.pathname===`/v1/invoices/${ID}`)return Response.json({id:ID,object:'invoice',status:'paid',amount_paid:PAID,post_payment_credit_notes_amount:CREDITED,currency:'usd',created:Math.floor(NOW/1000)-40*86400,status_transitions:{paid_at:Math.floor(NOW/1000)-40*86400},parent:{type:'subscription_details',subscription_details:{subscription:'sub_x'}},payments:{object:'list',data:[{payment:{type:'payment_intent',payment_intent:'pi_ReducedReceipt01'}}],has_more:false}});
 if(u.pathname==='/v1/refunds'||u.pathname==='/v1/disputes')return Response.json({object:'list',data:[],has_more:false});
 throw Error('Unexpected synthetic path');
}) as typeof fetch;
async function seed(){
 redis.clear();posts.length=0;
 await claimHandle('reduced-credit@example.test','reducedcredit','Synthetic','');
 await setSubscription('reduced-credit@example.test',{customerId:CUSTOMER,subscriptionId:'sub_ReducedReceipt01',active:true,period:paidPeriod()});
 const s=(await storeForEmail('reduced-credit@example.test'))!;
 const invited=await claimHandle('reduced-invited@example.test','reducedinvited','Synthetic','');
 const code=await inviteCode(s.sid);
 if(!invited.ok||!code||(await recordInvite(invited.store,code,NOW-60*86400*1000))!=='recorded')throw Error('no invite');
 await redis.pipeline([['SET',creditKey(ID),JSON.stringify({id:ID,kind:'share',to:s.sid,from:invited.store.sid,cents:840,cur:'usd',at:Math.floor(NOW/1000),state:'owed'})],['SADD',OWED_KEY,ID]]);
}
const state=async()=>{const [r,on]=await redis.pipeline([['GET',creditKey(ID)],['SISMEMBER',OWED_KEY,ID]]);const c=JSON.parse(String(r));return [c.state,c.cents,on];};
test('the share now is under the amount written (the stand-in is set up as meant)',()=>{
 assert.ok(NOW_WORTH>0&&NOW_WORTH<840);
});
test('a receipt for the reduced amount sent closes the credit at that amount',async()=>{
 process.env.STRIPE_SECRET_KEY='sk_test_reduced_receipt_only';await seed();echo='sent';
 const r=await settleInvites(Date.now()+60000,NOW);
 assert.deepEqual(posts,[String(-NOW_WORTH)]);
 assert.equal(r.added,1);
 assert.deepEqual(await state(),['done',NOW_WORTH,0]);
});
test('a receipt for the amount first written, not the one sent, keeps the credit owed',async()=>{
 process.env.STRIPE_SECRET_KEY='sk_test_reduced_receipt_only';await seed();echo='written';
 const r=await settleInvites(Date.now()+60000,NOW);
 assert.deepEqual(posts,[String(-NOW_WORTH)]);
 assert.equal(r.added,0);
 assert.deepEqual(await state(),['owed',840,1]);
});
