import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import LibraryPage from '@/app/library/page';
import {claimHandle,ensureStoreId,ensureStatsId,setPastBuyers,setSubscription,storeForEmail} from '@/lib/store';
import {rememberBuyers} from '@/lib/buyer-library';
import {createAgreement,listAgreements} from '@/lib/agreement-store';
import {waitingFor,waitingLine} from '@/lib/buyer-waiting';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';

async function main(){
 redis.clear();
 let externalCalls=0;globalThis.fetch=(async()=>{externalCalls++;throw new Error('Unexpected external request in synthetic review');}) as typeof fetch;
 process.env.RESEND_API_KEY='re_test_library_only_a_stand_in';
 const owner='jlib@example.com', buyer='buyer@example.com';
 await claimHandle(owner,'jlib','Library review','');
 await ensureStoreId(owner);await ensureStatsId(owner);await setPastBuyers(owner);
 await setSubscription(owner,{customerId:'cus_JLibrary',subscriptionId:'sub_JLibrary',active:true,tier:'creator',period:paidPeriod()});
 const store=(await storeForEmail(owner))!;
 await rememberBuyers(store.sid,[buyer]);
 const token='f'.repeat(64);
 const digest=createHash('sha256').update('nimbus-lib-link:'+token).digest('hex').slice(0,40);
 await redis.pipeline([['SET','nl:lib:link:'+digest,buyer,'EX',86400]]);
 for(let i=0;i<11;i++){
  const a=await createAgreement(store,{kind:'agreement',email:buyer,name:'Buyer',title:'Agreement '+i,body:'Example agreement.',lines:[],total:0,payRequest:''});
  assert.equal(a.ok,true,'valid synthetic agreement created');
 }
 const actual=(await listAgreements(store))!.length;
 const found=await waitingFor(store,buyer);
 const line=waitingLine(found);
 console.log('COUNT',JSON.stringify({actual,shown:found.agreements.length,line}));
 const original=redis.pipeline.bind(redis), commands:(string|number)[][]=[];
 try{
  redis.pipeline=async batch=>{commands.push(...batch.map(c=>[...c]));return original(batch);};
  await LibraryPage({searchParams:Promise.resolve({token})});
  await LibraryPage({searchParams:Promise.resolve({token})});
 }finally{redis.pipeline=original;}
 const indexes=commands.filter(c=>c[0]==='ZREVRANGE'&&(String(c[1]).startsWith('nl:agree:s:')||String(c[1]).startsWith('nl:payreq:s:')));
 const traffic=commands.filter(c=>c.some(x=>String(x).startsWith('nl:traffic:')));
 const waitingCommands=commands.filter(c=>c.some(x=>/^nl:(agree|payreq):/.test(String(x))));
 console.log('REPEATED_PAGE',JSON.stringify({waitingIndexReads:indexes.length,waitingCommands:waitingCommands.length,commands:commands.length,trafficCounters:traffic.length,externalCalls}));
 const beforeInvalid=commands.length;
 await LibraryPage({searchParams:Promise.resolve({token:'0'.repeat(64)})});
 assert.equal(commands.length,beforeInvalid,'instrumentation restored before negative control');
 assert.equal(externalCalls,0);
 let failed=0;
 try{assert.match(line,/11|at least|or more/,'a capped list is not an exact total');}catch(e){failed++;console.error(String(e));}
 try{assert.equal(indexes.length>0&&traffic.length===0,false,'each store must reserve before the additional waiting reads');}catch(e){failed++;console.error(String(e));}
 process.exitCode=failed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
