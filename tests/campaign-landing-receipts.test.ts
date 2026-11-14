/**
 * Codex J on #1950: through the real route (app/api/store/campaign-landing),
 * a landing save whose script answered something that only looks like a
 * receipt (a true for 1, a total missing, negative, fractional or unsafe) is
 * never said saved, and nothing is kept (lib/campaign-landing-store.ts,
 * landingsReceipt). Synthetic store and in-memory Redis only.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/campaign-landing/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {addProduct,claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {readLandings} from '@/lib/campaign-landing-store';
import {parsePage} from '@/lib/sales-page';
import {writePage} from '@/lib/sales-page-store';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
globalThis.fetch=(async()=>{throw Error('No outside request in this test');}) as typeof fetch;
async function setup(){
 redis.clear();const owner='landing@example.com';await claimHandle(owner,'landingshop','Landing Shop','');await ensureStatsId(owner);await ensureStoreId(owner);await setSubscription(owner,{customerId:'cus_landing',subscriptionId:'sub_landing',active:true,tier:'creator',period:paidPeriod()});
 const made=await addProduct(owner,'Knife Skills','','40');assert.ok(made.ok);const product=made.product.id;const shop=(await storeForEmail(owner))!;
 await writePage(shop.statsId!,product,parsePage({blocks:[{id:'hero0001',kind:'hero',headline:'Knife Skills',sub:'',media:'none',video:null}]}),shop);
 const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
 const save=(campaign:string)=>POST(new NextRequest('https://marktmorgen.com/api/store/campaign-landing',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'save',product,campaign,headline:'Knife skills course',text:'Practice knife skills safely.',button:'Learn more'})}));
 return{shop,product,save};
}

for(const reply of [[[true,null]],[[1,null]],[[1,false]],[[1,-1]],[[1,.5]],[[1,Number.MAX_SAFE_INTEGER+1]]]){
 test(`a malformed landing acknowledgment ${JSON.stringify(reply)} cannot confirm an unapplied save`,async()=>{
  const {shop,product,save}=await setup();const key=`nl:product:landing:${shop.statsId}:${product}`,original=redis.pipeline;let injected=false;let response!:Response;
  try{redis.pipeline=async commands=>{if(commands.some(c=>c[0]==='EVAL'&&c[4]===key&&String(c[1]).startsWith('-- marktmorgen:landings-write'))){injected=true;return reply;}return original.call(redis,commands);};response=await save('first');}finally{redis.pipeline=original;}
  const kept=await readLandings(shop.statsId,product);
  assert.equal(injected,true);assert.equal(kept.length,0);
  assert.ok(response.status>=400,'an invalid receipt cannot confirm an unapplied save');
 });
}
