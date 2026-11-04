import assert from 'node:assert/strict';
import {sendEmail,sendBatch,sendListBatch,serviceMailKnownUnavailable} from '@/lib/email';
import {CURRENT_RESEND_FALLBACK_REVIEW} from '@/lib/resend-fallback-budget';
import {CURRENT_RESEND_CREDENTIAL_BINDING} from '@/lib/resend-fallback-transport';
import {store as redis} from '@/tests/redis-stub';
import {allowanceUsed} from '@/lib/store-allowance';
import {paidPeriod} from '@/tests/billing-period-fixture';
import {createResendFallbackFixture} from '@/tests/resend-fallback-fixture';
import {installSesMailFixture} from '@/tests/ses-mail-fixture';

const credential='re_SYNTHETIC_METER_PREFLIGHT_ONLY';
process.env.RESEND_API_KEY=credential;
for(const key of ['AWS_SES_ROLE_ARN','AWS_SES_REGION','AWS_SES_CONFIGURATION_SET','AWS_SES_TOPIC_ARN','VERCEL_OIDC_TOKEN','VERCEL'])delete process.env[key];
assert.equal(CURRENT_RESEND_FALLBACK_REVIEW,null);assert.equal(CURRENT_RESEND_CREDENTIAL_BINDING,null);
let forbidden=0;globalThis.fetch=async()=>{forbidden++;throw Error('FORBIDDEN_REAL_NETWORK');};
const legacy={sid:'a'.repeat(32),handle:'meter-proof',statsId:null,tier:'creator' as const,subscriptionActive:true,subscriptionId:null,trialEnds:0,planEndedAt:'',cycle:'month' as const,period:paidPeriod()};
const message={from:'Shop <shop@example.test>',to:'buyer@example.test',subject:'Existing access',text:'Original content',html:'<p>Original content</p>'};
const batch=[message,{...message,to:'other@example.test'}];
const output:Record<string,unknown>[]=[];
async function scenario(name:string,operation:(meter:import("@/lib/email").EmailMeter)=>Promise<unknown>,funded=false){
 redis.clear();
 const shop=funded?{...legacy,statsId:'b'.repeat(32),period:{...legacy.period,funded:true as const}}:legacy;
 const before=await allowanceUsed(shop,'transactional');
 const result=await operation({by:'store',store:shop,kind:'transactional'});
 const after=await allowanceUsed(shop,'transactional');
 const record={name,result,before,after,spent:after-before,knownUnavailable:serviceMailKnownUnavailable(),allowanceKeys:redis.keys().filter(k=>k.startsWith('nl:allow:'))};output.push(record);return record;
}
export async function auditMeterPreflight(){
 output.length=0;
 await scenario('single_NULL_default',m=>sendEmail({...message,meter:m}));
 await scenario('batch_NULL_default',m=>sendBatch(batch,'SYNTHETIC_NULL_BATCH',m));
 const list=await scenario('list_only_no_SES',m=>sendListBatch(batch,'SYNTHETIC_LIST_ONLY',m));assert.equal(list.result,'waiting');
 assert.equal((await scenario('funded_NULL_finance_before_meter',m=>sendEmail({...message,meter:m}),true)).spent,0);
 const invalid=await scenario('invalid_single_before_meter',m=>sendEmail({...message,to:'invalid',meter:m}));assert.equal(invalid.result,false);
 const empty=await scenario('empty_batch_keeps_sent',m=>sendBatch([],'SYNTHETIC_EMPTY',m));assert.equal(empty.result,'sent');
 const emptyList=await scenario('empty_list_keeps_sent',m=>sendListBatch([],'SYNTHETIC_EMPTY_LIST',m));assert.equal(emptyList.result,'sent');
 const invalidBatch=await scenario('invalid_batch_keeps_retry',m=>sendBatch([{...message,to:'invalid'}],'SYNTHETIC_INVALID_BATCH',m));assert.equal(invalidBatch.result,'retry');

 const positive=await createResendFallbackFixture({credential,cap:3,received:1,fetch:async()=>Response.json({id:'synthetic_positive'})});
 const single=await scenario('explicit_finite_runtime_positive',m=>sendEmail({...message,meter:m},positive.runtime));assert.equal(single.result,true);assert.equal(single.spent,1);
 const exhausted=await scenario('runtime_present_but_remaining_quota_insufficient',m=>sendBatch(batch,'SYNTHETIC_QUOTA_BATCH',m,undefined,positive.runtime));assert.equal(exhausted.result,'retry');assert.equal(exhausted.spent,0);
 assert.equal(positive.requests.filter(r=>r.method==='POST').length,1);
 const positiveBatch=await createResendFallbackFixture({credential,cap:3,received:1,fetch:async()=>Response.json({data:[{id:'synthetic_a'},{id:'synthetic_b'}]})});
 const accepted=await scenario('explicit_finite_runtime_batch_positive',m=>sendBatch(batch,'SYNTHETIC_BATCH_POSITIVE',m,undefined,positiveBatch.runtime));assert.equal(accepted.result,'sent');assert.equal(accepted.spent,2);
 const onlyAmazon=await scenario('only_amazon_no_SES_even_with_funded_Resend_runtime',m=>sendBatch(batch,'SYNTHETIC_ONLY_AMAZON',m,'amazon',positiveBatch.runtime));assert.equal(onlyAmazon.result,'retry');
 const fixture=installSesMailFixture();try{
  fixture.configure();await fixture.setReady(true);
  const onlyResend=await scenario('only_resend_with_configured_SES_but_NULL_fallback',m=>sendBatch(batch,'SYNTHETIC_ONLY_RESEND',m,'resend'));assert.equal(onlyResend.result,'retry');assert.equal(fixture.calls.ses,0);assert.equal(fixture.calls.resend,0);
  const ses=await scenario('configured_SES_positive_NULL_fallback',m=>sendEmail({...message,meter:m}));assert.equal(ses.result,true);assert.equal(ses.spent,1);assert.equal(fixture.calls.ses,1);
  const creatorCredential='re_SYNTHETIC_CREATOR_DOMAIN_ONLY',readCredential='re_SYNTHETIC_CREATOR_USAGE_ONLY';
  delete process.env.RESEND_API_KEY;process.env.RESEND_CREATORS_API_KEY=creatorCredential;process.env.RESEND_READ_API_KEY=readCredential;process.env.MARKETING_FROM_DOMAIN='creators.example.test';
  try{
   const creatorFixture=await createResendFallbackFixture({credential:creatorCredential,usageCredential:readCredential,cap:3,received:1,fetch:async()=>Response.json({data:[{id:'synthetic_creator_a'},{id:'synthetic_creator_b'}]})});
   const creatorBatch=batch.map(m=>({...m,from:'Creator <shop@creators.example.test>'}));
   const creator=await scenario('only_resend_creator_key_no_site_key_SES_configured',m=>sendBatch(creatorBatch,'SYNTHETIC_CREATOR_KEY',m,'resend',creatorFixture.runtime));
   assert.equal(creator.result,'sent');assert.equal(creator.spent,2);assert.equal(creatorFixture.requests.filter(r=>r.method==='POST').length,1);assert.equal(fixture.calls.ses,1);
  }finally{process.env.RESEND_API_KEY=credential;for(const k of ['RESEND_CREATORS_API_KEY','RESEND_READ_API_KEY','MARKETING_FROM_DOMAIN'])delete process.env[k];}

 }finally{fixture.restore();}
 for(const by of ['company','order','monthly'] as const){redis.clear();assert.equal(await sendEmail({...message,meter:{by}}),false);output.push({name:'external_meter_'+by,keys:redis.keys()});}
 assert.equal(forbidden,0);
 return {source:'e1105b3cc38df24264128cad0865d8f5d2110d59',review:CURRENT_RESEND_FALLBACK_REVIEW,binding:CURRENT_RESEND_CREDENTIAL_BINDING,providerBoundary:'real sendEmail/sendBatch/sendListBatch/guard; synthetic HTTP and actual MemoryRedis app ledger; budget ACK fixture is separate and not a Lua proof',scenarios:output,positiveSinglePosts:positive.requests.filter(r=>r.method==='POST').length,positiveBatchPosts:positiveBatch.requests.filter(r=>r.method==='POST').length,forbiddenExternalFetch:forbidden};
}
