import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/campaign-landing/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {addProduct,claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {readLandings,saveLanding,dropLandings} from '@/lib/campaign-landing-store';
import {type CampaignLanding} from '@/lib/campaign-landing';
import {MAX_HEADLINE,MAX_SUBHEADLINE,parsePage} from '@/lib/sales-page';
import {writePage} from '@/lib/sales-page-store';
import {dataKey} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
import {ROOM} from './data-room';
globalThis.fetch=(async()=>{throw Error('No external calls in synthetic review');}) as typeof fetch;
const latch=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};};
const landing=(campaign:string,headline='Knife skills course',sub='Practice knife skills safely.'):CampaignLanding=>({campaign,headline,sub,button:'Learn more'});
async function setup(){
 redis.clear();const owner='landing@example.com';await claimHandle(owner,'landingshop','Landing Shop','');await ensureStatsId(owner);await ensureStoreId(owner);await setSubscription(owner,{customerId:'cus_landing',subscriptionId:'sub_landing',active:true,tier:'creator',period:paidPeriod()});
 const made=await addProduct(owner,'Knife Skills','','40');assert.ok(made.ok);const product=made.product.id;const shop=(await storeForEmail(owner))!;
 await writePage(shop.statsId!,product,parsePage({blocks:[{id:'hero0001',kind:'hero',headline:'Knife Skills',sub:'',media:'none',video:null}]}),shop);
 const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
 const save=(campaign:string)=>POST(new NextRequest('https://marktmorgen.com/api/store/campaign-landing',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'save',product,campaign,headline:'Knife skills course',text:'Practice knife skills safely.',button:'Learn more'})}));
 return{shop,product,save};
}
test('a partial old-list reply cannot erase other campaign landings through the real POST',async()=>{
 const {shop,product,save}=await setup();assert.equal((await save('first')).status,200);const key=`nl:product:landing:${shop.statsId}:${product}`,original=redis.pipeline;let injected=false;let response!:Response;
 try{redis.pipeline=async commands=>{if(!injected&&commands.some(c=>c[0]==='GET'&&c[1]===key)){injected=true;return [];}return original.call(redis,commands);};response=await save('second');}finally{redis.pipeline=original;}
 const kept=await readLandings(shop.statsId,product);console.log('PARTIAL_LANDINGS',response.status,kept.map(x=>x.campaign));assert.equal(injected,true);assert.ok(response.status>=400,'unconfirmed prior content must not be replaced');
});
test('an unacknowledged unpersisted landing write cannot report saved through POST',async()=>{
 const {shop,product,save}=await setup();const key=`nl:product:landing:${shop.statsId}:${product}`,original=redis.pipeline;let injected=false;let response!:Response;
 try{redis.pipeline=async commands=>{if(commands.some(c=>((c[0]==='SET'&&c[1]===key)||(c[0]==='EVAL'&&c[4]===key&&String(c[1]).startsWith('-- marktmorgen:landings-write'))))){injected=true;return [];}return original.call(redis,commands);};response=await save('first');}finally{redis.pipeline=original;}
 console.log('MISSING_LANDING_ACK',response.status,(await readLandings(shop.statsId,product)).length);assert.equal(injected,true);assert.ok(response.status>=400,'a landing must not be confirmed saved without a write acknowledgement');
});
test('a late larger landing save cannot use the smaller concurrent slot',async()=>{
 redis.clear();const stats='l'.repeat(16),product='p1',key=`nl:product:landing:${stats}:${product}`,original=redis.pipeline,arrived=latch(),resume=latch();let held=false;
 const big=landing('first','x'.repeat(MAX_HEADLINE),'y'.repeat(MAX_SUBHEADLINE));
 try{redis.pipeline=async commands=>{if(!held&&commands.some(c=>((c[0]==='SET'&&c[1]===key)||(c[0]==='EVAL'&&c[4]===key&&String(c[1]).startsWith('-- marktmorgen:landings-write')))&&c.map(String).some(x=>x.includes(big.headline)))){held=true;arrived.release();await resume.promise;}return original.call(redis,commands);};const a=saveLanding(stats,product,big,ROOM);await arrived.promise;assert.equal(await saveLanding(stats,product,landing('second'),ROOM),'saved');resume.release();assert.equal(await a,'saved');}finally{resume.release();redis.pipeline=original;}
 const [raw,slot]=await redis.pipeline([['GET',key],['HGET',dataKey(ROOM)!,'al:p1']]);const required=dataBytes([String(raw)],1);console.log('LATE_LANDING',required,Number(slot));assert.ok(Number(slot)>=required,'the stored landing must remain fully counted');
});
test('dropping the old landing cannot release the slot of a later save',async()=>{
 redis.clear();const stats='l'.repeat(16),product='p1',key=`nl:product:landing:${stats}:${product}`,original=redis.pipeline,arrived=latch(),resume=latch();let held=false;await saveLanding(stats,product,landing('first'),ROOM);
 try{redis.pipeline=async commands=>{const result=await original.call(redis,commands);if(!held&&commands.some(c=>((c[0]==='DEL'&&c[1]===key)||(c[0]==='EVAL'&&c[4]===key&&String(c[1]).startsWith('-- marktmorgen:landings-drop'))))){held=true;arrived.release();await resume.promise;}return result;};const drop=dropLandings(stats,product,ROOM);await arrived.promise;assert.equal(await saveLanding(stats,product,landing('second'),ROOM),'saved');resume.release();await drop;}finally{resume.release();redis.pipeline=original;}
 const [raw,slot]=await redis.pipeline([['GET',key],['HGET',dataKey(ROOM)!,'al:p1']]);assert.ok(raw);const required=dataBytes([String(raw)],1);console.log('LATE_LANDING_DROP',required,Number(slot));assert.ok(Number(slot)>=required,'old deletion cannot release a later write capacity');
});


for(const reply of [[[true,null]],[[1,null]],[[1,false]],[[1,-1]],[[1,.5]],[[1,Number.MAX_SAFE_INTEGER+1]]]){
 test(`a malformed landing acknowledgment ${JSON.stringify(reply)} cannot confirm an unapplied save`,async()=>{
  const {shop,product,save}=await setup();const key=`nl:product:landing:${shop.statsId}:${product}`,original=redis.pipeline;let injected=false;let response!:Response;
  try{redis.pipeline=async commands=>{if(commands.some(c=>c[0]==='EVAL'&&c[4]===key&&String(c[1]).startsWith('-- marktmorgen:landings-write'))){injected=true;return reply;}return original.call(redis,commands);};response=await save('first');}finally{redis.pipeline=original;}
  const kept=await readLandings(shop.statsId,product);
  console.log('INVALID_LANDING_ACK',JSON.stringify(reply),response.status,kept.length);
  assert.equal(injected,true);assert.equal(kept.length,0);
  assert.ok(response.status>=400,'an invalid receipt cannot confirm an unapplied save');
 });
}
