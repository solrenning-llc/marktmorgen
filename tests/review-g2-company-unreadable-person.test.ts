/** Independent G2 boundary review: unreadable store-owned fields must not hide retained personal links. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {addCompany,changeCompanies,linkPerson} from '@/lib/crm-companies';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {ERASERS,erasePerson} from '@/lib/person-erasure';
import {COPIERS} from '@/lib/person-copy';
import {personKey} from '@/lib/person-key';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
const id='abcdef0123';
async function seed(){
 redis.clear();const owner='g2companyrow@example.test';assert.equal((await claimHandle(owner,'g2companyrow','Synthetic shop','')).ok,true);await ensureStatsId(owner);await ensureStoreId(owner);
 await setSubscription(owner,{customerId:'cus_G2Row',subscriptionId:'sub_G2Row',active:true,tier:'creator',period:paidPeriod()});
 const store=await storeForEmail(owner);assert.ok(store?.statsId);const person=personKey(store.statsId,'buyer-g2@example.test'),hash=`nl:crm:co:${store.statsId}`;
 assert.ok((await changeCompanies(store.statsId,store,c=>addCompany(c,{name:'Synthetic company',website:'',note:''},id,100))).ok);
 assert.ok((await changeCompanies(store.statsId,store,c=>linkPerson(c,id,person))).ok);
 const scope={store,statsId:store.statsId,person};return{scope,hash,person};
}
test('control: a valid real company link is copied, then removed while the company stays',async()=>{
 const s=await seed();assert.equal((await COPIERS['lib/crm-companies.ts'](s.scope as never)).length,1);
 await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set());
 const row=JSON.parse(String(redis.run(['HGET',s.hash,id])));assert.equal(row.name,'Synthetic company');assert.deepEqual(row.people,[]);
});
for(const action of ['erase','copy'] as const)test(`an unreadable company name cannot certify an empty personal ${action}`,async()=>{
 const s=await seed(),row=JSON.parse(String(redis.run(['HGET',s.hash,id])));assert.deepEqual(row.people,[s.person]);
 // Deliberately malformed stored evidence: only the company name changes. The genuine personal link remains exact.
 row.name={unknown:true};redis.run(['HSET',s.hash,id,JSON.stringify(row)]);let unknown=false,result:unknown;
 try{result=action==='erase'?await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set()):await COPIERS['lib/crm-companies.ts'](s.scope as never);}catch{unknown=true;}
 assert.deepEqual(JSON.parse(String(redis.run(['HGET',s.hash,id]))).people,[s.person]);
 console.log('G2_UNREADABLE_COMPANY_PERSON',JSON.stringify({action,unknown,result,retainedPersonalLink:true}));
 assert.equal(unknown,true,'unreadable evidence with retained personal links must not certify a completed empty row');
});

test('full real person erasure cannot complete while an unreadable company retains the personal link',async()=>{
 const s=await seed(),row=JSON.parse(String(redis.run(['HGET',s.hash,id])));row.name={unknown:true};redis.run(['HSET',s.hash,id,JSON.stringify(row)]);
 const fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited in independent review');};let result;
 try{result=await erasePerson(s.scope.store,'buyer-g2@example.test',{kind:'person'});}finally{globalThis.fetch=fetchBefore;}
 const kept=JSON.parse(String(redis.run(['HGET',s.hash,id])));assert.deepEqual(kept.people,[s.person]);
 console.log('G2_FULL_ERASURE_UNREADABLE_COMPANY',JSON.stringify({result,retainedPersonalLink:true}));
 assert.equal(result.ok,false,'full person erasure cannot claim completion while the real personal link remains');
});
