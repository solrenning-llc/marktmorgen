/** Independent review controls; synthetic records and intercepted HTTP only. */
import { recentSales, rememberSale } from '@/lib/recent-sales';
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from '@/lib/store';
import { store as redis } from './redis-stub';
import { done, is } from './check';
process.env.STRIPE_SECRET_KEY='sk_test_recent_review_fixture_only';
let reply:unknown,requests=0;
globalThis.fetch=(async()=>{requests++;return new Response(JSON.stringify(reply),{status:200});}) as typeof fetch;
async function main(){
 redis.clear();const owner='recent-review@example.test';await claimHandle(owner,'recent-review-fixture','Review fixture','');await ensureStatsId(owner);
 const made=await addProduct(owner,'Guide','','29',null);if(!made.ok)throw Error('Fixture product missing');
 const store={...(await storeForEmail(owner))!,stripeAccountId:'acct_review_fixture',recentSales:true};const now=Math.floor(Date.now()/1000);
 const payment='pi_review123456';await rememberSale(store,{id:'cs_live_review12345678901234567890',mode:'payment',created:now-60,amount_total:2900,payment_intent:payment,metadata:{product:made.product.id}});
 const cache=`nl:recent:feed:${store.statsId}`;
 for(const status of ['pending','requires_action','succeeded','failed','canceled',null,true,1,'SUCCEEDED'])for(const at of [0,49,99]){
  await redis.pipeline([['DEL',cache]]);const rows=Array.from({length:100},()=>({status:'succeeded',payment_intent:'pi_unrelated123456'}));
  rows[at]={status,payment_intent:payment} as typeof rows[number];reply={object:'list',data:rows,has_more:false};const before=requests;
  const known=typeof status==='string'&&['pending','requires_action','succeeded','failed','canceled'].includes(status);
  is(`100 rows/${String(status)}/${at}: feed`,(await recentSales(store)).length,status==='failed'||status==='canceled'?1:0);
  is(`100 rows/${String(status)}/${at}: unknown is not cached`,(await redis.pipeline([['GET',cache]]))[0]===null,!known);
  is(`100 rows/${String(status)}/${at}: one existing read`,requests-before,1);
 }
 await redis.pipeline([['DEL',cache]]);reply={object:'list',data:[{status:'succeeded',payment_intent:{id:payment}}],has_more:false};
 is('unexpected expanded identity is unknown',await recentSales(store),[]);is('expanded unknown is not cached',(await redis.pipeline([['GET',cache]]))[0],null);
 reply={object:'list',data:[],has_more:false};is('next confirmed request can retry',(await recentSales(store)).length,1);
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
