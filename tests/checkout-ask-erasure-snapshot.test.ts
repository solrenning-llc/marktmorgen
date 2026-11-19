/** #4290: a retry cannot replace the eraser's snapshot and leave a completed erasure's address behind. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { askIndexKey, askReminder, forgetAskPerson, sendAsked } from '@/lib/checkout-ask';
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from '@/lib/store';
import { readListing } from '@/lib/catalog';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';
import { ASK_FORGET, askMember, checkoutAskCount } from '@/lib/checkout-ask';
import { ASK_ERASE_BATCH, ERASE_FIXED_COMMANDS, ERASE_FIXED_BYTES, erasureWork } from '@/lib/erasure-rules';

const QUEUE='nl:recover:asks', PERSON='snapshot-erased@example.test';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function reached(p:Promise<void>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([p,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic barrier not reached')),3000);})]);}finally{clearTimeout(timer);}}

test('a retry after the eraser reads the index never survives a completed erasure',async()=>{
 redis.clear();
 process.env.RESEND_API_KEY='re_test_snapshot_only_fixture';
 process.env.STRIPE_SECRET_KEY='sk_test_snapshot_only_fixture';
 globalThis.fetch=async()=>{throw Error('no external provider in erasure regression');};
 const owner='snapshot-owner@example.test';
 await claimHandle(owner,'asksnapshot','Synthetic Store','');
 await ensureStoreId(owner);await ensureStatsId(owner);await ensureListId(owner);
 await setStripeAccount(owner,'acct_1TestHarbor0001',true);
 await setSubscription(owner,{customerId:'cus_snapshot',subscriptionId:'sub_snapshot',active:true,tier:'pro',period:paidPeriod()});
 await setRecovery(owner,{enabled:true,address:'Synthetic fixture address',asks:true});
 const made=await addProduct(owner,'Fixture','','12',null);assert.ok(made.ok);
 await setProductLink(owner,made.product.id,'https://example.test/fixture');
 const shop=(await storeForEmail(owner))!,product=(await readListing(shop,made.product.id))!;
 assert.equal(await askReminder({store:shop,product,email:PERSON,ip:'203.0.113.91'}),'asked');
 const index=askIndexKey(shop.statsId!,PERSON);
 const members=redis.run(['ZRANGEBYSCORE',index,'-inf','+inf']) as string[];assert.equal(members.length,1);
 const now=Math.floor(Date.now()/1000);redis.run(['ZADD',QUEUE,now-10,members[0]]);
 const loading=deferred(),failedLoad=deferred(),snapshot=deferred(),resumeErase=deferred();
 const real=redis.pipeline.bind(redis),oldLog=console.error;console.error=()=>{};
 let intercepted=false;
 const worker=sendAsked(async()=>{loading.resolve();await failedLoad.promise;throw Error('synthetic store load failed');},Date.now()+10000);
 let erase:Promise<number>|undefined;
 try{
  await reached(loading.promise);
  redis.pipeline=(async commands=>{
   const reply=await real(commands);
   const erasureRead=commands.some(c=>(c[0]==='ZRANGEBYSCORE'&&c[1]===index)||(c[0]==='EVAL'&&String(c[1]).startsWith('-- marktmorgen:ask-forget:')));
   if(!intercepted&&erasureRead){intercepted=true;snapshot.resolve();await resumeErase.promise;}
   return reply;
  }) as typeof redis.pipeline;
  erase=forgetAskPerson(shop.statsId!,PERSON);
  await reached(snapshot.promise);
  failedLoad.resolve();
  const sent=await worker;
  resumeErase.resolve();await erase;
  const queueLeft=(redis.run(['ZRANGEBYSCORE',QUEUE,'-inf','+inf']) as string[]).filter(m=>m.includes(PERSON)).length;
  const indexLeft=Number(redis.run(['ZCARD',index]));
  console.log(JSON.stringify({retried:sent.retried,queueLeft,indexLeft,erasureCompleted:true}));
  assert.deepEqual([queueLeft,indexLeft],[0,0],'the completed erasure leaves no address in either set');
 }finally{
  failedLoad.resolve();resumeErase.resolve();redis.pipeline=real;console.error=oldLog;
  await worker.catch(()=>{});if(erase)await erase.catch(()=>{});
 }
});

// The same public eraser also rejects an unpaid increase and an indeterminate reply; it never calls either empty.

const SID='abcdefabcdefabcdefabcdefabcdef12';
function seed(n:number,email=PERSON,sid=SID){
 const index=askIndexKey(sid,email),members:string[]=[];
 for(let i=0;i<n;i++){
  const member=askMember({statsId:sid,handle:'synthetic',productId:`product${i}`,email,askedAt:1700000000+i,from:'page',after:3600});
  members.push(member);redis.run(['ZADD',QUEUE,1700003600+i,member]);redis.run(['ZADD',index,1700003600+i,member]);
 }
 return{index,members};
}

test('an index that grew beyond its paid count is retained for a newly admitted retry',async()=>{
 redis.clear();const{index}=seed(1);
 const paid=await checkoutAskCount(SID,PERSON);seed(2);
 await assert.rejects(forgetAskPerson(SID,PERSON,paid),/checkout reminder asks/);
 assert.equal(redis.run(['ZCARD',QUEUE]),2);assert.equal(redis.run(['ZCARD',index]),2);
 assert.equal(await forgetAskPerson(SID,PERSON),2);
});

test('the atomic eraser checks every member before removing any, and keeps other people and stores',async()=>{
 for(const malformed of ['not-json',JSON.stringify([SID,'synthetic','p','someone-else@example.test',1700000000])]){
  redis.clear();const{index,members}=seed(1);
  redis.run(['ZADD',index,1700003601,malformed]);
  await assert.rejects(forgetAskPerson(SID,PERSON),/checkout reminder asks/);
  assert.notEqual(redis.run(['ZSCORE',QUEUE,members[0]]),null);
  assert.equal(redis.run(['ZCARD',index]),2);
 }
 redis.clear();const own=seed(ASK_ERASE_BATCH*2+1);
 const other=seed(1,'other-person@example.test'),elsewhere=seed(1,PERSON,'fedcbafedcbafedcbafedcbafedcbafedcba');
 assert.equal(await forgetAskPerson(SID,PERSON.toUpperCase()),1025);
 assert.equal(redis.run(['ZCARD',own.index]),0);
 for(const keep of [other,elsewhere])assert.notEqual(redis.run(['ZSCORE',QUEUE,keep.members[0]]),null);
 assert.equal(redis.run(['ZCARD',QUEUE]),2);
});

test('a lost reply after the Lua operation applied is retryable without leaving an orphan',async()=>{
 redis.clear();const{index}=seed(1),real=redis.pipeline.bind(redis);let lost=false;
 redis.pipeline=(async commands=>{
  const reply=await real(commands);
  if(!lost&&commands.some(c=>c[0]==='EVAL'&&c[1]===ASK_FORGET)){lost=true;throw Error('synthetic applied reply lost');}
  return reply;
 }) as typeof redis.pipeline;
 try{await assert.rejects(forgetAskPerson(SID,PERSON),/applied reply lost/);}finally{redis.pipeline=real;}
 assert.equal(redis.run(['ZCARD',QUEUE]),0);assert.equal(redis.run(['ZCARD',index]),0);
 assert.equal(await forgetAskPerson(SID,PERSON),0);
});

test('unknown count and operation replies never report a completed empty erasure',async()=>{
 const real=redis.pipeline.bind(redis);
 try{
  for(const count of [null,'0',-1,0.5,NaN,{},[],[0]]){
   redis.pipeline=(async()=>[count]) as typeof redis.pipeline;
   await assert.rejects(checkoutAskCount(SID,PERSON),/ask count/);
  }
  for(const reply of [null,[],[0],[0,0,0],[-1,-1],[2,1],[0,3],['0','0'],{taken:0,indexed:0}]){
   redis.pipeline=(async()=>[reply]) as typeof redis.pipeline;
   await assert.rejects(forgetAskPerson(SID,PERSON,2),/checkout reminder asks/);
  }
 }finally{redis.pipeline=real;}
});

test('the paid cost adds the count, fixed Lua work and every removal batch without transferring members',()=>{
 for(const n of [0,1,512,513,1025,100000]){
  const work=erasureWork({checkoutAsks:n});
  assert.equal(work.commands,ERASE_FIXED_COMMANDS+Math.ceil(n/ASK_ERASE_BATCH));
  assert.equal(work.bytes,ERASE_FIXED_BYTES);
 }
 for(const n of [-1,0.5,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>erasureWork({checkoutAsks:n}),RangeError);
 assert.ok(Buffer.byteLength(ASK_FORGET)+1000<=5000,'the fixed byte addition covers the script, two keys, arguments and counts');
});
