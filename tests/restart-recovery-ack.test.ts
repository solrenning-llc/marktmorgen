import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareRestartActivation,type RestartContractActivation} from '@/lib/contract-restart-activation';
import {contractFundingConfiguration} from '@/lib/contract-funding-rules';
import {takeRestartRecovery,restartSubmissionOpenNow,contractFundingBinding,ownedRestartIntentFromAcknowledgement} from '@/lib/contract-funding';
import {contractFixture} from './contract-funding-fixture';
import {reset,calls,retained,clearTransform} from './restart-recovery-ack-world';
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

function recoveryInput(f:ReturnType<typeof setup>){
 const intent=f.activation.armed.intent;
 return {statsId:intent.grant.statsId,sourceSubscriptionId:intent.grant.sourceSubscriptionId!,sourceGrantId:f.frame.sourceGrant,ref:intent.ref,handle:intent.handle,paused:intent.paused};
}
test('actual recovery accepts own bounded flags/evidence and never supplies a live POST permission',async()=>{
 const f=setup(),input=recoveryInput(f),invoke=()=>takeRestartRecovery(input,f.policy,f.context);
 for(const kind of ['absent','held','read','activated'] as const){
  let probes=0;reset(f.frame,f.activation,kind,reply=>new Proxy(reply,{getOwnPropertyDescriptor(target,key){if(key==='0')probes++;return Reflect.getOwnPropertyDescriptor(target,key);}}));
  const result=await invoke();assert.ok(result);assert.equal(result.kind,kind);assert.equal(probes,1,'actual-entry descriptor probe');
  if(result.kind==='read'||result.kind==='activated'){
   assert.equal(result.armed.policyBinding,'');assert.equal(restartSubmissionOpenNow(result.armed,Date.now(),f.policy,f.context),false);
   if(result.kind==='activated')assert.equal(result.subscriptionId,f.activation.subscriptionId);
  }
  assert.equal(retained.get('recoveryReads'),kind==='read'?1:0);
 }
});
test('malformed or lost recovery ACK retains committed source evidence and lifetime allowance',async()=>{
 const f=setup(),input=recoveryInput(f),invoke=()=>takeRestartRecovery(input,f.policy,f.context);
 let getters=0,members=0;
 const bad:((reply:unknown[])=>unknown)[]=[
 ()=>null,()=>[],()=>[null],()=>[[]],()=>[['read']],()=>[['read','{}',0]],()=>[['unknown','{}']],
 ()=>Object.defineProperty(new Array(1),'0',{get(){getters++;return ['held'];}}),
 reply=>{const outer=new Array(1),proto=Object.create(Array.prototype);Object.defineProperty(proto,'0',{value:reply[0]});Object.setPrototypeOf(outer,proto);return outer;},
 reply=>{const inner=(reply[0] as unknown[]).slice();Object.defineProperty(inner,'1',{get(){getters++;return (reply[0] as unknown[])[1];}});return[inner];},
 reply=>{const values=reply[0] as unknown[],inner=new Array(values.length),proto=Object.create(Array.prototype);values.forEach((value,index)=>Object.defineProperty(proto,String(index),{value}));Object.setPrototypeOf(inner,proto);return[inner];},
 ()=>new Proxy([null,null],{getOwnPropertyDescriptor(target,key){if(key==='0'){members++;throw Error('outer too large');}return Reflect.getOwnPropertyDescriptor(target,key);}}),
 ()=>[new Proxy(['read','{}',0],{getOwnPropertyDescriptor(target,key){if(key==='0'){members++;throw Error('inner bad length');}return Reflect.getOwnPropertyDescriptor(target,key);}})],
 reply=>{const inner=(reply[0] as unknown[]).slice();inner[1]='x'.repeat(4097);return[inner];},
 reply=>{const inner=(reply[0] as unknown[]).slice();inner[1]='é'.repeat(3000);return[inner];},
 ()=>{throw Error('lost ACK after allowance commit');},
 ];
 for(const mode of ['read','activated'] as const)for(const transform of bad){
  reset(f.frame,f.activation,mode,transform);const before=[...retained];
  assert.equal(await invoke(),null);assert.equal(calls.length,1,'no retry/readback/compensation');
  for(const[k,v]of before)if(k!=='recoveryReads')assert.deepEqual(retained.get(k),v,k);
  assert.equal(retained.get('recoveryReads'),mode==='read'?1:0);
  assert.ok(retained.has('intent'));assert.equal(getters,0);assert.equal(members,0);
  clearTransform();
  if(mode==='read'){
   assert.equal((await invoke())?.kind,'read');assert.equal((await invoke())?.kind,'read');
   assert.deepEqual(await invoke(),{kind:'held'});assert.equal(retained.get('recoveryReads'),3,'lost first allowance is not replenished');
  }else{
   assert.equal((await invoke())?.kind,'activated');assert.equal(retained.get('recoveryReads'),0,'reconciliation consumes no new provider read');
  }
 }
});
test('activated recovery tails require own bounded canonical data and retain the expiry check',async t=>{
 const f=setup(),input=recoveryInput(f),invoke=()=>takeRestartRecovery(input,f.policy,f.context);
 let getters=0;
 for(const index of [2,3]){
  for(const transform of [
   (reply:unknown[])=>{const inner=(reply[0] as unknown[]).slice();Object.defineProperty(inner,String(index),{get(){getters++;return (reply[0] as unknown[])[index];}});return[inner];},
   (reply:unknown[])=>{const inner=(reply[0] as unknown[]).slice();inner[index]='x'.repeat(index===2?257:385);return[inner];},
   (reply:unknown[])=>{const inner=(reply[0] as unknown[]).slice();inner[index]='é'.repeat(index===2?200:300);return[inner];},
  ]){
   reset(f.frame,f.activation,'activated',transform);assert.equal(await invoke(),null);assert.equal(calls.length,1);assert.ok(retained.has('publication'));
  }
 }
 assert.equal(getters,0);
 reset(f.frame,f.activation,'activated',reply=>{const inner=(reply[0] as unknown[]).slice();const checkpoint=JSON.parse(inner[3] as string);checkpoint.renews=!checkpoint.renews;inner[3]=JSON.stringify(checkpoint);return[inner];});
 assert.equal(await invoke(),null,'publication mismatch is still refused');
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 try{
  reset(f.frame,f.activation,'activated',null,()=>t.mock.timers.setTime(f.activation.periodEndSeconds*1000));
  assert.equal(await invoke(),null,'period expiring while acknowledgement arrives cannot be adopted');
 }finally{t.mock.timers.reset();}
});
