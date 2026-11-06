import { NextRequest } from 'next/server';
import { GET } from '@/app/[handle]/contact/vcard/route';
import ContactPage, { generateMetadata } from '@/app/[handle]/contact/page';
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from '@/lib/store';
import { saveCreatorCard } from '@/lib/creator-card';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { done, is } from './check';
globalThis.fetch = async () => { throw Error('No external provider in G review'); };
const owner='g-card-matrix@example.test',handle='gcardmatrix';
const props=()=>({params:Promise.resolve({handle:'@'+handle}),searchParams:Promise.resolve({})});
const cases:[string,unknown][]=[['empty',[]],['null',[null]],['string',['1']],['boolean',[true]],['zero',[0]],['negative',[-1]],['fraction',[0.5]],['unsafe',[Number.MAX_SAFE_INTEGER+1]],['extra',[1,0]],['throw',null]];
async function fixture() {
 redis.clear(); await claimHandle(owner,handle,'Synthetic shop',''); await ensureStatsId(owner); await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_GMatrix',subscriptionId:'sub_GMatrix',active:true,tier:'creator',period:paidPeriod()});
 const shop=(await storeForEmail(owner))!;
 if(!(await saveCreatorCard(shop.statsId!,{on:true,name:'Synthetic matrix card',email:'public@example.test'},shop)).ok)throw Error('Real writer fixture rejected');
}
type Outcome={delivered:boolean;status?:number;cache?:string|null;error?:string};
async function call(path:string):Promise<Outcome> {
 if(path==='download'){const response=await GET(new NextRequest('https://marktmorgen.com/@'+handle+'/contact/vcard'),props());return {delivered:response.status===200,status:response.status,cache:response.headers.get('cache-control')};}
 if(path==='metadata')return {delivered:String((await generateMetadata(props())).title).includes('Synthetic matrix card')};
 try{return {delivered:Boolean(await ContactPage(props()))};}catch(error){return {delivered:false,error:String(error)};}
}
async function main(){
 for(const path of ['download','page','metadata'])for(const applied of [false,true])for(const [name,receipt] of cases){
  await fixture(); const base=redis.pipeline.bind(redis);let intercepted=0,reads=0,key='';
  redis.pipeline=async batch=>{
   if(batch.length===1&&batch[0][0]==='INCRBY'&&String(batch[0][1]).startsWith('nl:traffic:r:')){
    intercepted++;key=String(batch[0][1]);if(applied)await base(batch);if(name==='throw')throw Error('Receipt lost');return receipt as never;
   }
   reads+=batch.filter(c=>c[0]==='GET'&&String(c[1]).startsWith('nl:vcard:')).length;return base(batch);
  };
  let result:Awaited<ReturnType<typeof call>>;
  try{result=await call(path);}finally{redis.pipeline=base;}
  const count=(await base([['GET',key]]))[0];
  is(`${path}/${applied}/${name}: the real admission was intercepted once`,intercepted,1);
  is(`${path}/${applied}/${name}: card is unread and not delivered after an unknown count`,[reads,result!.delivered],[0,false]);
  is(`${path}/${applied}/${name}: an applied count is retained, an unapplied count is absent`,count,applied?'1':null);
  if(path==='download')is(`${applied}/${name}: refusal is uncacheable`,[result!.status,result!.cache],[503,'no-store']);
 }
 for(const path of ['download','page','metadata']){
  await fixture();const result=await call(path);is(`${path}: a real known paid admission still serves the published card`,result.delivered,true);
 }
 done();
}
void main();
