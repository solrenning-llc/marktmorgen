/** #3395 plus main's exact membership reader: unknown is not ended, and a known other holding still opens its door. */
import * as access from '@/lib/community-access';
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { freshConfig } from '@/lib/community';
import { paidPeriod } from './billing-period-fixture';
import { store as redis } from './redis-stub';
import { done, is, part } from './check';

let rows:Record<string,unknown>[]=[];
let reads=0;
globalThis.fetch=async(input)=>{
 const url=new URL(String(input));
 if(url.hostname!=='api.stripe.com')throw Error('unmocked provider forbidden');
 reads++;
 if(url.pathname==='/v1/checkout/sessions')return new Response(JSON.stringify({object:'list',data:rows,has_more:false}));
 if(url.pathname==='/v1/payment_intents')return new Response(JSON.stringify({object:'list',data:[],has_more:false}));
 throw Error('unexpected synthetic read '+url.pathname);
};
const paid=(n:number,product:string,subscription:unknown)=>({id:`cs_test_merge3395${n}`,object:'checkout.session',status:'complete',payment_status:'paid',mode:'subscription',created:1700000000,customer:null,metadata:{store:'merge3395',product},payment_intent:null,subscription});
const outcome=(p:Promise<unknown>)=>p.then(v=>['answered',v],e=>['unknown',e instanceof access.UnreadPurchasesError?e.lasting:'other']);

async function main(){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_merge_membership_only';
 const owner='merge3395-owner@example.test';await claimHandle(owner,'merge3395','Synthetic Store','');await ensureStatsId(owner);await ensureListId(owner);
 await setStripeAccount(owner,'acct_1TestPaidUnkn01',true);await setSubscription(owner,{customerId:'cus_Merge3395',subscriptionId:'sub_Merge3395',active:true,period:paidPeriod()});
 const products:string[]=[];
 for(const name of ['Pass A','Pass B']){const made=await addProduct(owner,name,'','12',null);if(!made.ok)throw Error('fixture product');await setProductLink(owner,made.product.id,'https://example.test/fixture');products.push(made.product.id);}
 await setCommunity(owner,true);const shop=(await storeForEmail(owner))!,[a,b]=products;
 const config={...freshConfig(shop.name),access:[a,b]};
 const shapes:unknown[]=[null,'sub_unexpanded0001',[],{}, {status:null},{status:17}];
 for(const [i,shape] of shapes.entries()){
  part('Unreadable expanded membership '+i);rows=[paid(i,a,shape)];
  is('paidForAny throws a transient unknown',await outcome(access.paidForAny(shop,`direct${i}@example.test`,new Set([a]))),['unknown',false]);
  const email=`holding${i}@example.test`,h=await access.holdingsOf(shop,config,email);
  is('a shared reading is not whole',h.whole,false);is('the unread door is unknown',access.heldAnswer(h,[a]),'unknown');is('unknown shape is not a lasting volume cap',access.unknownForGood(h),false);
  is('a strict door never confirms no',await outcome(access.holdsProductsOrThrow(shop,[a],`strict${i}@example.test`,`synthetic:strict:${i}`,'v1')),['unknown',false]);
  rows=[paid(100+i,a,{status:'active'})];const before=reads;const repaired=await access.holdingsOf(shop,config,email);
  is('unknown was not cached as no',reads>before,true);is('a next known active answer opens',access.heldAnswer(repaired,[a]),true);
  rows=[paid(200+i,a,shape),paid(300+i,b,{status:'active'})];const partial=await access.holdingsOf(shop,config,`partial${i}@example.test`);
  is('a known other holding survives',access.heldAnswer(partial,[b]),true);is('its unknown sibling remains unknown',access.heldAnswer(partial,[a]),'unknown');is('the partial reading remains retryable',partial.lasting,false);
  rows=[paid(400+i,a,shape),paid(500+i,a,{status:'active'})];is('another valid purchase still opens any door',await access.paidForAny(shop,`other${i}@example.test`,new Set([a])),true);
  const settled=await access.holdingsOf(shop,config,`settled${i}@example.test`);is('a later known purchase settles that product',settled.whole,true);is('an unrelated absent product stays a known no',access.heldAnswer(settled,[b]),false);
 }
 part('Known states keep main semantics');
 for(const [i,state] of ['canceled','unpaid','paused','some-other-string'].entries()){rows=[paid(600+i,a,{status:state})];is(state+' is still ended',await access.paidForAny(shop,`ended${i}@example.test`,new Set([a])),false);}
 for(const [i,sub] of [{status:'active'},{status:'trialing'},{status:'past_due',latest_invoice:{next_payment_attempt:1800000000}}].entries()){rows=[paid(700+i,a,sub)];is('known live '+i,await access.paidForAny(shop,`live${i}@example.test`,new Set([a])),true);}
 rows=[paid(800,a,{status:'past_due',latest_invoice:{next_payment_attempt:null}})];is('past due with no retry remains ended',await access.paidForAny(shop,'noretry@example.test',new Set([a])),false);
 done();
}
void main();
