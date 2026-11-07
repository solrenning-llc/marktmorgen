import assert from 'node:assert/strict';
import {sweepCheckouts} from '@/lib/checkout-sweep';
import {claimHandle,ensureStatsId,setPayPalSeller,storeForEmail} from '@/lib/store';
import {store as redis} from './redis-stub';
import * as registry from './plan-cost-registry';

type Commands=(string|number)[][];
async function scenario(repeat:boolean){
 redis.clear();process.env.STRIPE_SECRET_KEY='sk_test_synthetic_only';
 process.env.PAYPAL_PARTNER_CLIENT_ID='AZpartnerClientId0123456789';
 process.env.PAYPAL_PARTNER_SECRET='EPpartnerSecret0123456789';
 process.env.PAYPAL_PARTNER_MERCHANT_ID='PARTNERMERCH01';
 process.env.PAYPAL_BN_CODE='NimbusLabs_SP';delete process.env.PAYPAL_ENV;
 await claimHandle('owner@example.com','harbor','Harbor Kitchen','');
 await ensureStatsId('owner@example.com');await setPayPalSeller('owner@example.com','7KNGBPH2U58GQ');
 const store=(await storeForEmail('owner@example.com'))!;
 const keys=redis.keys().filter(k=>k.startsWith('nl:store:owner:'));
 assert.equal(keys.length,1);
 const original=redis.pipeline.bind(redis);let pages=0,watchReads=0;
 redis.pipeline=(async(commands:Commands)=>{
  for(const c of commands)if(c[0]==='ZRANGEBYSCORE'&&(c[1]===`nl:ppsell:pending:${store.statsId}`||c[1]===`nl:ppsell:watch:${store.statsId}`))watchReads++;
  const answer=await original(commands);
  if(commands[0]?.[0]==='SCAN'&&commands[0]?.includes('nl:store:owner:*')){
   if(++pages>2)throw Error('finite two-page proof ceiling');
   return [[repeat&&pages===1?'1':'0',keys]];
  }
  return answer;
 }) as typeof redis.pipeline;
 try{const result=await sweepCheckouts(Date.now()+10_000);return{pages,stores:result.stores,watchReads};}
 finally{redis.pipeline=original;}
}
async function main(){
 const control=await scenario(false);assert.deepEqual(control,{pages:1,stores:1,watchReads:2});
 const declared=(registry as unknown as Record<string,{rangeReadsPerStoreRun:number}|undefined>).PAYPAL_WATCH_RANGES?.rangeReadsPerStoreRun;
 const duplicate=await scenario(true);console.log(JSON.stringify({control,duplicate,declared:declared??null,comparedHeadContract:2}));
 // On the pre-PR graph the declaration is absent: 2 is the proposed head contract,
 // not a claim that the base declared this ceiling. Keep the causal execution identical.
 assert.ok(duplicate.watchReads<=(declared??2),'one store in a single finite sweep must fit the new per-store-run ceiling');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
