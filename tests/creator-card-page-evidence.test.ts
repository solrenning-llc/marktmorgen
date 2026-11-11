// Codex G2's proof on #1962 (codex/g2-review-1962-card-admission-red, 3ca400bd5), kept as permanent tests:
// the creator card's public reads (the Save contact file, the contact page and its title) are paid
// for before the card is read, and never given while the store's admission is refused.
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
test('control: a deliberately published synthetic card downloads with no-store',async()=>{
 await fixture();const response=await GET(new NextRequest('https://marktmorgen.com/@'+handle+'/contact/vcard'),params());
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(await response.text(),/FN:Synthetic public card/);
});
for(const path of ['download','page','metadata'])test('no known paid billing window cannot authorize new card '+path,async()=>{
 await fixture();assert.ok(await setSubscription(owner,{active:true,period:null}));const store=(await storeForEmail(owner))!;
 assert.equal(await takePublicRequest(store),false);assert.equal(await isResting(store),true);
 const base=redis.pipeline.bind(redis),commands:(string|number)[][]=[];
 redis.pipeline=async batch=>{commands.push(...batch);return base(batch);};
 try{
  let delivered=false;
  for(let i=0;i<3;i++){
   if(path==='download'){const response=await GET(new NextRequest('https://marktmorgen.com/@'+handle+'/contact/vcard'),params());delivered=delivered||response.status===200;}
   if(path==='page'){try{const tree=await ContactPage(params());delivered=delivered||Boolean(tree);}catch{/* Refusal or redirect is allowed. */}}
   if(path==='metadata'){const metadata=await generateMetadata(params());delivered=delivered||String(metadata.title).includes('Synthetic public card');}
  }
  console.log('G2_CARD_ADMISSION',JSON.stringify({path,delivered,commands:commands.length,cardReads:commands.filter(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:vcard:')).length,counters:commands.filter(c=>c[0]==='INCRBY'||c[0]==='EVAL').length}));
  assert.equal(delivered,false,'card data was delivered repeatedly despite a refused billing-window admission');
 }finally{redis.pipeline=base;}
});
