import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareRestartActivation,type RestartContractActivation} from '@/lib/contract-restart-activation';
import {contractFundingConfiguration} from '@/lib/contract-funding-rules';
import {recordRestartResult,contractFundingBinding,ownedRestartIntentFromAcknowledgement} from '@/lib/contract-funding';
import {contractFixture} from './contract-funding-fixture';
import {reset,calls,retained,clearTransform} from './restart-result-ack-world';
function setup(){
 const f=contractFixture(),config=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(config);
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
 return {...f,activation,frame,deadline:grant.activationUntilSeconds};
}

test('actual result retention accepts only an own numeric committed or retained ACK',async()=>{
 const f=setup(),input={armed:f.activation.armed,subscriptionId:f.activation.subscriptionId};
 const invoke=()=>recordRestartResult(input);
 let probes=0;
 reset(f.frame,input,reply=>new Proxy(reply,{getOwnPropertyDescriptor(target,key){if(key==='0')probes++;return Reflect.getOwnPropertyDescriptor(target,key);}}));
 assert.equal(await invoke(),true);assert.equal(probes,1,'actual entry inspects own data');
 assert.equal(await invoke(),true,'own numeric2 acknowledges already-retained evidence');
 assert.equal(retained.get('commits'),1);
 assert.equal(await recordRestartResult({...input,subscriptionId:'sub_DifferentOwner01'}),false);
 assert.equal(retained.get('commits'),1,'a different observed ID cannot replace retained evidence');
 let getters=0,members=0;
 const bad:((reply:unknown[])=>unknown)[]=[
 ()=>null,()=>[],()=>[1,2],()=>[0],()=>[true],()=>['1'],()=>['2'],()=>[null],()=>[{}],
 ()=>Object.defineProperty(new Array(1),'0',{get(){getters++;return 1;}}),
 ()=>{const outer=new Array(1),proto=Object.create(Array.prototype);Object.defineProperty(proto,'0',{value:1});Object.setPrototypeOf(outer,proto);return outer;},
 ()=>new Proxy([1,2],{getOwnPropertyDescriptor(target,key){if(key==='0'){members++;throw Error('oversized outer member');}return Reflect.getOwnPropertyDescriptor(target,key);}}),
 ()=>new Proxy([1],{getOwnPropertyDescriptor(){throw Error('lost descriptor');}}),
 ()=>{throw Error('lost ACK after evidence commit');},
 ];
 for(const transform of bad){
  reset(f.frame,input,transform);const before=[...retained];
  assert.equal(await invoke(),false,'unknown ACK does not acknowledge retention');
  assert.equal(calls.length,1,'no readback/retry/compensation');
  assert.equal(retained.get('commits'),1);assert.ok(retained.has('observed'));
  for(const[k,v]of before)if(k!=='commits')assert.deepEqual(retained.get(k),v,k);
  assert.equal(getters,0);assert.equal(members,0);
  clearTransform();
  assert.equal(await invoke(),true,'later exact numeric2 may acknowledge existing evidence, never a POST permission');
  assert.equal(retained.get('commits'),1,'no duplicate evidence commit');
  assert.equal(calls.length,2);
 }
});
test('result retention preserves late-evidence admission and rejects a backwards clock before IO',async t=>{
 const f=setup(),input={armed:f.activation.armed,subscriptionId:f.activation.subscriptionId};
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 try{
  reset(f.frame,input);
  t.mock.timers.setTime(input.armed.intent.grant.activationUntilSeconds*1000+1000);
  assert.equal(await recordRestartResult(input),true,'late evidence retained without reopening submission or activation');
  assert.equal(retained.get('commits'),1);
  reset(f.frame,input);
  t.mock.timers.setTime(input.armed.armedAtSeconds*1000-1000);
  assert.equal(await recordRestartResult(input),false);assert.equal(calls.length,0);
 }finally{t.mock.timers.reset();}
});
