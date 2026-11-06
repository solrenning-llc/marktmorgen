import { NextRequest } from 'next/server';
import { GET } from '@/app/[handle]/contact/vcard/route';
import ContactPage, { generateMetadata } from '@/app/[handle]/contact/page';
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from '@/lib/store';
import { saveCreatorCard, dropCreatorCard } from '@/lib/creator-card';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';
globalThis.fetch=async()=>{throw Error('No external provider');};
const owner='g-card-off@example.test',handle='gcardoff';
const value={on:true,name:'Synthetic race card',email:'public@example.test'};
const props=()=>({params:Promise.resolve({handle:'@'+handle}),searchParams:Promise.resolve({})});
async function call(path:string):Promise<boolean>{
 if(path==='download')return (await GET(new NextRequest('https://marktmorgen.com/@'+handle+'/contact/vcard'),props())).status===200;
 if(path==='metadata')return String((await generateMetadata(props())).title).includes(value.name);
 try{return Boolean(await ContactPage(props()));}catch{return false;}
}
async function main(){
 for(const path of ['download','page','metadata'])for(const action of ['off','delete']){
  redis.clear();await claimHandle(owner,handle,'Synthetic shop','');await ensureStatsId(owner);await ensureStoreId(owner);
  await setSubscription(owner,{customerId:'cus_GOff',subscriptionId:'sub_GOff',active:true,tier:'creator',period:paidPeriod()});
  const shop=(await storeForEmail(owner))!;if(!(await saveCreatorCard(shop.statsId!,value,shop)).ok)throw Error('Real writer fixture failed');
  const base=redis.pipeline.bind(redis);let reached!:()=>void,release!:()=>void,paused=0,reads=0;
  const atAdmission=new Promise<void>(resolve=>{reached=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  redis.pipeline=async batch=>{
   if(!paused&&batch.length===1&&batch[0][0]==='INCRBY'&&String(batch[0][1]).startsWith('nl:traffic:r:')){
    paused++;const receipt=await base(batch);reached();await resume;return receipt;
   }
   reads+=batch.filter(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:vcard:')).length;return base(batch);
  };
  const pending=call(path);let delivered:boolean;
  try{
   await atAdmission;
   is(`${path}/${action}: no card was read before the actual admission`,reads,0);
   if(action==='off'){const changed=await saveCreatorCard(shop.statsId!,{...value,on:false},shop);is(`${path}/${action}: the real writer confirmed off`,changed.ok,true);}
   else await dropCreatorCard(shop.statsId!,shop);
  }finally{release();delivered=await pending;redis.pipeline=base;}
  is(`${path}/${action}: admission pause was observed exactly once`,paused,1);
  is(`${path}/${action}: a card disabled or deleted before its read is not delivered`,delivered!,false);
 }
 done();
}
void main();
