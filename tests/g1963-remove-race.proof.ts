import { NextRequest } from 'next/server';
import { POST } from '@/app/api/store/creator-card/route';
import { openSession, SESSION_COOKIE } from '@/lib/auth';
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from '@/lib/store';
import { DROP_CARD, readCreatorCard } from '@/lib/creator-card';
import { dataKey } from '@/lib/store-data';
import { paidPeriod } from './billing-period-fixture';
import { store as redis } from './redis-stub';
import { done, is } from './check';
const url='https://marktmorgen.com/api/store/creator-card';
async function main(){
 for(const name of ['Concurrent named card','']){
  redis.clear();const owner='g-card-remove-race@example.test';await claimHandle(owner,'gremoverace','Synthetic shop','');await ensureStatsId(owner);await ensureStoreId(owner);
  await setSubscription(owner,{customerId:'cus_GRemove',subscriptionId:'sub_GRemove',active:true,tier:'creator',period:paidPeriod()});
  const shop=(await storeForEmail(owner))!,cookie=`${SESSION_COOKIE}=${await openSession(owner)}`;
  const post=(body:Record<string,unknown>)=>POST(new NextRequest(url,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)}));
  const card={on:true,name:'Original card',title:'',email:'original@example.test',phone:'',website:'',note:'Original words'};
  is('real initial save confirmed',(await post({action:'save',...card})).status,200);
  const base=redis.pipeline.bind(redis);let reached!:()=>void,release!:()=>void,paused=0;
  const atDrop=new Promise<void>(resolve=>{reached=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  redis.pipeline=async batch=>{if(!paused&&batch.length===1&&batch[0][0]==='EVAL'&&batch[0][1]===DROP_CARD){paused++;reached();await resume;}return base(batch);};
  const pending=post({action:'remove'});const next={...card,on:false,name,email:'retained@example.test',note:'Retained private words'};
  let response:Response;
  try{await atDrop;is('real concurrent save confirmed',(await post({action:'save',...next})).status,200);}finally{release();response=await pending;redis.pipeline=base;}
  const body=await response!.json(),stored=await readCreatorCard(shop.statsId),slot=(await base([['HGET',dataKey(shop)!,'card']]))[0];
  is('the real drop paused after its read exactly once',paused,1);
  is('CAS preserves the concurrently saved record',stored,next);
  is('the actual deletion response carries that still-retained record',body.card,next);
  is('the retained record stays counted',typeof slot==='string'&&Number(slot)>0,true);
  console.log('G_CARD_REMOVE_REAL_RACE',JSON.stringify({name,status:response!.status,body,stored,slot}));
 }
 done();
}
void main();
