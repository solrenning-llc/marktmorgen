/**
 * Codex G2 on #2574 (a66000f3), kept as permanent tests: a person written with JSON's escapes in a company record
 * that cannot be read is still that person once decoded, so their deletion and copy never pass over it.
 */
/** Independent G2 return: semantically identical JSON encodings must not hide personal links. Uses actual row copier/eraser and full erasure. */
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

async function encoded(unreadable=true){
 const s=await seed(),row=JSON.parse(String(redis.run(['HGET',s.hash,id])));
 if(unreadable)row.name={unknown:true};
 const plain=JSON.stringify(row),escaped=plain.replace(s.person,[...s.person].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
 assert.notEqual(escaped,plain);assert.equal(escaped.includes(s.person),false);assert.deepEqual(JSON.parse(escaped).people,[s.person]);
 redis.run(['HSET',s.hash,id,escaped]);return{...s,escaped};
}
test('control: a valid escaped company is copied then safely unlinked',async()=>{
 const s=await encoded(false);assert.equal((await COPIERS['lib/crm-companies.ts'](s.scope as never)).length,1);
 await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set());
 assert.deepEqual(JSON.parse(String(redis.run(['HGET',s.hash,id]))).people,[]);
});
for(const action of ['erase','copy'] as const)test(`an encoded personal link in an unreadable company cannot certify a completed empty ${action}`,async()=>{
 const s=await encoded(),before=String(redis.run(['HGET',s.hash,id]));let unknown=false,result:unknown;
 try{result=action==='erase'?await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set()):await COPIERS['lib/crm-companies.ts'](s.scope as never);}catch{unknown=true;}
 const kept=JSON.parse(String(redis.run(['HGET',s.hash,id])));
 console.log('G2_ENCODED_COMPANY',JSON.stringify({action,unknown,result,retained:kept.people.includes(s.person)}));
 if(action==='copy'){assert.equal(String(redis.run(['HGET',s.hash,id])),before);assert.equal(unknown,true,'a completed empty copy must not omit the decoded personal link');}
 else{assert.ok(unknown||!kept.people.includes(s.person),'completion requires the personal link removed, irrespective of JSON spelling');assert.deepEqual(kept.name,{unknown:true});}
});
test('full real erasure cannot complete while the encoded personal link remains',async()=>{
 const s=await encoded(),fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited in independent review');};let result;
 try{result=await erasePerson(s.scope.store,'buyer-g2@example.test',{kind:'person'});}finally{globalThis.fetch=fetchBefore;}
 const kept=JSON.parse(String(redis.run(['HGET',s.hash,id])));
 console.log('G2_ENCODED_COMPANY_FULL',JSON.stringify({ok:result.ok,records:result.ok?result.records:undefined,retained:kept.people.includes(s.person)}));
 assert.ok(!result.ok||!kept.people.includes(s.person),'full erasure cannot report completion while the decoded link is retained');
});
