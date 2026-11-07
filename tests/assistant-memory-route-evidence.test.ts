/**
 * Codex J on #1951, kept as permanent tests: through the real studio route,
 * an unread record or an unconfirmed write is never a saved note, and the
 * notes' room is never below what is kept, whether a longer save lands late
 * or an older forgetting finishes after a later note. The interceptions read
 * the fenced write and forgetting (MEMORY_WRITE, MEMORY_FORGET) as the
 * record's SET and DEL; a second change waits on the store's lock and may be
 * refused as busy, with the same room checks.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {GET,POST} from '@/app/api/store/assistant-memory/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {keepNote,readMemory,forgetMemory} from '@/lib/assistant-memory-store';
import {dataKey} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
import {ROOM} from './data-room';
globalThis.fetch=(async()=>{throw Error('No external calls in this review');}) as typeof fetch;
async function setup(){
 redis.clear();const owner='memory@example.com';
 await claimHandle(owner,'memoryshop','Memory Shop','');await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_memory',subscriptionId:'sub_memory',active:true,tier:'creator',period:paidPeriod()});
 const shop=(await storeForEmail(owner))!;const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
 const post=(body:Record<string,unknown>)=>POST(new NextRequest('https://marktmorgen.com/api/store/assistant-memory',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)}));
 return {shop,cookie,post};
}
// The record's write and delete as they are sent now: a SET or DEL, or the scripts that hold them (MEMORY_WRITE, MEMORY_FORGET).
const sets=(c:(string|number)[],key:string)=>(c[0]==='SET'&&c[1]===key)||(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-write:v1')&&c[4]===key&&c[6]!=='');
const dels=(c:(string|number)[],key:string)=>(c[0]==='DEL'&&c[1]===key)||(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:amem-forget:v3')&&c[4]===key);
const latch=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};};
test('a missing Redis read envelope cannot erase an existing note through POST',async()=>{
 const {shop,post}=await setup();await post({action:'add',kind:'preference',text:'Keep the existing note.'});
 const key=`nl:amem:${shop.statsId}`;const original=redis.pipeline;let injected=false;
 let response!:Response;
 try{redis.pipeline=async commands=>{if(!injected&&commands.some(c=>c[0]==='GET'&&c[1]===key)){injected=true;return [];}return original.call(redis,commands);};response=await post({action:'add',kind:'preference',text:'A second independent note.'});}finally{redis.pipeline=original;}
 const notes=await readMemory(shop.statsId);console.log('PARTIAL_READ',response.status,notes.map(x=>x.text));
 assert.equal(injected,true);assert.ok(response.status>=400,'unconfirmed old notes must prevent success/replacement');
});
test('a write with no Redis acknowledgement cannot report that a note was saved',async()=>{
 const {shop,post}=await setup();const key=`nl:amem:${shop.statsId}`;const original=redis.pipeline;let injected=false;let response!:Response;
 try{redis.pipeline=async commands=>{if(commands.some(c=>sets(c,key))){injected=true;return [];}return original.call(redis,commands);};response=await post({action:'add',kind:'preference',text:'This note was not persisted.'});}finally{redis.pipeline=original;}
 assert.equal(injected,true);const notes=await readMemory(shop.statsId);console.log('UNACKNOWLEDGED_WRITE',response.status,notes.length);
 assert.ok(response.status>=400,'success requires a confirmed write');
});
test('a late longer save cannot use the shorter concurrent save data slot',async()=>{
 redis.clear();const stats='m'.repeat(16),key=`nl:amem:${stats}`,arrived=latch(),resume=latch();const original=redis.pipeline;let held=false;
 const long='Use a calm voice. '+'x'.repeat(240);
 try{
  redis.pipeline=async commands=>{if(!held&&commands.some(c=>sets(c,key)&&String(c[0]==='SET'?c[2]:c[6]).includes(long))){held=true;arrived.release();await resume.promise;}return original.call(redis,commands);};
  const a=keepNote(stats,{kind:'preference',text:long},ROOM);await arrived.promise;
  const b=await keepNote(stats,{kind:'preference',text:'Be brief.'},ROOM);resume.release();const one=await a;assert.ok(one.ok&&(b.ok||b.error==='busy'),'the first save is kept; the second is kept or waits on the lock and is refused as busy');
 }finally{resume.release();redis.pipeline=original;}
 const [raw,slot]=await redis.pipeline([['GET',key],['HGET',dataKey(ROOM)!,'amem']]);
 const required=dataBytes([String(raw)],1);console.log('LATE_SAVE',required,Number(slot));assert.ok(Number(slot)>=required,'the stored notes require their own full data slot');
});
test('forgetting old notes cannot release a later note data slot',async()=>{
 redis.clear();const stats='m'.repeat(16),key=`nl:amem:${stats}`,arrived=latch(),resume=latch();const original=redis.pipeline;
 await keepNote(stats,{kind:'preference',text:'Old note.'},ROOM);let held=false;
 try{
  redis.pipeline=async commands=>{const result=await original.call(redis,commands);if(!held&&commands.some(c=>dels(c,key))){held=true;arrived.release();await resume.promise;}return result;};
  const forget=forgetMemory(stats,ROOM);await arrived.promise;
  const waiting=await keepNote(stats,{kind:'preference',text:'New note after deletion.'},ROOM);assert.ok(waiting.ok||waiting.error==='busy','a save while the forgetting holds the lock is kept or refused as busy');resume.release();await forget;
  if(!waiting.ok)assert.ok((await keepNote(stats,{kind:'preference',text:'New note after deletion.'},ROOM)).ok,'once the forgetting is done, the later note is kept');
 }finally{resume.release();redis.pipeline=original;}
 const [raw,slot]=await redis.pipeline([['GET',key],['HGET',dataKey(ROOM)!,'amem']]);
 assert.ok(raw,'the later note survives');const required=dataBytes([String(raw)],1);console.log('LATE_FORGET',required,Number(slot));assert.ok(Number(slot)>=required,'the old forget cannot release capacity for the later write');
});
