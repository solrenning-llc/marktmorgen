import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/crm/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {PIN_HEADER} from '@/lib/studio-route';
import {claimHandle,ensureStatsId,ensureListId,ensureStoreId,storeForEmail,setSubscription} from '@/lib/store';
import {forgetCrmPerson,pageMark,readGeneration,writeFields} from '@/lib/crm';
import {listOrder} from '@/lib/buyer-list';
import {personKey} from '@/lib/person-key';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';
/**
 * Claude 5's second review of #2287: a person's generation must never repeat. It lapsed with its 31-day expiry and the
 * next deletion counted it from 1 again, so a page read after the first deletion (generation 1, its mark good for 31
 * days less an hour) matched the generation of a second deletion 35 days later, and once the person came back the
 * old tab's body was written. Synthetic store and buyer only.
 */
test('a page read between two deletions stays refused after the second, even once the first generation lapsed',async()=>{
 redis.clear();const realNow=Date.now;let now=realNow();Date.now=()=>now;
 const day=86_400_000;const pass=(ms:number)=>{now+=ms;redis.advance(ms);};
 try{
  const owner='c5-gen-owner@example.test',buyer='c5-gen-buyer@example.test';
  assert.equal((await claimHandle(owner,'c5-gen-reuse','Synthetic CRM','')).ok,true);
  await ensureStatsId(owner);await ensureListId(owner);await ensureStoreId(owner);
  const subscription=()=>setSubscription(owner,{customerId:'cus_C5GenReuse',subscriptionId:'sub_C5GenReuse',active:true,tier:'pro',period:paidPeriod(now)});
  await subscription();let shop=(await storeForEmail(owner))!;const sid=shop.statsId!,person=personKey(sid,buyer);
  await writeFields(sid,[{id:'fielda',name:'Company',type:'text',options:[]}]);
  let orders=0;const comeBack=async()=>{pass(2000);assert.equal(await listOrder(shop,{sessionId:`cs_test_C5GenReuse${++orders}`,email:buyer,news:false,created:Math.floor(now/1000),products:[{id:'prod01',title:'Synthetic book'}]}),'done');};
  // Day 0: deleted, then back with a paid order.
  await forgetCrmPerson(sid,person,buyer,shop);await comeBack();
  // Day 20: a page is opened, and the tab stays open.
  pass(20*day);await subscription();shop=(await storeForEmail(owner))!;
  const read=await readGeneration(sid,person);
  const body={action:'value',field:'fielda',person,value:'Typed between the deletions',mark:pageMark(sid,person,read,now)};
  const session=await openSession(owner);
  const save=()=>POST(new NextRequest('https://marktmorgen.com/api/store/crm',{method:'POST',headers:{'content-type':'application/json',cookie:SESSION_COOKIE+'='+session,[PIN_HEADER]:shop.sid},body:JSON.stringify(body)}));
  // Day 35: the first generation lapsed; deleted again, then back again.
  pass(15*day);await subscription();shop=(await storeForEmail(owner))!;
  await forgetCrmPerson(sid,person,buyer,shop);
  assert.equal((await save()).status,404,'control: refused while the mark of the second deletion stands');
  await comeBack();
  const response=await save();const kept=(await redis.pipeline([['HGET','nl:crm:v:'+sid+':fielda',person]]))[0];
  assert.notEqual(response.status,200,'a page read before the second deletion never saves after it');
  assert.equal(kept,null,'and nothing typed before the second deletion is written');
 }finally{Date.now=realNow;}
});
