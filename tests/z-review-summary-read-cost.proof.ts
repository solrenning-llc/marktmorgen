/** Real route/auth/session/review writer/monthly counter; no provider or malformed transport reply. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/store/review-summary/route';
import {SESSION_COOKIE,openSession} from '@/lib/auth';
import {claimHandle,ensureStatsId,ensureStoreId,setSubscription,addProduct,storeForEmail} from '@/lib/store';
import {saveReview} from '@/lib/reviews';
import {aiMonthKey,counted} from '@/lib/ai';
import {AI_MONTHLY} from '@/lib/ai-rules';
import {paidPeriod} from '@/tests/billing-period-fixture';
import {store as redis} from '@/tests/redis-stub';

for(const [name,tier,rows] of [['small exhausted Studio','pro',5],['large exhausted Studio','pro',60],['large Store without writing jobs','creator',60]] as const){
 test(name+': rejected generation fits its admitted studio byte budget',async()=>{
  redis.clear();const owner='summary-cost-proof@example.invalid';const now=Date.now();
  process.env.ANTHROPIC_API_KEY='sk-ant-'+'synthetic'.repeat(5);
  let providerCalls=0;const oldFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{providerCalls++;throw new Error('unexpected supplier boundary; no real request sent');}) as typeof fetch;
  const real=redis.pipeline.bind(redis);
  try{
   await claimHandle(owner,'summarycostproof','Synthetic reviews','');await ensureStatsId(owner);await ensureStoreId(owner);
   await setSubscription(owner,{customerId:'cus_SummaryCostFixture',subscriptionId:'sub_SummaryCostFixture',active:true,tier,period:paidPeriod(now)});
   const made=await addProduct(owner,'Synthetic guide','','19');assert.equal(made.ok,true);if(!made.ok)throw Error('setup');
   const store=(await storeForEmail(owner))!;assert.ok(store.statsId);assert.ok(store.sid);
   for(let i=0;i<rows;i++){
    const saved=await saveReview(store.statsId,{productId:made.product.id,email:`reviewer${i}@example.invalid`,reference:`cs_test_costproof${String(i).padStart(12,'0')}`,pi:`pi_costproof${i}`,rating:5,text:'Clear lessons '+ 'x'.repeat(986),name:'Synthetic reviewer'},store,now-i);
    assert.ok(saved.state==='created'||saved.state==='updated','real finite data-room writer must admit fixture review');
   }
   const cap=AI_MONTHLY[tier];
   for(let i=0;i<cap;i++)assert.equal((await counted(store,now,async()=>true)).ok,true,'fill actual monthly counter through its public helper');
   const monthKey=aiMonthKey(store,new Date(now));assert.ok(monthKey);
   const before=Number((await real([['GET',monthKey]]))[0]??0);assert.equal(before,cap);
   const session=await openSession(owner);
   let bytes=0,reviewReads=0,commands=0,studioUnits=0;const studioKeys=new Set<string>();
   redis.pipeline=(async(batch:(string|number)[][])=>{
    const reply=await real(batch);commands+=batch.length;
    batch.forEach((c,i)=>{
     if(c[0]==='HMGET'&&String(c[1]).startsWith(`nl:rev:${store.statsId}:`)){
      assert.ok(Array.isArray(reply[i]));const values=reply[i] as unknown[];for(const value of values){assert.equal(typeof value,'string');bytes+=Buffer.byteLength(value as string);}reviewReads++;
     }
     if(c[0]==='INCRBY'&&String(c[1]).startsWith('nl:allow:studio:')){studioUnits+=Number(c[2]);studioKeys.add(String(c[1]));}
    });return reply;
   }) as typeof redis.pipeline;
   const response=await POST(new NextRequest('https://marktmorgen.com/api/store/review-summary',{method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${session}`},body:JSON.stringify({product:made.product.id})}));
   redis.pipeline=real;
   const body=await response.json() as {error?:string};
   assert.deepEqual([response.status,body.error],[429,'used']);assert.equal(providerCalls,0);assert.equal(studioUnits,1);assert.equal(studioKeys.size,1);
   const studioKey=[...studioKeys][0];assert.equal(Number((await real([['GET',studioKey]]))[0]),1,'actual stored studio counter');
   const after=Number((await real([['GET',monthKey]]))[0]??0);assert.equal(after,cap,'no additional writing job admitted');
   assert.equal(reviewReads,1,'one actual batched review read');assert.ok(bytes>0);
   console.log('EVIDENCE',JSON.stringify({name,tier,rows,response:[response.status,body.error],appCommands:commands,reviewReads,reviewJsonBytes:bytes,studioUnits,studioCounter:1,studioBytesPriced:50_000,writingBefore:before,writingAfter:after,writingAllowance:cap,providerCalls}));
   assert.ok(bytes<=50_000*studioUnits,'monthly-refused generation must not read more review bytes than its admitted studio unit covers');
  }finally{redis.pipeline=real;globalThis.fetch=oldFetch;}
 });
}
