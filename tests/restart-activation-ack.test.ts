import assert from 'node:assert/strict';
import test from 'node:test';
import {activateRestartContract,prepareRestartActivation,type RestartContractActivation} from '@/lib/contract-restart-activation';
import {contractFundingConfiguration} from '@/lib/contract-funding-rules';
import {contractFundingBinding,ownedRestartIntentFromAcknowledgement} from '@/lib/contract-funding';
import {contractFixture} from './contract-funding-fixture';
import {reset,calls,retained} from './restart-activation-ack-world';

function setup(){
 reset();const f=contractFixture(),config=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(config);
 const now=Math.floor(Date.now()/1000),charge=config.grantCents.creator_month,sourceGrantId='ctr_AckRestartSource';
 const grant={sourceSubscriptionId:'sub_AckRestartSource01',action:'restart' as const,id:'ctr_AckRestartNew',reviewId:f.policy.reviewId,statsId:'restart_ack_store',key:'creator_month' as const,reservedCents:charge,submitUntilSeconds:now+298,checkoutExpiresAtSeconds:now+3600,activationUntilSeconds:now+86400,liabilitiesThrough:f.policy.liabilitiesThrough};
 const sourceStart=now-10000,sourceFinish=now-10,claimed=now-2;
 const paused=JSON.stringify({subscription:grant.sourceSubscriptionId,customer:'cus_AckRestartOwner01',paymentMethod:'pm_AckRestartCard01',tier:'creator',from:sourceFinish,until:claimed,told:0,funding:{version:1,grantId:sourceGrantId}});
 const input={grant,ref:'restart-ack@example.invalid',handle:'restart-ack',paused,claim:'claim_AckRestart',sourceGrantId};
 const sourceBinding=[sourceGrantId,grant.sourceSubscriptionId,grant.key,sourceStart,'paid',sourceStart,sourceFinish].join('|');
 const sourceReceipt=[grant.reviewId,grant.statsId,grant.key,'checkout',charge,sourceStart,sourceFinish,sourceFinish,Date.parse(grant.liabilitiesThrough)].join('|');
 const restartReceipt=[grant.reviewId,grant.statsId,grant.key,'restart',charge,grant.submitUntilSeconds,grant.checkoutExpiresAtSeconds,grant.activationUntilSeconds,Date.parse(grant.liabilitiesThrough),sourceGrantId].join('|');
 const frame={version:1,grant:grant.id,review:grant.reviewId,statsId:grant.statsId,sourceSubscription:grant.sourceSubscriptionId,sourceGrant:sourceGrantId,ref:input.ref,handle:input.handle,paused,claim:input.claim,created:claimed,deadline:grant.submitUntilSeconds,sourceBinding,sourceReceipt,restartReceipt,reservedCents:charge*2,carriedCents:0,annual:sourceStart};
 const intent=ownedRestartIntentFromAcknowledgement(input,claimed,{cashLimitCents:config.cashLimitCents,carryForwardCents:config.carryForwardCents},[1,JSON.stringify(frame)]);assert.ok(intent,'actual financial ownership decoder');
 const activation:RestartContractActivation={armed:{intent,priceId:'price_AckRestart01',bodyHash:'a'.repeat(64),idempotencyKey:'restart:'+grant.id+':'+intent.claim,armedAtSeconds:now-1,policyBinding:contractFundingBinding(config)},subscriptionId:'sub_AckRestartNew01',createdSeconds:now-1,periodStartSeconds:now-1,periodEndSeconds:now+30*86400,renews:true,shared:false};
 assert.ok(prepareRestartActivation(activation,f.policy,f.context),'actual preparation with real synthetic financial config');
 return {...f,activation,deadline:grant.activationUntilSeconds};
}
test('actual restart activation requires own bounded acknowledgement after a modeled commit',async()=>{
 const f=setup(),invoke=()=>activateRestartContract(f.activation,f.policy,f.context);
 let probes=0;
 reset(reply=>new Proxy(reply,{getOwnPropertyDescriptor(target,key){if(key==='0')probes++;return Reflect.getOwnPropertyDescriptor(target,key);}}));
 assert.equal(await invoke(),true);assert.equal(probes,1,'positive probe proves actual boundary reached');
 assert.equal(await invoke(),true,'same committed binding returns exact current period');
 const snapshot=[...retained];assert.equal(calls.length,2);
 let getters=0,members=0;
 const outerGetter=Object.defineProperty(new Array(1),'0',{get(){getters++;return [1,f.deadline];}});
 const innerGetter=Object.defineProperty([1,0],'1',{get(){getters++;return f.deadline;}});
 const inherited=new Array(2),proto=Object.create(Array.prototype);
 Object.defineProperty(proto,'0',{value:1});Object.defineProperty(proto,'1',{value:f.deadline});Object.setPrototypeOf(inherited,proto);
 const outerInherited=new Array(1),outerProto=Object.create(Array.prototype);Object.defineProperty(outerProto,'0',{value:[1,f.deadline]});Object.setPrototypeOf(outerInherited,outerProto);
 const oversized=(value:unknown[])=>new Proxy(value,{getOwnPropertyDescriptor(target,key){if(key==='0'||key==='1'){members++;throw Error('oversized member read');}return Reflect.getOwnPropertyDescriptor(target,key);}});
 const largeOuter=oversized([null,null]),largeInner=oversized([1,f.deadline,0]);
 assert.throws(()=>Object.getOwnPropertyDescriptor(largeOuter,'0'));assert.equal(members,1);members=0;
 const transforms:((reply:unknown[])=>unknown)[]=[
 ()=>outerGetter,()=>[innerGetter],()=>[inherited],()=>outerInherited,()=>largeOuter,()=>[largeInner],
 ()=>null,()=>[],()=>[null],()=>[[1]],()=>[[1,f.deadline,0]],()=>[['1',f.deadline]],
 ()=>[[true,f.deadline]],()=>[[1,String(f.deadline)]],()=>[[1,f.deadline-1]],()=>{throw Error('lost response after commit');},
 ];
 for(const first of [true,false]){
  for(const transform of transforms){
   reset(transform);
   if(!first){reset();assert.equal(await invoke(),true);}
   // Preserve a known prior activation for repeated cases; only change the response.
   // reset would lose that state, so reinstall the transform after copying evidence.
   const prior=[...retained];reset(transform);for(const [k,v]of prior)retained.set(k,v);
   const callCount:number=calls.length;
   assert.equal(await invoke(),false);
   assert.equal(calls.length,callCount+1,'one call, no compensation or readback');
   assert.equal(retained.get('source'),'retained');assert.equal(retained.get('cash'),100);
   assert.equal(retained.get('pause'),'retained');assert.equal(retained.get('due'),1);assert.equal(retained.get('annual'),1);
   assert.ok(retained.has('activation')&&retained.has('checkpoint'),'modeled postcommit evidence retained');
   assert.equal(getters,0);assert.equal(members,0);
  }
 }
 assert.ok(snapshot.length>5);
});
test('actual restart activation retains clock and paid-period checks after a valid ACK',async t=>{
 for(const kind of ['backwards','period'] as const){
  const f=setup();t.mock.timers.enable({apis:['Date'],now:Date.now()});
  try{
   reset(null,()=>kind==='backwards'?t.mock.timers.setTime(Date.now()-1):t.mock.timers.setTime(f.activation.periodEndSeconds*1000));
   assert.equal(await activateRestartContract(f.activation,f.policy,f.context),false);
   assert.equal(calls.length,1);assert.equal(retained.get('cash'),100);assert.ok(retained.has('activation'));
  }finally{t.mock.timers.reset();}
 }
});
