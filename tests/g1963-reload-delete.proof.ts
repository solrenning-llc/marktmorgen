/** G review-only: actual authenticated page seeds after valid off/unnamed saves; no provider. */
import {writeFileSync} from 'node:fs';
import {NextRequest} from 'next/server';
import StudioCardPage from '@/app/studio/card/page';
import {CreatorCardEditor} from '@/components/creator-card-editor';
import {answering} from './security/next-headers';
import {GET,POST} from '@/app/api/store/creator-card/route';
import {openSession,SESSION_COOKIE} from '@/lib/auth';
import {NO_CARD,readCreatorCardForEditing} from '@/lib/creator-card';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {dataKey} from '@/lib/store-data';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
import {done,is} from './check';
const url='https://marktmorgen.com/api/store/creator-card';
function editor(node:unknown):{initial:unknown}|undefined{
 if(Array.isArray(node)){for(const c of node){const v=editor(c);if(v)return v;}return;}
 if(node&&typeof node==='object'){const n=node as {type?:unknown;props?:{initial:unknown;children?:unknown}};return n.type===CreatorCardEditor?n.props:editor(n.props?.children);}
}
async function main(){
 const cases=[
  {label:'off unnamed retained email and note',card:{...NO_CARD,email:'retained@example.test',note:'Retained private words'},held:true},
  {label:'off unnamed fully empty kept record',card:{...NO_CARD},held:true},
  {label:'off named control',card:{...NO_CARD,name:'Kept name',email:'retained@example.test'},held:true},
  {label:'confirmed absence control',card:{...NO_CARD},held:false},
 ];
 const fixtures=[];
 for(const c of cases){
  redis.clear();const email='g-reload-card@example.test';await claimHandle(email,'greloadcard','Synthetic shop','');await ensureStatsId(email);await ensureStoreId(email);
  await setSubscription(email,{customerId:'cus_GReload',subscriptionId:'sub_GReload',active:true,tier:'creator',period:paidPeriod()});
  const store=(await storeForEmail(email))!,cookie=`${SESSION_COOKIE}=${await openSession(email)}`;
  const post=(body:Record<string,unknown>)=>POST(new NextRequest(url,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)}));
  if(c.held)is(c.label+' actual save',(await post({action:'save',...c.card})).status,200);
  answering(new NextRequest(url,{headers:{cookie}}));
  const response=await GET(new NextRequest(url,{headers:{cookie}})),body=await response.json();
  const initial=editor(await StudioCardPage({searchParams:Promise.resolve({store:store.sid})}))?.initial;
  const raw=redis.run(['GET',`nl:vcard:${store.statsId}`]),slot=redis.run(['HGET',dataKey(store)!,'card']);
  is(c.label+' actual GET',response.status,200);is(c.label+' readable card',body.card,c.card);
  is(c.label+' actual page seed',initial,c.card);is(c.label+' kept record',typeof raw==='string',c.held);
  is(c.label+' counted room',typeof slot==='string'&&Number(slot)>0,c.held);
  is(c.label+' reader unchanged',await readCreatorCardForEditing(store.statsId),c.card);
  fixtures.push({label:c.label,initial,held:c.held,slot});
 }
 writeFileSync('/tmp/g1963-reload-delete-fixtures.json',JSON.stringify(fixtures,null,2));
 console.log('G_RELOAD_BACKEND_FIXTURES',JSON.stringify(fixtures));done();
}
void main();
