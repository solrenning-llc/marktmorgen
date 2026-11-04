import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVE_PAID_RESOURCE_WINDOW,reservePaidResourceWindow} from '@/lib/contract-resource-window';
import {reserveContractFunding,activateCheckoutContract} from '@/lib/contract-funding';
import {contractFundingConfiguration} from '@/lib/contract-funding-rules';
import {allowanceWindow} from '@/lib/allowance-window';
import {reserveStoreUpload,reserveUploadControl} from '@/lib/upload-budget';
import {contractFixture} from './contract-funding-fixture';
import {applyContractTaxCoverage} from './contract-tax-fixture';
import {reset,seed,ledger,calls,resourceSettings} from './contract-resource-redis';
const ledgerKey='nl:contract-reserve:v1',statsId='a'.repeat(32);
async function setup(cycle:'month'|'year'='month',options:{admissionMs?:number;durationSeconds?:number;taxCoverage?:boolean}={}){
 reset();resourceSettings({lost:false,failure:false,response:null,afterAck:null,acknowledge:null});const f=contractFixture();
 f.policy.admissionsUntil=new Date(Date.now()+(options.admissionMs??10*86400000)).toISOString();
 applyContractTaxCoverage(f);
 const config=contractFundingConfiguration(f.policy,f.context)!;assert.ok(config);seed(config);
 assert.ok(await reserveContractFunding(statsId,'creator',cycle,'checkout',f.policy,f.context,'ctr_resources'));
 const created=Math.floor(Date.now()/1000),end=created+(options.durationSeconds??(cycle==='year'?365:30)*86400);
 assert.equal(await activateCheckoutContract({statsId,grantId:'ctr_resources',reviewId:f.policy.reviewId,subscriptionId:'sub_ResourceWindow001',tier:'creator',cycle,createdSeconds:created,trialing:false,periodStartSeconds:created,periodEndSeconds:end},f.policy,f.context),true);
 const store={statsId,tier:'creator' as const,cycle,subscriptionId:'sub_ResourceWindow001',subscriptionActive:true,trialEnds:0,planEndedAt:'',period:{start:created,end,renews:true,funded:true as const}};
 return{...f,config,store,h:ledger.get(ledgerKey)!};
}
test('paid resource clones cannot discard original fiscal presence or hidden executable evidence',async()=>{
 let reads=0;
 for(const field of ['taxReview','taxContext'])for(const kind of ['hidden','getter','inherited','proxy']){
  const f=await setup(),row=f.review.scenarios.creator_month_full!,before=[...f.h],count=calls.length;
  if(kind==='inherited')Object.setPrototypeOf(row,{[field]:null});
  else Object.defineProperty(row,field,kind==='getter'?{enumerable:false,get(){reads++;throw Error('must not execute');}}:{value:null,enumerable:false,configurable:true});
  if(kind==='proxy')f.review.scenarios.creator_month_full=new Proxy(row,{has(){return false;}});
  assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false);
  assert.equal(calls.length,count);assert.deepEqual([...f.h],before);
  assert.equal(f.h.has('resource:ctr_resources:0'),false);
 }
 assert.equal(reads,0);
});
test('paid resources use the same fully bound TX contract rather than a test-only approval path',async()=>{
 const f=await setup('year',{taxCoverage:true}),before=new Map(f.h);
 assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true);
 assert.ok(f.h.has('resource:ctr_resources:0'));
 assert.ok(new TextEncoder().encode(JSON.stringify(calls.at(-1))).length<=12288);
 for(const [key,value] of before)assert.equal(f.h.get(key),value);
 const callsBefore=calls.length;f.policy.liabilitiesThrough=new Date(Date.parse(f.policy.liabilitiesThrough)+1).toISOString();
 assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false);assert.equal(calls.length,callsBefore);
});
test('paid resources reject a policy whose captured tail outlives its fiscal books before any ledger call',async()=>{
 const f=await setup('year',{taxCoverage:true});f.policy.reservedFundsCents=1e12;
 const last=Reflect.ownKeys(f.policy).at(-1);let copying=false;
 const proxy=new Proxy(f.policy,{ownKeys(target){copying=true;return Reflect.ownKeys(target);},getOwnPropertyDescriptor(target,key){
  const descriptor=Reflect.getOwnPropertyDescriptor(target,key);if(!descriptor)return descriptor;
  const capture=copying;if(key===last)copying=false;
  if(capture&&key==='reviewedLiabilityTailDays')return {...descriptor,value:descriptor.value+400};
  if(capture&&key==='liabilitiesThrough')return {...descriptor,value:new Date(Date.parse(descriptor.value)+800*86400000).toISOString()};
  return descriptor;
 }});
 const count=calls.length,before=[...f.h];
 assert.equal(await reservePaidResourceWindow(f.store,proxy,f.context),false);
 assert.equal(calls.length,count);assert.deepEqual([...f.h],before);assert.equal(f.h.has('resource:ctr_resources:0'),false);
});
test('64 resource observations share one paid monthly cohort and retain every cent, grant and slot',async()=>{
 const f=await setup(),before=new Map(f.h);
 assert.equal((await Promise.all(Array.from({length:64},()=>reservePaidResourceWindow(f.store,f.policy,f.context)))).every(Boolean),true);
 assert.equal([...f.h.keys()].filter(k=>k.startsWith('resource:')).length,1);
 for(const [key,value] of before)assert.equal(f.h.get(key),value);
 const window=allowanceWindow(f.store)!;assert.equal(f.h.get('resource:ctr_resources:0'),window.start+'|'+window.end);
 const after=[...f.h];assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true);assert.deepEqual([...f.h],after);
});
test('lost cohort acknowledgement is retained and recoverable without a second allocation',async()=>{
 const f=await setup();resourceSettings({lost:true});assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false);
 const before=[...f.h];assert.ok(f.h.has('resource:ctr_resources:0'));resourceSettings({lost:false});
 assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true);assert.deepEqual([...f.h],before);
});
test('every consumed slot must reconcile to retained aggregate principal, including other plans',async()=>{
 for(const change of [(h:Map<string,string>)=>h.set('reserved',String(Number(h.get('reserved'))+1)),(h:Map<string,string>)=>h.set('slots:pro_year','1'),(h:Map<string,string>)=>h.set('carried','1'),(h:Map<string,string>)=>h.set('activated:ctr_resources','foreign')]){
  const f=await setup();change(f.h);const before=[...f.h];assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false);assert.deepEqual([...f.h],before);
 }
});
test('foreign, changed, trial or unmarked observations cannot claim a paid cohort',async()=>{
 const f=await setup(),before=[...f.h];
 for(const store of [{...f.store,subscriptionId:'sub_ForeignWindow001'},{...f.store,statsId:'other'},{...f.store,tier:'pro' as const},{...f.store,trialEnds:Date.now()/1000+1000},{...f.store,period:{...f.store.period,start:f.store.period.start+1}},{...f.store,period:{start:f.store.period.start,end:f.store.period.end,renews:true}}]){
  assert.equal(await reservePaidResourceWindow(store,f.policy,f.context),false);assert.deepEqual([...f.h],before);
 }
});
test('annual claims use the anchored monthly index and reject a conflicting recorded window',async()=>{
 const f=await setup('year'),window=allowanceWindow(f.store)!;assert.ok(window.end<f.store.period.end*1000);
 assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true);assert.equal(f.h.get('resource:ctr_resources:0'),window.start+'|'+window.end);
 f.h.set('resource:ctr_resources:0','different');const before=[...f.h];assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false);assert.deepEqual([...f.h],before);
});
test('executable fields, malformed replies and absent real approvals cannot open supplier work',async()=>{
 const f=await setup();let reads=0;const bad={...f.store};Object.defineProperty(bad,'statsId',{get(){reads++;return statsId;}});
 const count=calls.length;assert.equal(await reservePaidResourceWindow(bad,f.policy,f.context),false);assert.equal(reads,0);assert.equal(calls.length,count);
 const end=allowanceWindow(f.store)!.end;
 for(const response of [[],[1],[[true,end]],[[1,String(end)]],[[1,end+1]],[[1,end,1]]]){
  resourceSettings({response});assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false);
 }
 resourceSettings({response:null});const before=calls.length;
 assert.equal(await reserveStoreUpload(f.store,1024,'r2'),false);assert.equal(await reserveUploadControl(f.store),false);assert.equal(calls.length,before);
 assert.equal(f.h.has('resource:ctr_resources:0'),false);
});

