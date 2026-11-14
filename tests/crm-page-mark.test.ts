import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/crm/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {PIN_HEADER} from '@/lib/studio-route';
import {claimHandle,ensureStatsId,ensureListId,ensureStoreId,storeForEmail,setSubscription} from '@/lib/store';
import {forgetCrmPerson,pageMark,readGeneration,writeFields,ERASED_MARK_SECONDS} from '@/lib/crm';
import {listOrder} from '@/lib/buyer-list';
import {personKey} from '@/lib/person-key';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
/** Codex G2 on #2287: a page read before a deletion stays refused after the person's generation lapsed and the session was renewed, because the page's own signed mark (lib/crm.ts, pageMark) lapses first. Synthetic store and buyer only. */
test('a page from before a deletion stays refused after sign-in renewal and the generation lapsing (Codex G2)',async()=>{
 redis.clear();const realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{
  const owner='g2-crm-owner@example.test',buyer='g2-crm-buyer@example.test';
  assert.equal((await claimHandle(owner,'g2-crm-expiry','Synthetic CRM','')).ok,true);
  await ensureStatsId(owner);await ensureListId(owner);await ensureStoreId(owner);
  const subscription=()=>setSubscription(owner,{customerId:'cus_G2CrmExpiry',subscriptionId:'sub_G2CrmExpiry',active:true,tier:'pro',period:paidPeriod(now)});
  await subscription();let shop=(await storeForEmail(owner))!;const sid=shop.statsId!,person=personKey(sid,buyer);
  await writeFields(sid,[{id:'fielda',name:'Company',type:'text',options:[]}]);
  const generation=await readGeneration(sid,person);assert.equal(generation,0);
  const body={action:'value',field:'fielda',person,value:'Old tab content',mark:pageMark(sid,person,generation,now)};
  let session=await openSession(owner);
  const save=()=>POST(new NextRequest('https://marktmorgen.com/api/store/crm',{method:'POST',headers:{'content-type':'application/json',cookie:SESSION_COOKIE+'='+session,[PIN_HEADER]:shop.sid},body:JSON.stringify(body)}));
  assert.equal((await save()).status,200);
  await forgetCrmPerson(sid,person,buyer,shop);
  assert.equal((await save()).status,404,'control: old page is refused while mark exists');
  now+=2000;redis.advance(2000);
  assert.equal(await listOrder(shop,{sessionId:'cs_test_G2CrmReturn1',email:buyer,news:false,created:Math.floor(now/1000),products:[{id:'prod01',title:'Synthetic book'}]}),'done');
  assert.equal((await save()).status,404,'control: old page is refused after real return while generation exists');
  const delta=ERASED_MARK_SECONDS*1000+1000;now+=delta;redis.advance(delta);
  await subscription();shop=(await storeForEmail(owner))!;
  session=await openSession(owner); // A separate sign-in tab updates cookies; the old tab's body is unchanged.
  assert.equal(await readGeneration(sid,person),0,'the generation expired to its original default');
  const response=await save();const kept=(await redis.pipeline([['HGET','nl:crm:v:'+sid+':fielda',person]]))[0];
  assert.equal(response.status,409,'renewing authentication must not validate an old page snapshot: its mark has lapsed');
  assert.deepEqual(await response.json(),{ok:false,error:'stale'});
  assert.equal(kept,null,'and nothing is written');
 }finally{Date.now=realNow;}
});
