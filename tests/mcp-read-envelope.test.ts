/**
 * Codex A3 on #1933, kept as permanent tests: a read whose answer is not Redis's exact one (an extra result on a
 * one-command pipeline, a kept import that is not one) is unknown, said so as an error, never a shorter history or
 * page. Through the real MCP route, on the in-memory Redis.
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


test('a single-command imports index response with an extra result is unknown',async()=>{
 const {store,email,call}=await fixture();
 const made=await startImport(store,email,'contacts',{expected:1,file:'synthetic.csv',agreed:true});assert.ok(made.ok);
 const control=await call('get_imports');assert.equal(control.result.isError,false);
 const base=redis.pipeline;
 redis.pipeline=async batch=>{
  const reply=await base.call(redis,batch);
  return batch.some(c=>c[0]==='LRANGE'&&c[1]===`nl:imports:list:${store.sid}`) ? [...reply,'unexpected'] : reply;
 };
 try {assert.equal((await call('get_imports')).result.isError,true);}
 finally {redis.pipeline=base;}
});

test('a corrupt stored import is not omitted from a confirmed history',async()=>{
 const {email,call}=await fixture();
 const made=await startImport((await storeForEmail(email))!,email,'contacts',{expected:1,file:'synthetic.csv',agreed:true});assert.ok(made.ok);
 const control=await call('get_imports');assert.equal(control.result.isError,false);
 const base=redis.pipeline;
 redis.pipeline=async batch=>batch.some(c=>c[0]==='GET'&&c[1]===`nl:import:${made.job.id}`) ? ['{'] : base.call(redis,batch);
 try {const response=await call('get_imports');console.log('A3_CORRUPT_IMPORT',response);assert.equal(response.result.isError,true);}
 finally {redis.pipeline=base;}
});

test('a cached-card pipeline result with an extra answer is unknown',async()=>{
 const {call}=await fixture();const base=redis.pipeline;
 const control=await call('list_bundle_choices',{search:'Guide'});assert.equal(control.result.isError,false);
 redis.pipeline=async batch=>{
  const reply=await base.call(redis,batch);
  return batch.some(c=>c[0]==='HMGET'&&/^nl:catalog:.*:t$/.test(String(c[1]))) ? [...reply,'unexpected'] : reply;
 };
 try {assert.equal((await call('list_bundle_choices',{search:'Guide'})).result.isError,true);}
 finally {redis.pipeline=base;}
});