test('resource request payload remains below its enforced financial byte ceiling',async()=>{
 const f=await setup();const extra={...f.store,unused:'x'.repeat(2*1024*1024)};let reads=0;
 Object.defineProperty(extra,'unrelated',{get(){reads++;throw Error('unrelated accessor must not execute');}});
 assert.equal(await reservePaidResourceWindow(extra,f.policy,f.context),true);assert.equal(reads,0);
 const command=calls.at(-1)!;assert.equal(command[0][1],RESERVE_PAID_RESOURCE_WINDOW);
 assert.ok(new TextEncoder().encode(JSON.stringify(command)).length<=12288);
});

test('a cohort acknowledgement cannot outlive its window, admission deadline or review month',async(t)=>{
 for(const scenario of ['window','admission','review'] as const){
  t.mock.timers.enable({apis:['Date'],now:new Date(scenario==='review'?'2026-10-31T23:59:59Z':'2026-10-10T12:00:00Z')});
  try{
   const f=await setup('month',scenario==='window'?{durationSeconds:30}:scenario==='admission'?{admissionMs:1000}:{});
   resourceSettings({afterAck:()=>t.mock.timers.tick(scenario==='window'?30000:scenario==='admission'?1001:2000)});
   assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false,scenario);
   assert.ok(f.h.has('resource:ctr_resources:0'),scenario+' retains its committed cohort');
  }finally{t.mock.timers.reset();}
 }
});

