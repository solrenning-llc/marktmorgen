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
 test(`later unknown write (applied=${landed}) cannot remove protection from 500 confirmed earlier imports`,async()=>{
  const {owner,shop}=await setup();const list=shop.listId!;
  const emails=Array.from({length:501},(_,i)=>`write${i}@example.com`);
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
  assert.equal(scripts,2);assert.equal(count,landed?501:500);
  assert.ok(ramp,'the 500 confirmed earlier contacts must retain the import ramp even when a later write cannot be reconciled');
 });
}

// Claude 1's review 6800603295 on 6da1a247 (MEDIUM, lib/contacts.ts:475): a later batch's data-room count that cannot be
// read is not a full room, but the 500 contacts confirmed before it still need their ramp, never a 500 answer.
test('a later unreadable data-room count keeps the ramp for the 500 confirmed earlier imports',async()=>{
 const {owner,shop}=await setup();const list=shop.listId!;
 const emails=Array.from({length:501},(_,i)=>`room${i}@example.com`);
 const original=redis.pipeline;let rooms=0;let response!:Response;
 try {
  redis.pipeline=async commands=>{
   if(commands.some(c=>c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:store-data:'))){
    rooms++;
    if(rooms===2)return [];
   }
   return original.call(redis,commands);
  };
  const cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
  response=await POST(new NextRequest('https://marktmorgen.com/api/store/mail',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'import',confirm:true,text:emails.join('\n')})}));
 } finally {redis.pipeline=original;}
 const count=Number(redis.run(['HLEN',leadsKey(list)]));
 const ramp=redis.run(['GET',`nl:mail:ramp:${healthId(shop)}`]);
 assert.ok(rooms>=2,'the second batch asked for room');
 assert.equal(count,500);
 assert.notEqual(response.status,500,'confirmed progress is answered, never a server error');
 assert.ok(ramp,'the 500 confirmed contacts keep the import ramp');
});
