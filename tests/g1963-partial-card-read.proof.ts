/** G independent variant: exact private envelopes still need a complete stored-card schema. Derived from G2 fb55ead1; original proof preserved unchanged. */
import test from 'node:test';import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import StudioCardPage from '@/app/studio/card/page';
import {CreatorCardEditor} from '@/components/creator-card-editor';
import {answering} from './security/next-headers';
import {GET,POST} from '@/app/api/store/creator-card/route';
import {openSession,SESSION_COOKIE} from '@/lib/auth';
import {readCreatorCard,NO_CARD} from '@/lib/creator-card';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';import {store as redis} from './redis-stub';
const url='https://marktmorgen.com/api/store/creator-card';
async function fixture(){
 redis.clear();const email='g2-card-read@example.test';await claimHandle(email,'g2cardread','Synthetic shop','');await ensureStatsId(email);await ensureStoreId(email);
 await setSubscription(email,{customerId:'cus_G2CardRead',subscriptionId:'sub_G2CardRead',active:true,tier:'creator',period:paidPeriod()});
 const store=(await storeForEmail(email))!,cookie=`${SESSION_COOKIE}=${await openSession(email)}`;
 const post=(body:Record<string,unknown>)=>POST(new NextRequest(url,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)}));
 const get=()=>GET(new NextRequest(url,{headers:{cookie}}));
 answering(new NextRequest(url,{headers:{cookie}}));
 return{store,post,get,key:`nl:vcard:${store.statsId}`};
}
const card={on:true,name:'Synthetic kept card',title:'Teacher',email:'public@example.test',phone:'',website:'https://example.test/',note:'Intentionally retained words'};
function initialOf(node:unknown):unknown {
 if(Array.isArray(node)){for(const child of node){const found=initialOf(child);if(found!==undefined)return found;}return undefined;}
 if(node&&typeof node==='object'){const n=node as {type?:unknown;props?:{initial?:unknown;children?:unknown}};return n.type===CreatorCardEditor?n.props?.initial:initialOf(n.props?.children);}
 return undefined;
}
test('control: confirmed absence is empty, and a real saved card is read whole',async()=>{
 const s=await fixture();assert.deepEqual((await(await s.get()).json()).card,NO_CARD);
 assert.equal((await s.post({action:'save',...card})).status,200);assert.deepEqual((await(await s.get()).json()).card,card);
 assert.deepEqual(initialOf(await StudioCardPage({searchParams:Promise.resolve({store:s.store.sid})})),card,'the actual authenticated page seeds the valid card');
});
for(const reply of [[JSON.stringify({})],[JSON.stringify({on:true,name:card.name})],[JSON.stringify({...card,on:'true'})],[JSON.stringify({...card,email:null})],[JSON.stringify({...card,note:null})]])test(`unknown private read cannot certify empty ${JSON.stringify(reply)}`,async()=>{
 const s=await fixture();assert.equal((await s.post({action:'save',...card})).status,200);const before=redis.run(['GET',s.key]),original=redis.pipeline.bind(redis);let reached=0;
 redis.pipeline=async batch=>{if(batch.length===1&&batch[0][0]==='GET'&&batch[0][1]===s.key){reached++;return reply as never;}return original(batch);};
 let response;try{response=await s.get();}finally{redis.pipeline=original;}
 const body=await response.json();assert.equal(reached,1);assert.equal(redis.run(['GET',s.key]),before);
 console.log('G2_CARD_UNKNOWN_READ',JSON.stringify({reply,status:response.status,ok:body.ok,card:body.card}));
 assert.notEqual(body.ok,true,'an unreadable kept card must not be a completed empty snapshot');
});
test('a draft seeded by unknown-as-empty can erase unrelated retained fields on the next real save',async()=>{
 const s=await fixture();assert.equal((await s.post({action:'save',...card})).status,200);const original=redis.pipeline.bind(redis);
 redis.pipeline=async batch=>batch.length===1&&batch[0][0]==='GET'&&batch[0][1]===s.key?[JSON.stringify({})] as never:original(batch);
 let response;try{response=await s.get();}finally{redis.pipeline=original;}
 const body=await response.json();if(body.ok===true){const edited={...body.card,name:'Only the new name',action:'save'};assert.equal((await s.post(edited)).status,200);}
 const kept=await readCreatorCard(s.store.statsId);
 console.log('G2_CARD_UNKNOWN_THEN_EDIT',JSON.stringify({readOK:body.ok,kept}));
 assert.equal(kept.email,card.email,'a single-name edit after an unknown read must not erase the unseen email');assert.equal(kept.note,card.note);
});

for(const reply of [[JSON.stringify({})],[JSON.stringify({on:true,name:card.name})],[JSON.stringify({...card,on:'true'})],[JSON.stringify({...card,email:null})],[JSON.stringify({...card,note:null})]])test(`actual studio page must not seed an empty editor from unknown ${JSON.stringify(reply)}`,async()=>{
 const s=await fixture();assert.equal((await s.post({action:'save',...card})).status,200);const before=redis.run(['GET',s.key]),original=redis.pipeline.bind(redis);let reached=0;
 redis.pipeline=async batch=>{if(batch.length===1&&batch[0][0]==='GET'&&batch[0][1]===s.key){reached++;return reply as never;}return original(batch);};
 let tree;try{tree=await StudioCardPage({searchParams:Promise.resolve({store:s.store.sid})});}finally{redis.pipeline=original;}
 assert.equal(reached,1);assert.equal(redis.run(['GET',s.key]),before);const initial=initialOf(tree);
 console.log('G2_ACTUAL_CARD_STUDIO_UNKNOWN',JSON.stringify({reply,initial}));
 assert.equal(initial,undefined,'the actual studio page must show unavailable, never an empty editable card');
});