test('a backwards clock refuses first and repeated cohort acknowledgements even inside the same valid window',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T12:00:00Z')});
 for(const existing of [false,true]){
  t.mock.timers.setTime(new Date('2026-10-10T12:00:00Z').getTime());
  const f=await setup();
  if(existing)assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true);
  t.mock.timers.tick(1000);
  const before=new Map(f.h),count=calls.length;
  resourceSettings({afterAck:()=>t.mock.timers.setTime(Date.now()-1)});
  assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false);
  assert.ok(Date.now()>f.store.period.start*1000,'clock remains inside the paid window');
  for(const [key,value] of before)assert.equal(f.h.get(key),value,'committed financial fields remain exact');
  const window=allowanceWindow(f.store)!;
  assert.equal(f.h.get('resource:ctr_resources:0'),window.start+'|'+window.end);
  assert.equal(f.h.size,before.size+(existing?0:1),'only the first cohort field may be added');
  assert.equal(calls.length,count+1,'no compensating Redis request');
 }
});

test('resource ACK own-data bounds retain committed cohorts and never grant unknown work',async()=>{
 for(const cycle of ['month','year'] as const){
  let probes=0,getters=0;
  const probe=(value:unknown[])=>new Proxy(value,{getOwnPropertyDescriptor(target,key){
   if(key==='0'||key==='1')probes++;
   return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  // Prove the same descriptor probe sees a normal outer and inner response.
  let f=await setup(cycle),end=allowanceWindow(f.store)!.end;
  resourceSettings({acknowledge:()=>probe([probe([1,end])])});
  assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true);
  assert.equal(probes,3);
  probes=0;
  const cases:[string,(end:number)=>unknown][]=[
   ['nonarray',end=>({0:[1,end],length:1})],
   ['empty',()=>[]],['sparse outer',()=>new Array(1)],
   ['inherited outer',end=>Object.setPrototypeOf(new Array(1),{0:[1,end]})],
   ['outer accessor',end=>Object.defineProperty(new Array(1),'0',{get(){getters++;return[1,end];}})],
   ['oversized outer',end=>probe([[1,end],[1,end]])],
   ['nonarray inner',end=>[{0:1,1:end,length:2}]],
   ['sparse inner',()=>[new Array(2)]],
   ['inherited inner',end=>[Object.setPrototypeOf(new Array(2),{0:1,1:end})]],
   ['flag accessor',end=>[Object.defineProperty([1,end],'0',{get(){getters++;return 1;}})]],
   ['end accessor',end=>[Object.defineProperty([1,end],'1',{get(){getters++;return end;}})]],
   ['oversized inner',end=>[probe([1,end,0])]],
   ['symbol flag',end=>[[Symbol('1'),end]]],
   ['string flag',end=>[['1',end]]],
   ['string end',end=>[[1,String(end)]]],
   ['wrong end',end=>[[1,end+1]]],
   ['throw after commit',()=>{throw Error('synthetic resource acknowledgement lost');}],
  ];
  for(const [name,answer] of cases){
   for(const existing of [false,true]){
    f=await setup(cycle);end=allowanceWindow(f.store)!.end;
    if(existing)assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true);
    const before=new Map(f.h),count=calls.length;
    resourceSettings({acknowledge:()=>answer(end) as unknown[]});
    assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),false,cycle+' '+name);
    assert.equal(calls.length,count+1,'one reservation call, no compensation/readback');
    for(const [key,value]of before)assert.equal(f.h.get(key),value,'retained financial field '+key);
    assert.equal(f.h.get('resource:ctr_resources:0'),allowanceWindow(f.store)!.start+'|'+end);
    assert.equal(f.h.size,before.size+(existing?0:1),'only first cohort may be added');
    assert.equal(getters,0,'no executable ACK field');
    assert.equal(probes,0,'reject oversize before member inspection');
    const committed=[...f.h];
    resourceSettings({acknowledge:null});
    assert.equal(await reservePaidResourceWindow(f.store,f.policy,f.context),true,'valid repeat still recovers same cohort');
    assert.deepEqual([...f.h],committed,'valid repeat allocates nothing twice');
   }
  }
 }
});
