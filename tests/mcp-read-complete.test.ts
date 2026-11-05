/**
 * Codex G2 on #1933: the MCP tools list_bundle_choices and get_imports,
 * through the real route, with a key and a store's real products and import:
 * a page of listings answered partly, or an imports index with an entry that
 * is not an import's id, is said as unavailable (isError), never shown with
 * products or imports left out. Synthetic store and in-memory Redis only.
 */
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

test('a page of listings answered partly is unavailable, never a page with products left out (Codex G2)',async()=>{
 const {call}=await fixture();const real=redis.pipeline.bind(redis);let intercepted=false;
 redis.pipeline=async batch=>{
  if(batch.some(c=>c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1])))){intercepted=true;return [];}
  return real(batch);
 };
 try{const answer=await call('list_bundle_choices',{cursor:'20'});assert.equal(intercepted,true);assert.equal(answer.result.isError,true);}
 finally{redis.pipeline=real;}
});

test('an entry of the imports index that is not an import id makes the history unavailable, never left out (Codex G2)',async()=>{
 const {store,email,call}=await fixture();const made=await startImport(store,email,'contacts',{expected:1,file:'synthetic.csv',agreed:true});
 assert.equal(made.ok,true);if(!made.ok)return;
 const control=await call('get_imports');assert.equal(control.result.isError,false);assert.deepEqual(control.value.imports.map((j:{id:string})=>j.id),[made.job.id]);
 const real=redis.pipeline.bind(redis);let intercepted=false;
 redis.pipeline=async batch=>{
  if(batch.some(c=>c[0]==='LRANGE'&&c[1]===`nl:imports:list:${store.sid}`)){intercepted=true;return [['not-a-confirmed-import-id']];}
  return real(batch);
 };
 try{const answer=await call('get_imports');assert.equal(intercepted,true);assert.equal(answer.result.isError,true);}
 finally{redis.pipeline=real;}
});
