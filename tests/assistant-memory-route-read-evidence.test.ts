/**
 * Codex G2 on #1951 (d1b8c38e), kept as permanent tests: the studio route never shows a shorter list of notes as the
 * whole list; a note the rules leave out makes the read unreadable, said so.
 */
/** G2 independent route review: a readable envelope with an unreadable note is not a complete empty/list result. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {NextRequest} from 'next/server';
import {GET} from '@/app/api/store/assistant-memory/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {keepNote} from '@/lib/assistant-memory-store';
import {needData} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
globalThis.fetch=async()=>{throw Error('External transport prohibited in independent review');};
async function seed(){
 redis.clear();const owner='g2-memory-route@example.test';assert.ok((await claimHandle(owner,'g2memoryroute','Synthetic shop','')).ok);await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_G2Memory',subscriptionId:'sub_G2Memory',active:true,tier:'creator',period:paidPeriod()});const store=await storeForEmail(owner);assert.ok(store?.statsId);
 const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`,key=`nl:amem:${store.statsId}`;
 const read=async()=>{const response=await GET(new NextRequest('https://marktmorgen.com/api/store/assistant-memory',{headers:{cookie}}));return{status:response.status,body:await response.json()};};
 return{store,key,read};
}
test('control: confirmed absent memory is an honest complete empty result',async()=>{const s=await seed(),r=await s.read();assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.deepEqual(r.body.notes,[]);});
test('control: a real valid note is present in the authenticated GET',async()=>{const s=await seed();assert.ok((await keepNote(s.store.statsId!,{kind:'preference',text:'Use a warm voice.'},s.store)).ok);const r=await s.read();assert.equal(r.status,200);assert.equal(r.body.notes.length,1);});
for(const mixed of [false,true])test(`GET cannot certify a complete ${mixed?'partial':'empty'} list when stored notes are unreadable`,async()=>{
 const s=await seed();assert.ok((await keepNote(s.store.statsId!,{kind:'preference',text:'Use a warm voice.'},s.store)).ok);const notes=JSON.parse(String(redis.run(['GET',s.key])));
 if(mixed){assert.ok((await keepNote(s.store.statsId!,{kind:'instruction',text:'Keep paragraphs short.'},s.store)).ok);notes.push(JSON.parse(String(redis.run(['GET',s.key])))[1]);}
 // Deliberately unknown stored kind, matching the parent's unreadable-row boundary; keep actual ids/text and fund the exact raw record.
 notes[0].kind='future_kind';const raw=JSON.stringify(notes);redis.run(['SET',s.key,raw]);await needData(s.store,[{slot:'amem',bytes:dataBytes([raw],1),set:true}]);
 const r=await s.read();assert.equal(redis.run(['GET',s.key]),raw);console.log('G2_MEMORY_ROUTE_PARTIAL',JSON.stringify({mixed,kept:notes.length,...r}));
 assert.ok(r.status>=400||r.body.partial===true||r.body.complete===false,'unknown stored notes must be unavailable or explicitly partial, never an ok complete list that silently omits them');
});
