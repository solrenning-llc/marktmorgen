/**
 * Codex G2 on #1961: through the real route (app/api/store/creator-card), a
 * card save whose script answered something that only looks like a receipt
 * is never said saved: 503 "unconfirmed", whose words say to reload and look
 * (lib/creator-card.ts, CardSaveUnconfirmed; lib/store-data.ts,
 * dataTakenOf read exactly). Synthetic store and in-memory Redis only.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/creator-card/route';
import {openSession,SESSION_COOKIE} from '@/lib/auth';
import {readCreatorCard,NO_CARD} from '@/lib/creator-card';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';

globalThis.fetch=async()=>{throw Error('No external service in review');};

test('a real confirmed save is still accepted',async()=>{
 const {post,store}=await fixture();const response=await post();
 assert.equal(response.status,200);assert.equal((await readCreatorCard(store.statsId)).name,'Synthetic business');
});
for(const [label,reply] of [
 ['missing total',[[1]]],['null total',[[1,null]]],['text total',[[1,'unknown']]],
 ['negative total',[[1,-1]]],['extra command answer',[[1,320],null]],
] as const)test(`an unapplied card save with ${label} is never confirmed`,async()=>{
 const {post,store}=await fixture();const real=redis.pipeline.bind(redis);let reached=false;
 redis.pipeline=async batch=>{
  if(batch.some(c=>(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:card-save:'))||(c[0]==='SET'&&String(c[1]).startsWith('nl:vcard:')))){reached=true;return reply as never;}
  return real(batch);
 };
 try{
  const response=await post();const body=await response.json();
  assert.equal(reached,true);assert.deepEqual(await readCreatorCard(store.statsId),NO_CARD,'the intercepted write was never applied');
  assert.notEqual(body.ok,true,'an incomplete or invalid write receipt must not report a saved card');
  assert.deepEqual([response.status,body.error],[503,'unconfirmed'],'said as not confirmed, never as nothing changed');
 } finally {redis.pipeline=real;}
});

async function fixture(){
 redis.clear();const email='g2-card-ack@example.com';
 await claimHandle(email,'g2-card-ack','Synthetic business','');await ensureStatsId(email);await ensureStoreId(email);
 await setSubscription(email,{customerId:'cus_G2CardAck',subscriptionId:'sub_G2CardAck',active:true,tier:'creator',period:paidPeriod()});
 const store=(await storeForEmail(email))!;const cookie=`${SESSION_COOKIE}=${await openSession(email)}`;
 const post=()=>POST(new NextRequest('https://marktmorgen.com/api/store/creator-card',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({action:'save',on:true,name:'Synthetic business',note:'Typed intentionally for this card.'})}));
 return {store,post};
}
