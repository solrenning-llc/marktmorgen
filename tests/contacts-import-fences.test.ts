import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/mail/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {importContacts,importContactRows,leadsKey} from '@/lib/contacts';
import {claimHandle,ensureListId,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {erasePerson} from '@/lib/person-erasure';
import {suppressedCommand} from '@/lib/suppression';
import {healthId} from '@/lib/mail-health';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
globalThis.fetch=(async()=>{throw Error('No external requests in contact review');}) as typeof fetch;
async function setup(){
 redis.clear();const owner='contact-review@example.com';await claimHandle(owner,'contactreview','Contact review','');await ensureStatsId(owner);await ensureStoreId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:'cus_contacts',subscriptionId:'sub_contacts',active:true,tier:'pro',period:paidPeriod()});
 return {owner,shop:(await storeForEmail(owner))!};
}
test('a partial second paste batch cannot leave imported contacts outside the ramp',async()=>{
 const {owner,shop}=await setup();const list=shop.listId!;const emails=Array.from({length:501},(_,i)=>`contact${i}@example.com`);const original=redis.pipeline;let reads=0;let response!:Response;
 try{
  redis.pipeline=async commands=>{
   if(commands.some(c=>c[0]==='HMGET'&&c[1]===leadsKey(list))&&++reads===2)return [];
   return original.call(redis,commands);
  };
  const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
  response=await POST(new NextRequest('https://marktmorgen.com/api/store/mail',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'import',confirm:true,text:emails.join('\n')})}));
 }finally{redis.pipeline=original;}
 const count=Number(redis.run(['HLEN',leadsKey(list)]));const ramp=redis.run(['GET',`nl:mail:ramp:${healthId(shop)}`]);
 console.log('LATE_PASTE',reads,response.status,count,ramp);
 assert.equal(reads,2);assert.ok(count>=500,'the earlier confirmed batch must have really landed');
 assert.ok(ramp,'500 imported addresses still require the existing import ramp');
});
for(const mode of ['file','paste'] as const){
 test(`a completed real erasure between the ${mode} read and write cannot restore the contact`,async()=>{
  const {shop}=await setup();const email='erased-during-import@example.com',list=shop.listId!;const original=redis.pipeline;let erased=false;
  try{
   redis.pipeline=async commands=>{
    if(!erased&&commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:store-data'))){
     erased=true;const result=await erasePerson(shop,email,{kind:'person'});assert.equal(result.ok,true,'real erasure must complete before the old writer resumes');
    }
    return original.call(redis,commands);
   };
   const result=mode==='file'?await importContactRows(list,[{email,name:'Synthetic',tags:[]}],shop):await importContacts(list,[email],shop);
   console.log('ERASURE_IMPORT_RACE',mode,JSON.stringify(result));
  }finally{redis.pipeline=original;}
  assert.equal(erased,true);
  assert.equal(redis.run(suppressedCommand(list,email)),1);
  const held=redis.run(['HGET',leadsKey(list),email]);console.log('RESTORED_CONTACT',mode,typeof held==='string');
  assert.equal(held,null,'a completed erasure cannot be undone by the stale import');
 });
}

for (const reply of [[], [[]], [[1, 1]], [["1"]], [[null]], [[true]]]) {
 test(`unknown atomic import acknowledgement ${JSON.stringify(reply)} never falls back to HSET`, async()=>{
  const {shop}=await setup(); const original=redis.pipeline; let script=0, fallback=0;
  try{
   redis.pipeline=async commands=>{
    if(commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:contact-import:'))){script++;return reply;}
    if(script&&commands.some(c=>c[0]==='HSET'&&c[1]===leadsKey(shop.listId!)))fallback++;
    return original.call(redis,commands);
   };
   await assert.rejects(importContactRows(shop.listId!,[{email:'unconfirmed@example.com',name:'Synthetic',tags:[]}],shop),/not imported.*try again/i);
  }finally{redis.pipeline=original;}
  assert.equal(script,1);assert.equal(fallback,0);assert.equal(redis.run(['HLEN',leadsKey(shop.listId!)]),0);
 });
}
