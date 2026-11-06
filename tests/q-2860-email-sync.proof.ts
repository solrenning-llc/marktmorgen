/** Q #2860: valid queued jobs beyond the studio log must survive neither copy discovery nor erasure. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { queuePerson, syncJobsOf, syncDue, QUEUE_KEY, LOG_SIZE } from '@/lib/email-sync';
import { setPlatformHooksForTests } from '@/lib/email-platforms';
import { seal } from '@/lib/secret-box';
import { claimHandle,ensureStoreId,ensureStatsId,ensureListId,setSubscription,addProduct,storeForEmail } from '@/lib/store';
import { copyPerson } from '@/lib/person-copy';
import { erasePerson,erasureScope } from '@/lib/person-erasure';
import { upsertContact,tokensFor } from '@/lib/contacts';
import { isSuppressed } from '@/lib/suppression';
import { paidPeriod } from './billing-period-fixture';
import { ROOM } from './data-room';
import { store as redis } from './redis-stub';
process.env.NIMBUS_DATA_KEY='synthetic-q2860-data-key-32-characters';
process.env.STRIPE_SECRET_KEY='sk_test_q2860_only';
globalThis.fetch=(async(input:string|URL|Request)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.hostname==='api.stripe.com')return new Response(JSON.stringify({data:[],has_more:false}),{status:200});
 throw Error('No external fetch allowed in Q proof: '+url.hostname);
}) as typeof fetch;
const real=redis.pipeline.bind(redis);
let budget=0,holdLease=true,lookups=0;
const count=(n=1)=>{budget+=n;if(budget>5000)throw Error('Q proof command ceiling exceeded');};
const run=(command:(string|number)[])=>{count();return redis.run(command);};
redis.pipeline=(async(commands:(string|number)[][])=>{
 count(commands.length);
 const c=commands[0];
 // Same lease seam as the author test: MemoryRedis does not implement this Lua.
 if(commands.length===1&&c[0]==='EVAL'&&String(c[1]).includes('local due = redis.call("ZSCORE"')){
  if(holdLease)return [0];
  const due=run(['ZSCORE',String(c[3]),String(c[4])]);
  if(due===null||Number(due)>Number(c[5]))return [0];
  run(['ZADD',String(c[3]),Number(c[6]),String(c[4])]);return [1];
 }
 return real(commands);
}) as typeof redis.pipeline;
async function scenario(total:number){
 redis.clear();budget=0;holdLease=true;lookups=0;
 setPlatformHooksForTests({resolve:async()=>{lookups++;throw Error('Synthetic resolver blocks every external connection');}});
 const owner=`q2860-owner-${total}@example.test`,person=`q2860-person-${total}@example.test`,handle=`q2860-${total}`;
 await claimHandle(owner,handle,'Q privacy','');await ensureStoreId(owner);await ensureStatsId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:'cus_Q2860Privacy',subscriptionId:'sub_Q2860Privacy',active:true,tier:'pro',period:paidPeriod()});
 const made=await addProduct(owner,'Synthetic guide','','9',null);if(!made.ok)throw Error('Synthetic product unavailable');
 const store=(await storeForEmail(owner))!;const statsId=store.statsId!;
 await upsertContact(store.listId!,person,{agreed:true,explicit:true,source:'free'},ROOM);
 const now=Date.now();
 await redis.pipeline([['SET',`nl:esync:cfg:${statsId}`,JSON.stringify({handle,provider:'mailerlite',key:seal('synthetic-key',`email-sync|${statsId}|mailerlite`),last4:'fake',target:{id:'123',name:'Synthetic group'},free:true,buyers:'all',products:[],tags:{},since:now-60000,connectedAt:now-60000})]]);
 const add=async(email:string,seed:string)=>queuePerson(store,{source:'free',email,name:'Synthetic Person',products:[{id:made.product.id,title:'Guide'}],consent:true,seed,at:now},now);
 assert.equal(await add(person,'target'),'queued');
 const id=String((run(['LRANGE',`nl:esync:log:${statsId}`,0,0]) as string[])[0]);
 const written=JSON.parse(String(run(['GET',`nl:esync:j:${id}`])));
 assert.equal(written.email,person,'real writer stores the agreed address in plaintext');
 assert.equal((await syncJobsOf(statsId,person)).length,1,'writer initially discovers target');
 for(let i=1;i<total;i++)assert.equal(await add(`other${i}@example.test`,`other-${i}`),'queued');
 assert.equal(run(['LLEN',`nl:esync:log:${statsId}`]),LOG_SIZE,'real writer holds exactly its documented log size');
 const direct=await syncJobsOf(statsId,person);
 const scope=await erasureScope(store,person);if(!scope)throw Error('Synthetic erasure scope unavailable');
 const copied=await copyPerson(scope);
 const syncCopy=copied.sections.find(s=>s.module==='lib/email-sync.ts');
 const erased=await erasePerson(store,person,{kind:'person'});
 const key=`nl:esync:j:${id}`,member=`${statsId}|${id}`;
 const erasedRaw=run(['GET',key]);
 const held=erasedRaw!==null,queued=run(['ZSCORE',QUEUE_KEY,member])!==null;
 const plaintextAddressAfterErasure=typeof erasedRaw==='string'&&JSON.parse(erasedRaw).email===person;
 const suppressed=await isSuppressed(store.listId,person);
 const mailToken=(await tokensFor(store.listId!,[person],store.handle)).has(person);
 // Keep only the target due; unrelated synthetic people are not exercised by this retry.
 const members=run(['ZRANGEBYSCORE',QUEUE_KEY,'-inf','+inf']) as string[];
 const others=members.filter(m=>m!==member);
 if(others.length)await redis.pipeline([['ZADD',QUEUE_KEY,...others.flatMap(m=>[now+86400000,m])]]);
 holdLease=false;
 const retry=await syncDue(Date.now()+2000,now);
 const after=run(['GET',key]);
 const result={total,logSize:LOG_SIZE,directCopy:direct.length,fullCopy:syncCopy?.records.length??0,erasureOk:erased.ok,jobHeld:held,plaintextAddressAfterErasure,queued,suppressed,mailToken,retry,providerLookups:lookups,stateAfter:typeof after==='string'?JSON.parse(after).state:null,commands:budget};
 console.log('Q2860_OBSERVATION '+JSON.stringify(result));
 setPlatformHooksForTests(undefined);
 return result;
}
test('control: the fiftieth logged job is copied and erased by real consumers',async()=>{
 const r=await scenario(LOG_SIZE);
 assert.equal(r.directCopy,1);assert.equal(r.fullCopy,1);assert.equal(r.erasureOk,true);
 assert.equal(r.jobHeld,false);assert.equal(r.plaintextAddressAfterErasure,false);assert.equal(r.queued,false);assert.equal(r.providerLookups,0);
 assert.equal(r.suppressed,true);assert.equal(r.mailToken,false);
});
test('after 51 real queued jobs, the oldest person still needs a complete copy and erasure',async()=>{
 const r=await scenario(LOG_SIZE+1);
 assert.equal(r.directCopy,1,'a valid queued job must not disappear from its data copy');
 assert.equal(r.fullCopy,1,'the full person copy must include the queued job');
 assert.equal(r.erasureOk,true);assert.equal(r.jobHeld,false,'a completed erasure must remove the address-bearing job');
 assert.equal(r.queued,false);assert.equal(r.providerLookups,0,'an erased person must not be retried to the provider');
});
