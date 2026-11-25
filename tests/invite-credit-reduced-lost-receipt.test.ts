/**
 * A reduced credit whose receipt was lost is written down at what Stripe moved, never at the amount first written
 * (Claude 4's LOW on #4514 @7717e5258d, 7073362258; Board #5285). A share written at 840 cents is read again as worth
 * less (its invoice had money credited back) and sent at that amount, under its own idempotency key; Stripe creates
 * it, but the answer is lost, so the credit stays owed. The next run finds the transaction on the customer's balance
 * by its mark and, before this fix, wrote `{ ...credit, state: "done" }`: 840 recorded as credited while less was.
 * Now the row found is held to the credit as a receipt is (a whole negative amount no larger than written, the
 * credit's currency, the customer when the row names one) and the record takes its amount; anything else keeps the
 * credit owed for the next run. Stripe is a stand-in; nothing real is charged.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claimHandle,setSubscription,storeForEmail} from '@/lib/store';
import {creditKey,OWED_KEY,inviteCode,recordInvite} from '@/lib/creator-invites';
import {settleInvites} from '@/lib/creator-invite-credit';
import {currentInviteTerms} from '@/lib/creator-invite-rules';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
const ID='in_ReducedLost00001', CUSTOMER='cus_ReducedLost001', NOW=Date.UTC(2026,10,21); // an even UTC day: the job runs
// every second day. The invoice paid 2900 and later had 2000 credited back by a credit note, so the share now is under
// the 840 cents written: the amount the lost send moved.
const PAID=2900, CREDITED=2000, NOW_WORTH=Math.floor(((PAID-CREDITED)*currentInviteTerms().sharePercent)/100);
/** The row the lost send left on the customer's balance, as the next run's history read finds it. */
let landed:Record<string,unknown>={};
const posts:string[]=[];
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input));
 if(u.hostname!=='api.stripe.com')throw Error('Unexpected synthetic host');
 if(u.pathname===`/v1/customers/${CUSTOMER}/balance_transactions`){
  if(init?.method==='POST'){posts.push(String(new URLSearchParams(String(init.body)).get('amount')));return Response.json({error:{message:'synthetic: no second send expected'}},{status:400});}
  return Response.json({object:'list',data:[landed],has_more:false});
 }
 if(u.pathname===`/v1/invoices/${ID}`)return Response.json({id:ID,object:'invoice',status:'paid',amount_paid:PAID,post_payment_credit_notes_amount:CREDITED,currency:'usd',created:Math.floor(NOW/1000)-40*86400,status_transitions:{paid_at:Math.floor(NOW/1000)-40*86400},parent:{type:'subscription_details',subscription_details:{subscription:'sub_x'}},payments:{object:'list',data:[{payment:{type:'payment_intent',payment_intent:'pi_ReducedLost00001'}}],has_more:false}});
 if(u.pathname==='/v1/refunds'||u.pathname==='/v1/disputes')return Response.json({object:'list',data:[],has_more:false});
 throw Error('Unexpected synthetic path');
}) as typeof fetch;
const row=(over:Record<string,unknown>={})=>({id:'cbtxn_ReducedLost01',object:'customer_balance_transaction',customer:CUSTOMER,amount:-NOW_WORTH,currency:'usd',metadata:{nimbus_invite_credit:ID},...over});
async function seed(found:Record<string,unknown>){
 redis.clear();posts.length=0;landed=found;
 await claimHandle('reduced-lost@example.test','reducedlost','Synthetic','');
 await setSubscription('reduced-lost@example.test',{customerId:CUSTOMER,subscriptionId:'sub_ReducedLost001',active:true,period:paidPeriod()});
 const s=(await storeForEmail('reduced-lost@example.test'))!;
 const invited=await claimHandle('reduced-lost-invited@example.test','reducedlostinv','Synthetic','');
 const code=await inviteCode(s.sid);
 if(!invited.ok||!code||(await recordInvite(invited.store,code,NOW-60*86400*1000))!=='recorded')throw Error('no invite');
 await redis.pipeline([['SET',creditKey(ID),JSON.stringify({id:ID,kind:'share',to:s.sid,from:invited.store.sid,cents:840,cur:'usd',at:Math.floor(NOW/1000),state:'owed'})],['SADD',OWED_KEY,ID]]);
}
const state=async()=>{const [r,on]=await redis.pipeline([['GET',creditKey(ID)],['SISMEMBER',OWED_KEY,ID]]);const c=JSON.parse(String(r));return [c.state,c.cents,c.txn??null,on];};
test('the share now is under the amount written (the stand-in is set up as meant)',()=>{
 assert.ok(NOW_WORTH>0&&NOW_WORTH<840);
});
test('a reduced send found on the balance is recorded at what it moved, not at the 840 first written',async()=>{
 process.env.STRIPE_SECRET_KEY='sk_test_reduced_lost_only';await seed(row());
 const r=await settleInvites(Date.now()+60000,NOW);
 assert.deepEqual(posts,[],'never sent again');
 assert.equal(r.added,1);
 assert.deepEqual(await state(),['done',NOW_WORTH,'cbtxn_ReducedLost01',0]);
});
test('control: a send of the whole amount found on the balance is recorded at the whole amount',async()=>{
 process.env.STRIPE_SECRET_KEY='sk_test_reduced_lost_only';await seed(row({amount:-840}));
 const r=await settleInvites(Date.now()+60000,NOW);
 assert.deepEqual([posts,r.added],[[],1]);
 assert.deepEqual(await state(),['done',840,'cbtxn_ReducedLost01',0]);
});
test('a row found on the balance that is not a credit of this one keeps it owed, unsent',async()=>{
 const odd:Record<string,Record<string,unknown>>={
  'more than written':{amount:-841},'a debit':{amount:NOW_WORTH},'zero':{amount:0},'not whole cents':{amount:-450.5},
  'an amount as text':{amount:String(-NOW_WORTH)},'no amount':{amount:undefined},'another currency':{currency:'eur'},
  'no currency':{currency:undefined},'another customer':{customer:'cus_AnotherCustomer'},
 };
 for(const [label,over] of Object.entries(odd)){
  process.env.STRIPE_SECRET_KEY='sk_test_reduced_lost_only';await seed(row(over));
  const r=await settleInvites(Date.now()+60000,NOW);
  assert.deepEqual([posts,r.added],[[],0],label);
  assert.deepEqual(await state(),['owed',840,null,1],label);
 }
});
