import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/mail/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {leadsKey} from '@/lib/contacts';
import {claimHandle,ensureListId,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {healthId} from '@/lib/mail-health';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
globalThis.fetch=(async()=>{throw Error('No external requests in contact review');}) as typeof fetch;
async function setup(){
 redis.clear();const owner='contact-review@example.com';await claimHandle(owner,'contactreview','Contact review','');await ensureStatsId(owner);await ensureStoreId(owner);await ensureListId(owner);
 await setSubscription(owner,{customerId:'cus_contacts',subscriptionId:'sub_contacts',active:true,tier:'pro',period:paidPeriod()});
 return {owner,shop:(await storeForEmail(owner))!};
}
for (const landed of [false, true]) {
 test(`unknown middle write (applied=${landed}) separates its outcome from the unattempted tail`,async()=>{
  const {owner,shop}=await setup();const list=shop.listId!;
  const emails=Array.from({length:1201},(_,i)=>`write${i}@example.com`);
  const original=redis.pipeline;let scripts=0, recovering=false;let response!:Response;
  try {
   redis.pipeline=async commands=>{
    if(commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:contact-import:'))){
     scripts++;
     if(scripts===2){
      if(landed)await original.call(redis,commands);
      recovering=true;return [];
     }
    }
    if(recovering&&commands.some(c=>c[0]==='HMGET'&&c[1]===leadsKey(list)))return [];
    return original.call(redis,commands);
   };
   const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
   response=await POST(new NextRequest('https://marktmorgen.com/api/store/mail',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'import',confirm:true,text:emails.join('\n')})}));
  } finally {redis.pipeline=original;}
  const count=Number(redis.run(['HLEN',leadsKey(list)]));
  const ramp=redis.run(['GET',`nl:mail:ramp:${healthId(shop)}`]);
  console.log('UNKNOWN_LATER_WRITE',{landed,scripts,status:response.status,count,ramp});
  assert.equal(scripts,2);assert.equal(count,landed?1000:500);
  const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.added,500);assert.equal(body.already,0);
  assert.equal(body.notConfirmed.left,500);assert.equal(body.notImported.left,201);
  assert.match(body.notConfirmed.message,/could not be confirmed/i);
  assert.match(body.notImported.message,/not imported/i);
  assert.ok(ramp,'the 500 confirmed earlier contacts must retain the import ramp even when a later write cannot be reconciled');
 });
}
