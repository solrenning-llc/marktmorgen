/**
 * Codex G2 on #2574, kept as permanent tests: only Redis's own whole answers count for the companies. A read that is
 * not one whole reply is never "no companies" (a page fails, a copy of a person's data fails, a deletion is not
 * done), and a write is written only on its exact 1 and refused only on its exact 0; anything else is unconfirmed
 * and keeps the room it took. Real CRM company mutation, erasure and export; synthetic transport only. G2's case of
 * an undo after an erasure (MEDIUM 3; proof 950de50f, tests/review-g2-company-evidence.test.ts, its ninth case, kept
 * as written), with an erasure landing between the undo's read and its write: an erased person never comes back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/companies/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {addCompany,changeCompanies,readCompanies,linkPerson,dropCompany} from '@/lib/crm-companies';
import {companiesPageData} from '@/lib/companies-read';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {ERASERS,erasePerson} from '@/lib/person-erasure';
import {COPIERS} from '@/lib/person-copy';
import {personKey} from '@/lib/person-key';
import {isSuppressed} from '@/lib/suppression';
import {dataKey} from '@/lib/store-data';
import {dataBytes} from '@/lib/store-data-rules';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
const who='buyer-g2@example.test',id='abcdef0123';
async function seed(linked=false){
 redis.clear();const owner='g2companies@example.test';assert.equal((await claimHandle(owner,'g2companies','Synthetic shop','')).ok,true);await ensureStatsId(owner);await ensureStoreId(owner);
 const paid=await setSubscription(owner,{customerId:'cus_G2Company',subscriptionId:'sub_G2Company',active:true,tier:'creator',period:paidPeriod()});assert.ok(paid?.subscriptionActive);
 const store=await storeForEmail(owner);assert.ok(store?.statsId);const person=personKey(store.statsId,who);
 const added=await changeCompanies(store.statsId,store,c=>addCompany(c,{name:'Synthetic company',website:'',note:''},id,100));assert.ok(added.ok);
 if(linked)assert.ok((await changeCompanies(store.statsId,store,c=>linkPerson(c,id,person))).ok);
 return{store,person,owner,hash:`nl:crm:co:${store.statsId}`};
}
function held(s:Awaited<ReturnType<typeof seed>>){return Number(redis.run(['HGET',dataKey(s.store)!,'crm:co'])??0);}
function weight(s:Awaited<ReturnType<typeof seed>>){const rows=redis.run(['HGETALL',s.hash]) as string[];let bytes=0;for(let i=0;i<rows.length;i+=2)bytes+=dataBytes([rows[i],rows[i+1]],1);return bytes;}
test('G2 known company write is funded, copied and erased from its own real row',async()=>{
 const s=await seed(true);assert.equal(held(s),weight(s));const scope={store:s.store,statsId:s.store.statsId,person:s.person};assert.equal((await COPIERS['lib/crm-companies.ts'](scope as never)).length,1);
 await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run(scope as never,[],new Set());assert.equal((await readCompanies(s.store.statsId))[0].people.length,0);assert.equal(held(s),weight(s));
});
for(const reply of [[],[null]])test('G2 partial company read cannot certify a completed erasure '+JSON.stringify(reply),async()=>{
 const s=await seed(true),original=redis.pipeline.bind(redis);let unknown=false;
 redis.pipeline=async commands=>commands[0]?.[0]==='HGETALL'&&commands[0][1]===s.hash?reply as never:original(commands);
 try{await ERASERS.find(e=>e.module==='lib/crm-companies.ts')!.run({store:s.store,statsId:s.store.statsId,person:s.person} as never,[],new Set());}catch{unknown=true;}finally{redis.pipeline=original;}
 assert.equal((await readCompanies(s.store.statsId))[0].people.includes(s.person),true);assert.equal(unknown,true,'erasure row reported completion while the genuine personal link remains');
});
test('G2 missing company count cannot become an empty successful page',async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);redis.pipeline=async commands=>commands[0]?.[0]==='HLEN'&&commands[0][1]===s.hash?[] as never:original(commands);
 let result;try{result=await companiesPageData(s.store);}finally{redis.pipeline=original;}
 assert.equal(redis.run(['HLEN',s.hash]),1);assert.equal(result.state,'failed','unknown count became no companies and bypassed paid reading');
});
test('G2 missing company read cannot become an empty completed data copy',async()=>{
 const s=await seed(true),original=redis.pipeline.bind(redis);redis.pipeline=async commands=>commands[0]?.[0]==='HGETALL'&&commands[0][1]===s.hash?[] as never:original(commands);let unknown=false;
 try{await COPIERS['lib/crm-companies.ts']({store:s.store,statsId:s.store.statsId,person:s.person} as never);}catch{unknown=true;}finally{redis.pipeline=original;}
 assert.equal(unknown,true,'copy certified no company despite unreadable genuine personal record');
});
for(const receipt of [[],[null]])test('G2 applied company write with unknown acknowledgement keeps its room '+JSON.stringify(receipt),async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);let ran=0;
 redis.pipeline=async commands=>{if(commands[0]?.[0]==='EVAL'&&String(commands[0][1]).startsWith('-- marktmorgen:crm-companies-write:')){ran++;await original(commands);return receipt as never;}return original(commands);};
 try{await changeCompanies(s.store.statsId!,s.store,c=>addCompany(c,{name:'Applied unknown company',website:'',note:'x'.repeat(300)},'bbbbbbbbbb',101));}finally{redis.pipeline=original;}
 assert.equal(ran,1);assert.equal((await readCompanies(s.store.statsId)).length,2);assert.ok(held(s)>=weight(s),JSON.stringify({held:held(s),required:weight(s)}));
});
test('G2 extra company-write acknowledgement cannot claim an unapplied mutation',async()=>{
 const s=await seed(),original=redis.pipeline.bind(redis);redis.pipeline=async commands=>commands[0]?.[0]==='EVAL'&&String(commands[0][1]).startsWith('-- marktmorgen:crm-companies-write:')?[1,0] as never:original(commands);
 let claimed=false;try{claimed=(await changeCompanies(s.store.statsId!,s.store,c=>addCompany(c,{name:'Not applied',website:'',note:''},'bbbbbbbbbb',101))).ok;}finally{redis.pipeline=original;}
 assert.equal((await readCompanies(s.store.statsId)).length,1);assert.equal(claimed,false,'extra reply certified an unpersisted company');
});
test('G2 stale undo cannot put back a person after real successful erasure',async()=>{
 const s=await seed(true),snapshot=(await readCompanies(s.store.statsId))[0];assert.ok((await changeCompanies(s.store.statsId!,s.store,c=>dropCompany(c,id))).ok);
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External transport prohibited in independent review');};let erased;
 try{erased=await erasePerson(s.store,who,{kind:'person'});}finally{globalThis.fetch=oldFetch;}
 assert.ok(erased.ok,JSON.stringify(erased));const current=await storeForEmail(s.owner);assert.ok(current?.listId);assert.equal(await isSuppressed(current.listId,who),true);
 const cookie=`${SESSION_COOKIE}=${await openSession(s.owner)}`;
 const response=await POST(new NextRequest('https://marktmorgen.com/api/store/companies',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'restore',name:snapshot.name,website:snapshot.website,note:snapshot.note,people:snapshot.people})}));
 const rows=await readCompanies(s.store.statsId);assert.equal(rows.some(c=>c.people.includes(s.person)),false,JSON.stringify({status:response.status,companies:rows,erased:erased.ok}));
});
test('An undo whose read came before a whole erasure cannot write the person back, and a person not erased still comes back',async()=>{
 const s=await seed(true),other=personKey(s.store.statsId!,'stays@example.test');assert.ok((await changeCompanies(s.store.statsId!,s.store,c=>linkPerson(c,id,other))).ok);
 const snapshot=(await readCompanies(s.store.statsId))[0];assert.deepEqual(snapshot.people,[s.person,other]);
 assert.ok((await changeCompanies(s.store.statsId!,s.store,c=>dropCompany(c,id))).ok);
 const cookie=`${SESSION_COOKIE}=${await openSession(s.owner)}`,original=redis.pipeline.bind(redis);let erased:Awaited<ReturnType<typeof erasePerson>>|null=null,step=0;
 // The undo read the companies, then stalled past its lock's ten seconds; the person was deleted, whole, in that time;
 // then the undo's write arrives.
 redis.pipeline=async commands=>{
  if(!step&&commands[0]?.[0]==='EVAL'&&String(commands[0][1]).startsWith('-- marktmorgen:crm-companies-write:')){
   step=1;redis.pipeline=original;redis.run(['DEL',`nl:crm:co:lock:${s.store.statsId}`]);const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('no transport');};
   try{erased=await erasePerson(s.store,who,{kind:'person'});}finally{globalThis.fetch=oldFetch;}
  }
  return original(commands);
 };
 let first;try{first=await POST(new NextRequest('https://marktmorgen.com/api/store/companies',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'restore',name:snapshot.name,website:snapshot.website,note:snapshot.note,people:snapshot.people})}));}finally{redis.pipeline=original;}
 assert.equal((erased as {ok:boolean}|null)?.ok,true,JSON.stringify(erased));const after=await readCompanies(s.store.statsId);
 assert.equal(after.some(c=>c.people.includes(s.person)),false,JSON.stringify({status:first.status,companies:after,erased}));
 // Pressed again (or answered at once): the person not erased comes back, the erased one is left out and said so.
 const again=first.status===200?first:await POST(new NextRequest('https://marktmorgen.com/api/store/companies',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'restore',name:snapshot.name,website:snapshot.website,note:snapshot.note,people:snapshot.people})}));
 const body=await again.json() as {ok:boolean;skipped?:string[]};const rows=await readCompanies(s.store.statsId);
 assert.equal(again.status,200);assert.deepEqual(rows.map(c=>c.people),[[other]]);assert.equal(rows.some(c=>c.people.includes(s.person)),false);assert.deepEqual(body.skipped,[s.person]);
 assert.equal(held(s),weight(s));
});
