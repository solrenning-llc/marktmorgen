/** Real summary/store/reviews/monthly quota; synthetic model and keep-ACK transport. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aiMonthKey} from '@/lib/ai';
import {KEEP_REVIEW_SUMMARY,makeReviewSummary,readReviewSummary} from '@/lib/review-ai-summary';
import {saveReview} from '@/lib/reviews';
import {addProduct,claimHandle,ensureStatsId,ensureStoreId,setSubscription,storeForEmail} from '@/lib/store';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
import {ROOM} from './data-room';
const pipeline=redis.pipeline.bind(redis);
let mode:unknown='healthy', intercepted=0, models=0, commands=0;
redis.pipeline=(async (batch:(string|number)[][])=>{
 commands+=batch.length;
 const out:unknown[]=[];
 for(const command of batch){
  if(command[0]==='EVAL'&&command[1]===KEEP_REVIEW_SUMMARY&&mode!=='healthy'){
   intercepted++;out.push(mode==='extra'?0:mode); // Deliberately not applied, not merely a lost ACK.
  }else out.push((await pipeline([command]))[0]);
 }
 if(mode==='extra'&&batch.some(c=>c[0]==='EVAL'&&c[1]===KEEP_REVIEW_SUMMARY))out.push(1);
 return out;
}) as typeof redis.pipeline;
process.env.ANTHROPIC_API_KEY='sk-ant-test-only-a-stand-in-0123456789';
globalThis.fetch=(async(input:string|URL|Request)=>{
 if(new URL(String(input)).hostname==='api.anthropic.com'){
  models++;return Response.json({content:[{type:'text',text:JSON.stringify({themes:[{title:'Clear lessons',reviews:[1,2,3,4,5]}]})}]});
 }
 return Response.json({object:'list',data:[],has_more:false});
}) as typeof fetch;
for(const [label,receipt] of [['boolean',true],['numeric text','1'],['nested',[1]],['extra pipeline','extra'],['healthy','healthy']] as const){
 test('summary keep '+label+' never certifies an unapplied write',async()=>{
  redis.clear();mode='healthy';models=0;intercepted=0;
  const email='summary-proof@example.invalid';
  await claimHandle(email,'summaryproof','Synthetic summary','');
  await ensureStatsId(email);await ensureStoreId(email);
  await setSubscription(email,{customerId:'cus_Proof0001',subscriptionId:'sub_Proof0001',active:true,tier:'pro',period:paidPeriod()});
  const made=await addProduct(email,'Synthetic lessons','','49');assert.ok(made.ok);
  const store=(await storeForEmail(email))!;const id=made.product.id,stats=store.statsId!;
  for(let i=0;i<5;i++)await saveReview(stats,{productId:id,email:`buyer${i}@example.invalid`,reference:`cs_test_proof${i}00000000`,pi:`pi_proof${i}`,rating:5,text:'Clear lessons',name:'Synthetic buyer'},ROOM);
  mode=receipt;commands=0;const now=Date.now();const result=await makeReviewSummary(store,id,now);const appCommands=commands;
  mode='healthy';
  const [head,last,month]=await pipeline([['GET',`nl:rsum:${stats}:${id}`],['GET',`nl:rsum:last:${stats}:${id}`],['GET',aiMonthKey(store,new Date(now))!]]);
  if(models!==1)console.log('HARNESS',JSON.stringify(result));assert.equal(models,1);assert.equal(Number(month),1,'the real monthly job remains spent; no free provider budget is claimed');
  if(label==='healthy'){assert.ok(result.ok&&result.fresh);assert.equal((await readReviewSummary(stats,id))?.themes.length,1);return;}
  assert.equal(intercepted,1);assert.equal(head,null);assert.equal(last,null);
  console.log('EVIDENCE',JSON.stringify({label,appCommands,syntheticModelCalls:models,confirmedMonthlyJobs:Number(month),headAbsent:head===null,weeklyMarkAbsent:last===null,reportedFresh:result.ok&&result.fresh}));
  assert.equal(result.ok,false,'unconfirmed keep must not report a saved fresh summary');
 });
}
