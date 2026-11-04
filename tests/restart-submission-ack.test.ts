import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareRestartActivation,type RestartContractActivation} from '@/lib/contract-restart-activation';
import {contractFundingConfiguration} from '@/lib/contract-funding-rules';
import {armRestartSubmission,contractFundingBinding,ownedRestartIntentFromAcknowledgement} from '@/lib/contract-funding';
import {contractFixture} from './contract-funding-fixture';
import {reset,calls,retained} from './restart-submission-ack-world';
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
test('actual submission barrier never grants provider permission from a non-own ACK',async()=>{
 const f=setup(),input={intent:f.activation.armed.intent,priceId:f.activation.armed.priceId,bodyHash:f.activation.armed.bodyHash};
 const invoke=()=>armRestartSubmission(input,f.policy,f.context);
 let probes=0;reset(f.frame,reply=>new Proxy(reply,{getOwnPropertyDescriptor(target,key){if(key==='0')probes++;return Reflect.getOwnPropertyDescriptor(target,key);}}));
 const armed=await invoke();assert.ok(armed);assert.equal(probes,1,'positive actual-entry probe');
 assert.equal(armed.idempotencyKey,'restart:'+input.intent.grant.id+':'+input.intent.claim);
 assert.equal(await invoke(),null,'known uncertain state never rearms');assert.equal(retained.get('commits'),1);
 let getters=0,members=0;
 const getterOuter=()=>Object.defineProperty(new Array(1),'0',{get(){getters++;throw Error('outer getter');}});
 const bad:((reply:unknown[])=>unknown)[]=[
 ()=>null,()=>[],()=>[null],()=>[[1]],()=>[[1,'{}',0]],()=>[[true,'{}']],()=>[['1','{}']],
 ()=>getterOuter(),
 reply=>[Object.defineProperty([1,''],'1',{get(){getters++;return (reply[0] as unknown[])[1];}})],
 reply=>{const inner=new Array(2),proto=Object.create(Array.prototype);Object.defineProperty(proto,'0',{value:1});Object.defineProperty(proto,'1',{value:(reply[0] as unknown[])[1]});Object.setPrototypeOf(inner,proto);return[inner];},
 reply=>{const outer=new Array(1),proto=Object.create(Array.prototype);Object.defineProperty(proto,'0',{value:reply[0]});Object.setPrototypeOf(outer,proto);return outer;},
 ()=>new Proxy([null,null],{getOwnPropertyDescriptor(t,k){if(k==='0'){members++;throw Error('large outer');}return Reflect.getOwnPropertyDescriptor(t,k);}}),
 ()=>[new Proxy([1,'{}',0],{getOwnPropertyDescriptor(t,k){if(k==='0'||k==='1'){members++;throw Error('large inner');}return Reflect.getOwnPropertyDescriptor(t,k);}})],
 ()=>[[1,'x'.repeat(4097)]],()=>[[1,'é'.repeat(3000)]],()=>{throw Error('lost ACK after commit');},
 ];
 for(const transform of bad){
  reset(f.frame,transform);const before=[...retained];
  assert.equal(await invoke(),null);assert.equal(calls.length,1,'single call, no readback or compensation');
  for(const[k,v]of before)if(k!=='commits')assert.deepEqual(retained.get(k),v,k);
  assert.ok(retained.has('uncertain'));assert.equal(retained.get('commits'),1);assert.equal(getters,0);assert.equal(members,0);
  assert.equal(await invoke(),null,'later attempt cannot recover first permission or rearm');assert.equal(calls.length,2);
  assert.equal(retained.get('commits'),1);
 }
});
test('actual submission barrier retains its deadline and backwards-clock checks after ACK',async t=>{
 for(const kind of ['deadline','backwards'] as const){
  const f=setup(),input={intent:f.activation.armed.intent,priceId:f.activation.armed.priceId,bodyHash:f.activation.armed.bodyHash};
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  try{
   reset(f.frame,null,()=>t.mock.timers.setTime(kind==='deadline'?input.intent.grant.submitUntilSeconds*1000+1:Date.now()-1));
   assert.equal(await armRestartSubmission(input,f.policy,f.context),null);
   assert.equal(calls.length,1);assert.equal(retained.get('commits'),1);assert.ok(retained.has('uncertain'));
  }finally{t.mock.timers.reset();}
 }
});
