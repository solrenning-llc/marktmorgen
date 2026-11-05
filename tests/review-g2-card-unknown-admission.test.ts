/** G2 caller-level return: inherited admission receipt ambiguity, no counter increment applied. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {GET} from '@/app/[handle]/contact/vcard/route';
import ContactPage,{generateMetadata} from '@/app/[handle]/contact/page';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {saveCreatorCard} from '@/lib/creator-card';
import {takePublicRequest,isResting} from '@/lib/traffic';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
globalThis.fetch=async()=>{throw Error('No external service in G2 review');};
const owner='g2-card-admission@example.com',handle='g2cardadmission';
const params=()=>({params:Promise.resolve({handle:'@'+handle}),searchParams:Promise.resolve({})});
async function fixture(){
 redis.clear();await claimHandle(owner,handle,'Synthetic creator','');await ensureStatsId(owner);await ensureStoreId(owner);
 assert.ok(await setSubscription(owner,{customerId:'cus_G2CardAdmission',subscriptionId:'sub_G2CardAdmission',active:true,tier:'creator',period:paidPeriod()}));
 const store=(await storeForEmail(owner))!;
 assert.equal((await saveCreatorCard(store.statsId!,{on:true,name:'Synthetic public card',email:'public@example.com'},store)).ok,true);
 return store;
}

test('control: a real exact counter increment admits the actual download',async()=>{
 await fixture();const original=redis.pipeline.bind(redis);let key='';
 redis.pipeline=async batch=>{for(const c of batch)if(c[0]==='INCRBY'&&String(c[1]).startsWith('nl:traffic:r:'))key=String(c[1]);return original(batch);};
 let response;try{response=await GET(new NextRequest('https://marktmorgen.com/@'+handle+'/contact/vcard'),params());}finally{redis.pipeline=original;}
 assert.equal(response.status,200);assert.ok(key);assert.equal(Number(redis.run(['GET',key])),1);
});
for(const path of ['download','page','metadata'] as const)for(const receipt of [[true],[1,0]])test(`unknown admission cannot authorize card ${path} ${JSON.stringify(receipt)}`,async()=>{
 await fixture();const original=redis.pipeline.bind(redis);let intercepted=0,key='',reads=0;
 redis.pipeline=async batch=>{
  if(batch.length===1&&batch[0][0]==='INCRBY'&&String(batch[0][1]).startsWith('nl:traffic:r:')){intercepted++;key=String(batch[0][1]);return receipt as never;}
  reads+=batch.filter(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:vcard:')).length;return original(batch);
 };
 let delivered=false;try{
  if(path==='download')delivered=(await GET(new NextRequest('https://marktmorgen.com/@'+handle+'/contact/vcard'),params())).status===200;
  if(path==='page')try{delivered=Boolean(await ContactPage(params()));}catch{/* refused/redirect allowed */}
  if(path==='metadata')delivered=String((await generateMetadata(params())).title).includes('Synthetic public card');
 }finally{redis.pipeline=original;}
 assert.equal(intercepted,1);assert.equal(redis.run(['GET',key]),null,'the synthetic reply did not apply any real increment');
 console.log('G2_UNKNOWN_CARD_ADMISSION',JSON.stringify({path,receipt,reads,delivered}));
 assert.equal(reads,0,'the card must not be read after unknown admission');assert.equal(delivered,false,'unknown does not authorize a public card');
});
