/** Identified G2 follow-up: whole JSON is unknown, but the genuine encoded people array remains intact. */
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

for(const useEscapes of [false,true])for(const action of ['erase','copy','full'] as const)test(`an unparseable record with a ${useEscapes?'encoded':'plain'} retained link cannot complete ${action}`,async()=>{
 const s=await encoded(),whole=useEscapes?s.escaped:JSON.stringify(JSON.parse(s.escaped)),broken=whole.slice(0,-1);assert.throws(()=>JSON.parse(broken));assert.equal(broken.includes(s.person),!useEscapes);
 const at=broken.indexOf('"people":')+'"people":'.length,end=broken.indexOf(']',at)+1;
 assert.deepEqual(JSON.parse(broken.slice(at,end)),[s.person],'the people array itself still contains the real decoded link');
 redis.run(['HSET',s.hash,id,broken]);let unknown=false,result:unknown;
 try{
  if(action==='full'){
   const saved=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited');};
   try{const reply=await erasePerson(s.scope.store,'buyer-g2@example.test',{kind:'person'});result=reply;unknown=!reply.ok;}finally{globalThis.fetch=saved;}
  }else result=action==='erase'?await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set()):await COPIERS['lib/crm-companies.ts'](s.scope as never);
 }catch{unknown=true;}
 const kept=redis.run(['HGET',s.hash,id]);const retained=typeof kept==='string'&&kept.replace(/\\u([0-9a-f]{4})/gi,(_match,hex:string)=>String.fromCharCode(parseInt(hex,16))).includes(s.person);
 console.log('G2_BROKEN_ENCODED_COMPANY',JSON.stringify({useEscapes,action,unknown,result,retained}));
 if(action==='copy'){assert.equal(kept,broken,'a copy never mutates the retained evidence');assert.equal(unknown,true,'the copy must refuse unknown evidence with the retained link');}
 else assert.ok(unknown||!retained,'unparseable evidence with a retained personal link cannot certify completed absence');
});

/** Identified G extension: no partial company rewrite on unknown evidence; own __proto__ JSON keys are data. */
for (const mode of ['mixed-records','nested-proto-key'] as const) for (const action of ['erase','copy','full'] as const) test(`G mixed-boundary ${mode} ${action}`, async()=>{
 const s=await seed();
 if(mode==='mixed-records'){
  const added=await changeCompanies(s.scope.statsId,s.scope.store,c=>addCompany(c,{name:'Second synthetic company',website:'',note:''},'bbbbbbbbbb',101));assert.ok(added.ok);
  const raw=String(redis.run(['HGET',s.hash,'bbbbbbbbbb']));assert.equal(raw.includes(s.person),false);
  redis.run(['HSET',s.hash,'bbbbbbbbbb',raw.slice(0,-1)]);
 }else{
  const row=JSON.parse(String(redis.run(['HGET',s.hash,id])));row.people=[];
  row.name=JSON.parse('{"__proto__":'+JSON.stringify({[s.person]:'retained'})+'}');
  assert.equal(Object.prototype.hasOwnProperty.call(row.name,'__proto__'),true);
  redis.run(['HSET',s.hash,id,JSON.stringify(row)]);
 }
 const before=redis.run(['HGETALL',s.hash]);let unknown=false;
 try{
  if(action==='full'){
   const saved=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited');};
   try{unknown=!(await erasePerson(s.scope.store,'buyer-g2@example.test',{kind:'person'})).ok;}finally{globalThis.fetch=saved;}
  }else if(action==='erase')await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set());
  else await COPIERS['lib/crm-companies.ts'](s.scope as never);
 }catch{unknown=true;}
 assert.equal(unknown,true,'mixed/own-prototype-key evidence must not certify absence or completed work');
 assert.deepEqual(redis.run(['HGETALL',s.hash]),before,'unknown preflight leaves all company evidence byte-identical');
 // Use the approved creator-removal writer to recover; never hand-delete or weaken the unknown assertion.
 const repaired=await changeCompanies(s.scope.statsId,s.scope.store,(companies,unreadable)=>({ok:true,companies,drop:unreadable}));assert.ok(repaired.ok);
 await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(s.scope as never,[],new Set());
 const after=JSON.stringify(redis.run(['HGETALL',s.hash]));assert.equal(after.includes(s.person),false,'after explicit removal of unreadable records, the genuine row eraser can finish');
});
