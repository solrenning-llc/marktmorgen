import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POST} from '@/app/api/mcp/route';
import {makeKey} from '@/lib/api-keys';
import {startImport} from '@/lib/imports';
import {addDraftProducts,claimHandle,ensureStatsId,setSubscription,storeForEmail} from '@/lib/store';
import {paidPeriod} from './billing-period-fixture';
import {store as redis} from './redis-stub';

async function fixture() {
 redis.clear();
 const email='review-g2-mcp@example.com';
 await claimHandle(email,'review-g2-mcp','Synthetic review','');
 await ensureStatsId(email);
 await setSubscription(email,{customerId:'cus_G2McpReview',subscriptionId:'sub_G2McpReview',active:true,tier:'pro',cycle:'month',period:paidPeriod()});
 const made=await addDraftProducts(email,Array.from({length:50},(_,i)=>({title:`Guide ${i} ${'€'.repeat(70)}`,summary:'€'.repeat(300),priceCents:1900,link:'https://example.com/guide'})));
 assert.equal(made.ok,true,'all listings are created by the real product writer');
 const store=(await storeForEmail(email))!;
 const key=await makeKey(store.sid,'Synthetic review');
 assert.equal(key.ok,true);if(!key.ok)throw Error('key');
 const call=async(name:string,args:Record<string,unknown>={})=>{
  const response=await POST(new Request('https://marktmorgen.com/api/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key.key}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
  const body=await response.json();
  assert.ok(body.result,'real API authorization and allowance succeeded');
  return {result:body.result,value:JSON.parse(body.result.content[0].text)};
 };
 return {store,email,call};
}
globalThis.fetch=async()=>{throw Error('No external services in review');};

test('twenty valid listings must fit the bytes admitted before their GETs',async()=>{
 const {call}=await fixture();const real=redis.pipeline.bind(redis);
 let listingBytes=0,listingReads=0;const debits:number[]=[];
 redis.pipeline=async batch=>{
  const answer=await real(batch);
  batch.forEach((c,i)=>{
   if(c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1]))){listingReads++;listingBytes+=Buffer.byteLength(String(answer[i]),'utf8');}
   if(c[0]==='INCRBY'&&String(c[1]).includes(':api:'))debits.push(Number(c[2]));
  });return answer;
 };
 try {
  const answer=await call('list_bundle_choices',{cursor:'20'});
  assert.equal(answer.result.isError,false);assert.equal(answer.value.products.length,20);assert.equal(listingReads,20);
  assert.deepEqual(debits,[1]);console.log({listingBytes,listingReads,debits});
  // Conservatively excludes store/key reads, command bytes and every write.
  assert.ok(listingBytes<=20_000*debits.reduce((a,b)=>a+b,0),`${listingBytes} listing-result bytes exceed the single 20 KB API unit`);
 } finally {redis.pipeline=real;}
});

test('a partial page of listing replies is unavailable, not a confirmed empty product page',async()=>{
 const {call}=await fixture();const real=redis.pipeline.bind(redis);let intercepted=false;
 redis.pipeline=async batch=>{
  if(batch.some(c=>c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1])))){intercepted=true;return [];}
  return real(batch);
 };
 try{const answer=await call('list_bundle_choices',{cursor:'20'});assert.equal(intercepted,true);console.log(answer);assert.equal(answer.result.isError,true);}
 finally{redis.pipeline=real;}
});

test('invalid import index entries cannot be silently omitted from confirmed history',async()=>{
 const {store,email,call}=await fixture();const made=await startImport(store,email,'contacts',{expected:1,file:'synthetic.csv',agreed:true});
 assert.equal(made.ok,true);if(!made.ok)return;
 const control=await call('get_imports');assert.equal(control.result.isError,false);assert.deepEqual(control.value.imports.map((j:{id:string})=>j.id),[made.job.id]);
 const real=redis.pipeline.bind(redis);let intercepted=false;
 redis.pipeline=async batch=>{
  if(batch.some(c=>c[0]==='LRANGE'&&c[1]===`nl:imports:list:${store.sid}`)){intercepted=true;return [['not-a-confirmed-import-id']];}
  return real(batch);
 };
 try{const answer=await call('get_imports');assert.equal(intercepted,true);console.log(answer);assert.equal(answer.result.isError,true);}
 finally{redis.pipeline=real;}
});
