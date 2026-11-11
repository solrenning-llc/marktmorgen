/**
 * Codex G2 on #2574 (9c8f53af), kept as permanent tests: a company record that cannot be read but names the person
 * never lets their deletion or copy be said complete while the link stays. G2 allowed two safe ends for a deletion:
 * said not done with the link kept, or the link taken off by a safe protocol. The store does the second when the
 * record's list of people can be read (everything else in it kept as it is), so the deletion cases accept either end
 * and still refuse the unsafe one: done, with the link kept. A copy must still fail.
 */
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
 const kept=JSON.parse(String(redis.run(['HGET',s.hash,id])));
 console.log('G2_UNREADABLE_COMPANY_PERSON',JSON.stringify({action,unknown,result,people:kept.people}));
 if(action==='copy'){assert.deepEqual(kept.people,[s.person]);assert.equal(unknown,true,'unreadable evidence with retained personal links must not certify a completed empty copy');}
 else{assert.ok(unknown?kept.people.includes(s.person):!kept.people.includes(s.person),'a deletion is said not done with the link kept, or done with the link taken off: never done with it kept');assert.deepEqual(kept.name,{unknown:true},'the rest of the record is kept as it was');}
});

test('full real person erasure cannot complete while an unreadable company retains the personal link',async()=>{
 const s=await seed(),row=JSON.parse(String(redis.run(['HGET',s.hash,id])));row.name={unknown:true};redis.run(['HSET',s.hash,id,JSON.stringify(row)]);
 const fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited in independent review');};let result;
 try{result=await erasePerson(s.scope.store,'buyer-g2@example.test',{kind:'person'});}finally{globalThis.fetch=fetchBefore;}
 const kept=JSON.parse(String(redis.run(['HGET',s.hash,id])));
 console.log('G2_FULL_ERASURE_UNREADABLE_COMPANY',JSON.stringify({result,people:kept.people}));
 assert.ok(result.ok?!kept.people.includes(s.person):kept.people.includes(s.person),'full person erasure cannot claim completion while the real personal link remains');
});
test('a record whose list of people cannot be read but names the person: the deletion is said not done, the record kept',async()=>{
 const s=await seed(),broken=`{"id":"${id}","people":"${s.person}" broken`;redis.run(['HSET',s.hash,id,broken]);let unknown=false;
 try{await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set());}catch{unknown=true;}
 assert.equal(unknown,true,'a deletion that cannot take the person off is never said done');assert.equal(redis.run(['HGET',s.hash,id]),broken,'and the record is kept as it was');
});
