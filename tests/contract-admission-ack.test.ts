import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareRestartActivation,type RestartContractActivation} from '@/lib/contract-restart-activation';
import {CONTRACT_KEYS,CONTRACT_FUNDING_RULES,contractFundingConfiguration} from '@/lib/contract-funding-rules';
import {reserveContractFunding,reserveSwitchContractFunding,activateCheckoutContract,claimRestartIntent,contractFundingBinding,ownedRestartIntentFromAcknowledgement} from '@/lib/contract-funding';
import {contractFixture} from './contract-funding-fixture';
import {reset,setTransform,seed,calls,ledger,retained} from './contract-admission-ack-world';
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

const ledgerKey='nl:contract-reserve:v1';
function start(){reset();const f=contractFixture(),config=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(config);seed(config);return{...f,config};}
async function source(){
 const f=start();
 const grant=await reserveContractFunding('admission','creator','month','checkout',f.policy,f.context,'ctr_SourceAck');
 assert.ok(grant);
 // Use the actually issued reservation's start, not a timestamp sampled
 // before asynchronous financial admission that may cross a second boundary.
 const created=grant.submitUntilSeconds-CONTRACT_FUNDING_RULES.submissionSeconds;
 assert.equal(await activateCheckoutContract({statsId:'admission',grantId:'ctr_SourceAck',reviewId:f.policy.reviewId,subscriptionId:'sub_AdmissionSource01',tier:'creator',cycle:'month',createdSeconds:created,trialing:false,periodStartSeconds:created,periodEndSeconds:created+30*86400},f.policy,f.context),true);
 return f;
}
let getters=0,members=0;
const malformed:((reply:unknown[])=>unknown)[]=[
 ()=>null,()=>[],()=>[null],()=>[true],()=>['1'],()=>[2],()=>[1,0],()=>({length:1,0:1}),
 ()=>Object.defineProperty(new Array(1),'0',{get(){getters++;return 1;}}),
 reply=>{const outer=new Array(1),proto=Object.create(Array.prototype);Object.defineProperty(proto,'0',{value:reply[0]});Object.setPrototypeOf(outer,proto);return outer;},
 ()=>new Proxy([1,0],{getOwnPropertyDescriptor(target,key){if(key==='0'){members++;throw Error('oversized ACK');}return Reflect.getOwnPropertyDescriptor(target,key);}}),
 ()=>{throw Error('lost ACK after commit');},
];
test('actual checkout and source-bound switch reservations require own numeric1 for all six profiles',async()=>{
 for(const action of ['checkout','switch'] as const)for(const key of CONTRACT_KEYS){
  const f=action==='checkout'?start():await source(),[tier,cycle]=key.split('_') as ['creator'|'pro'|'scale','month'|'year'];
  const invoke=()=>action==='checkout'?reserveContractFunding('admission',tier,cycle,'checkout',f.policy,f.context,'ctr_FirstAck'):reserveSwitchContractFunding('admission','sub_AdmissionSource01',tier,cycle,f.policy,f.context,'ctr_FirstAck');
  let probes=0;setTransform(reply=>new Proxy(reply,{getOwnPropertyDescriptor(target,property){if(property==='0')probes++;return Reflect.getOwnPropertyDescriptor(target,property);}}));
  const grant=await invoke();assert.ok(grant);assert.equal(grant.key,key);assert.equal(probes,1,'actual-entry descriptor probe');
  assert.equal(await invoke(),null,'already-reserved source does not issue another grant');
 }
});
test('postcommit malformed reservation ACKs never release principal, slots, source or pending ownership',async()=>{
 for(const action of ['checkout','switch'] as const)for(const key of CONTRACT_KEYS)for(const transform of malformed){
  const f=action==='checkout'?start():await source(),[tier,cycle]=key.split('_') as ['creator'|'pro'|'scale','month'|'year'];
  const h=ledger.get(ledgerKey)!,sourceProof=h.get('active:admission'),sourceReceipt=h.get('grant:ctr_SourceAck'),beforeReserved=Number(h.get('reserved')),beforeSlots=Number(h.get('slots:'+key)),beforeCalls=calls.length;
  setTransform(transform);
  const invoke=()=>action==='checkout'?reserveContractFunding('admission',tier,cycle,'checkout',f.policy,f.context,'ctr_UnknownAck'):reserveSwitchContractFunding('admission','sub_AdmissionSource01',tier,cycle,f.policy,f.context,'ctr_UnknownAck');
  assert.equal(await invoke(),null);assert.equal(calls.length,beforeCalls+1,'no retry/readback/compensation');
  assert.equal(h.get('pending:admission'),'ctr_UnknownAck');assert.ok(h.has('grant:ctr_UnknownAck'));
  assert.equal(Number(h.get('reserved')),beforeReserved+f.config.grantCents[key]);assert.equal(Number(h.get('slots:'+key)),beforeSlots-1);
  assert.equal(h.get('active:admission'),sourceProof);assert.equal(h.get('grant:ctr_SourceAck'),sourceReceipt);
  const committed=[...h];setTransform(null);
  assert.equal(await invoke(),null);assert.deepEqual([...h],committed);
  assert.equal(getters,0);assert.equal(members,0);
 }
});
test('actual first-owner claim requires an own outer ACK and preserves a committed lost owner',async()=>{
 const f=setup(),intent=f.activation.armed.intent;
 const input={grant:intent.grant,ref:intent.ref,handle:intent.handle,paused:intent.paused,claim:intent.claim,sourceGrantId:f.frame.sourceGrant};
 const invoke=()=>claimRestartIntent(input,f.policy,f.context);
 let probes=0;reset(reply=>new Proxy(reply,{getOwnPropertyDescriptor(target,key){if(key==='0')probes++;return Reflect.getOwnPropertyDescriptor(target,key);}}),null,f.frame);
 assert.ok(await invoke());assert.equal(probes,1);assert.equal(await invoke(),null);assert.equal(calls.length,2);
 for(const transform of malformed){
  reset(transform,null,f.frame);const before=[...retained];
  assert.equal(await invoke(),null);assert.equal(calls.length,1);assert.ok(retained.has('claim'));
  for(const[k,v]of before)assert.deepEqual(retained.get(k),v,k);
  setTransform(null);assert.equal(await invoke(),null,'first-owner acknowledgement cannot be reconstructed by retry');
  assert.equal(calls.length,2);assert.equal(getters,0);assert.equal(members,0);
 }
});
test('actual admission and claim keep their post-ACK deadlines and backwards-clock checks',async t=>{
 for(const kind of ['reservation','claim'] as const)for(const clock of ['deadline','backwards'] as const){
  const f=kind==='reservation'?start():setup();
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  try{
   if(kind==='reservation'){
    setTransform(null,()=>t.mock.timers.setTime(clock==='deadline'?Date.now()+301000:Date.now()-1));
    assert.equal(await reserveContractFunding('admission','creator','month','checkout',f.policy,f.context,'ctr_LateAck'),null);
    assert.equal(ledger.get(ledgerKey)?.get('pending:admission'),'ctr_LateAck');
   }else{
    const owned=f as ReturnType<typeof setup>,intent=owned.activation.armed.intent;
    reset(null,()=>t.mock.timers.setTime(clock==='deadline'?intent.grant.submitUntilSeconds*1000+1:Date.now()-1),owned.frame);
    assert.equal(await claimRestartIntent({grant:intent.grant,ref:intent.ref,handle:intent.handle,paused:intent.paused,claim:intent.claim,sourceGrantId:owned.frame.sourceGrant},owned.policy,owned.context),null);
    assert.ok(retained.has('claim'));
   }
  }finally{t.mock.timers.reset();}
 }
});
