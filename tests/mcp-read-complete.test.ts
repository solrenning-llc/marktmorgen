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
import {API_UNIT_BYTES,BUNDLE_CHOICES_MOST,IMPORTS_MOST,apiReadUnits,bundleChoicesWork,importsWork,settledUnits} from '@/lib/api-read-rules';
import {allowanceUsed,takeAllowance} from '@/lib/store-allowance';
import {allowanceFor} from '@/lib/store-allowance-rules';
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
 return {store,email,call,key:key.key};
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

test('a page of twenty listings is paid for at its most before any listing is read, and settled at what it read (Codex G2)',async()=>{
 const {call}=await fixture();const real=redis.pipeline.bind(redis);
 let listingBytes=0,listingReads=0,firstRead=-1,step=0;const debits:{at:number;n:number}[]=[];
 redis.pipeline=async batch=>{
  const answer=await real(batch);
  batch.forEach((c,i)=>{
   step++;
   if(c[0]==='GET'&&/^nl:catalog:.*:l:/.test(String(c[1]))){listingReads++;listingBytes+=Buffer.byteLength(String(answer[i]),'utf8');if(firstRead<0)firstRead=step;}
   if((c[0]==='INCRBY'||c[0]==='DECRBY')&&String(c[1]).includes(':api:'))debits.push({at:step,n:(c[0]==='DECRBY'?-1:1)*Number(c[2])});
   if(c[0]==='EVAL'&&String(c[1]).includes('store-allowance')&&batch.length===1)debits.push({at:step,n:NaN});
  });return answer;
 };
 try {
  const answer=await call('list_bundle_choices',{cursor:'20'});
  assert.equal(answer.result.isError,false);assert.equal(answer.value.products.length,20);assert.equal(listingReads,20);
  const held=apiReadUnits(BUNDLE_CHOICES_MOST);
  assert.ok(held>=1,'the page sets aside at least one request beyond the door');
  assert.ok(debits.some(d=>d.at<firstRead&&d.n===held),`the page's most (${held}) is taken before the first listing is read: ${JSON.stringify(debits)} first read at ${firstRead}`);
  assert.ok(listingBytes<=held*API_UNIT_BYTES,'what the listings weigh fits what was set aside');
 } finally {redis.pipeline=real;}
});

test('get_imports is paid for at its most before its index is read',async()=>{
 const {call}=await fixture();const real=redis.pipeline.bind(redis);
 let firstRead=-1,step=0,heldAt=-1;
 redis.pipeline=async batch=>{
  const answer=await real(batch);
  batch.forEach(c=>{step++;if(c[0]==='LRANGE'&&String(c[1]).startsWith('nl:imports:list:')&&firstRead<0)firstRead=step;if(c[0]==='INCRBY'&&String(c[1]).includes(':api:')&&Number(c[2])===apiReadUnits(IMPORTS_MOST)&&heldAt<0)heldAt=step;});
  return answer;
 };
 try {const answer=await call('get_imports');assert.equal(answer.result.isError,false);assert.ok(heldAt>0&&heldAt<firstRead,`held at ${heldAt}, index read at ${firstRead}`);}
 finally {redis.pipeline=real;}
});

// Ported onto main's paid reads (port of #1933): what each call keeps is the door's request and what it read, settled
// before it is sent; with too few requests left it is refused with the door's sentence, and none of its records is read.
test('each call keeps the door and what it read; with too few requests left it is refused and reads nothing',async()=>{
 const {store,email,call,key}=await fixture();
 const made=await startImport(store,email,'contacts',{expected:1,file:'synthetic.csv',agreed:true});assert.ok(made.ok);
 const used=async()=>allowanceUsed((await storeForEmail(email))!,'api');
 let before=await used();
 const page=await call('list_bundle_choices',{cursor:'20'});
 assert.equal(page.result.isError,false);assert.equal(page.value.products.length,20);
 const bundleKept=(await used())-before;
 assert.ok(bundleKept>=1+apiReadUnits(bundleChoicesWork(0,20))&&bundleKept<=1+settledUnits(BUNDLE_CHOICES_MOST,apiReadUnits(BUNDLE_CHOICES_MOST)),`a page of twenty listings keeps the door and its listings: ${bundleKept}`);
 before=await used();
 const imports=await call('get_imports');
 assert.equal(imports.result.isError,false);assert.equal(imports.value.imports.length,1);
 assert.equal((await used())-before,1+apiReadUnits(importsWork(1)),'one import keeps the door and the index and that import');
 const s=(await storeForEmail(email))!;
 const left=allowanceFor(s,'api')-(await used());
 if(left>1)await takeAllowance(s,'api',left-1);
 const real=redis.pipeline.bind(redis);const records:string[]=[];
 redis.pipeline=async batch=>{for(const c of batch)if(/^nl:(catalog:.*:(l|t)(:|$)|imports?:)/.test(String(c[1])))records.push(String(c[0])+' '+String(c[1]));return real(batch);};
 try{
  for(const [name,args] of [['list_bundle_choices',{}],['list_bundle_choices',{search:'Guide'}],['get_imports',{}]] as const){
   records.length=0;
   const response=await POST(new Request('https://marktmorgen.com/api/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
   const body=await response.json();
   assert.equal(body.error?.code,-32001,`${name}: refused`);assert.match(String(body.error?.message),/requests/i);
   assert.deepEqual(records,[],`${name}: none of its records is read`);
  }
 } finally {redis.pipeline=real;}
});
