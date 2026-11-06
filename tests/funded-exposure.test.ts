import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFundedExposure, fundedExposureDetails, EXPOSURE_SCOPES } from '@/lib/funded-exposure-rules';
import { assessCustomerWorstCase } from '@/lib/net-margin-rules';
import { zeroExposureFixture } from './margin-test-fixtures';
function loss(cents:number){const r=zeroExposureFixture();r.cases.trial.maximumMonthlyCases=3;r.cases.trial.worstCase!.costCeilings.ai=cents;r.monthlyBudgetCents=cents*3;return r;}
test('zero revenue is not a profitable customer but its whole known cost can be financed',()=>{const r=loss(100);assert.equal(assessCustomerWorstCase(r.cases.trial.worstCase).approved,false);assert.deepEqual(assessFundedExposure(r),{approved:true,reason:'approved',requiredBudgetCents:300,monthlyBudgetCents:300});});
test('one cent under the simultaneous exposure refuses approval',()=>{const r=loss(100);r.monthlyBudgetCents=299;assert.equal(assessFundedExposure(r).reason,'underfunded');});
test('every acquisition, refund, retention and legacy obligation adds to the same ceiling',()=>{const r=zeroExposureFixture();for(const scope of EXPOSURE_SCOPES){r.cases[scope].maximumMonthlyCases=2;r.cases[scope].worstCase!.costCeilings.other=100;r.cases[scope].worstCase!.taxesCeilingCents=7;}r.monthlyBudgetCents=1712;assert.equal(assessFundedExposure(r).requiredBudgetCents,1712);assert.equal(assessFundedExposure(r).approved,true);r.monthlyBudgetCents!--;assert.equal(assessFundedExposure(r).approved,false);});
test('full refunds retain payment fees and taxes instead of treating returned revenue as income',()=>{const r=zeroExposureFixture();const unit=r.cases.full_refund;unit.maximumMonthlyCases=2;unit.worstCase!.collectedRevenueCents=22000;unit.worstCase!.refundableRevenueCents=22000;unit.worstCase!.costCeilings.paymentAndFx=700;unit.worstCase!.taxesCeilingCents=5;r.monthlyBudgetCents=1410;assert.equal(assessFundedExposure(r).requiredBudgetCents,1410);});
test('unknown occurrence caps, costs, taxes or enforcement never become zero',()=>{for(const edit of [(r:ReturnType<typeof loss>)=>{r.cases.trial.maximumMonthlyCases=null;},(r:ReturnType<typeof loss>)=>{r.cases.trial.worstCase!.costCeilings.ai=null;},(r:ReturnType<typeof loss>)=>{r.cases.trial.worstCase!.allTaxesReviewed=false;},(r:ReturnType<typeof loss>)=>{r.admissionLimitsEnforced=false;}]){const r=loss(100);edit(r);assert.equal(assessFundedExposure(r).approved,false);}});
test('expired evidence and expected future money cannot fund current obligations',()=>{const r=loss(100);r.month='2000-01';assert.equal(assessFundedExposure(r).approved,false);r.month=new Date().toISOString().slice(0,7);r.cases.trial.worstCase!.revenueCollected=false;assert.equal(assessFundedExposure(r).approved,false);});
test('malformed caps and unsafe simultaneous totals are rejected',()=>{for(const count of [-1,0.5,Infinity,NaN]){const r=loss(100);r.cases.trial.maximumMonthlyCases=count;assert.equal(assessFundedExposure(r).reason,'invalid');}const r=loss(100);r.cases.trial.maximumMonthlyCases=Number.MAX_SAFE_INTEGER;assert.equal(assessFundedExposure(r).reason,'invalid');});
test('review accessors are not executed as financial evidence',()=>{const r=loss(100);let reads=0;Object.defineProperty(r.cases.trial,'maximumMonthlyCases',{get(){reads++;return 0;}});assert.equal(assessFundedExposure(r).approved,false);assert.equal(reads,0);});

test('platform waitlist exposure includes all known per-case costs without anticipated revenue',()=>{
 const r=zeroExposureFixture(), item=r.cases.platform_waitlist;
 item.maximumMonthlyCases=3;
 Object.assign(item.worstCase!.costCeilings,{infrastructure:4,storageDeliveryVideo:6,email:10,supportAndOperations:5});
 item.worstCase!.taxesCeilingCents=2;
 r.monthlyBudgetCents=81;
 assert.equal(assessFundedExposure(r).requiredBudgetCents,81);
 assert.equal(assessFundedExposure(r).approved,true);
 r.monthlyBudgetCents=80;
 assert.equal(assessFundedExposure(r).reason,'underfunded');
 item.worstCase!.collectedRevenueCents=10000;
 r.monthlyBudgetCents=81;
 assert.equal(assessFundedExposure(r).approved,false);
});
test('an older review cannot silently omit platform waitlist or inherit invented zero costs',()=>{
 const r=zeroExposureFixture();
 Reflect.deleteProperty(r.cases,'platform_waitlist');
 assert.equal(assessFundedExposure(r).reason,'unknown');
 const complete=zeroExposureFixture();
 const inherited=Object.create({platform_waitlist:complete.cases.platform_waitlist});
 for(const scope of EXPOSURE_SCOPES)if(scope!=='platform_waitlist')inherited[scope]=complete.cases[scope];
 complete.cases=inherited;
 assert.equal(assessFundedExposure(complete).approved,false);
});
test('unknown waitlist operations, occurrence caps and taxes never become free',()=>{
 for(const edit of [
  (r:ReturnType<typeof zeroExposureFixture>)=>{r.cases.platform_waitlist.maximumMonthlyCases=null;},
  (r:ReturnType<typeof zeroExposureFixture>)=>{r.cases.platform_waitlist.worstCase!.costCeilings.email=null;},
  (r:ReturnType<typeof zeroExposureFixture>)=>{r.cases.platform_waitlist.worstCase!.taxesCeilingCents=null;},
 ]){const r=zeroExposureFixture();edit(r);assert.equal(assessFundedExposure(r).approved,false);}
});

test('both exposure readers refuse any raw fiscal presence before constructing legacy snapshots',()=>{
 let reads=0;
 for(const field of ['taxReview','taxContext'])for(const kind of ['enumerable','hidden','getter','inherited','proxy']){
  const r=loss(100),row=r.cases.trial.worstCase!;
  assert.equal(assessFundedExposure(r).approved,true);assert.ok(fundedExposureDetails(r));
  if(kind==='inherited')Object.setPrototypeOf(row,{[field]:null});
  else Object.defineProperty(row,field,kind==='getter'?{enumerable:false,get(){reads++;throw Error('must not execute');}}:{value:null,enumerable:kind==='enumerable',configurable:true});
  if(kind==='proxy')r.cases.trial.worstCase=new Proxy(row,{has(){return false;}});
  assert.equal(assessFundedExposure(r).approved,false);assert.equal(fundedExposureDetails(r),null);
 }
 assert.equal(reads,0);
});

test('exposure details checks and copies the same once-captured raw',()=>{
 const r=loss(100),item=r.cases.trial,legacy=item.worstCase!,tx={...legacy};
 Object.defineProperty(tx,'taxReview',{value:null,enumerable:false});let reads=0;
 r.cases.trial=new Proxy(item,{getOwnPropertyDescriptor(target,key){const d=Reflect.getOwnPropertyDescriptor(target,key);return key==='worstCase'&&d?{...d,value:++reads%2?legacy:tx}:d;}});
 const actual=fundedExposureDetails(r);assert.ok(actual);assert.equal(reads,1);
 assert.equal(actual.snapshot,fundedExposureDetails(loss(100))!.snapshot);
});

test('zero counts still require every known loss cost and tax, and incoming-tax liabilities are not erased by zero revenue',()=>{
 for(const count of [0,2])for(const revenue of [0,1000]){
  const r=zeroExposureFixture(),item=r.cases.trial;item.maximumMonthlyCases=count;
  item.worstCase!.collectedRevenueCents=revenue;item.worstCase!.refundableRevenueCents=revenue;
  item.worstCase!.taxesCeilingCents=17;item.worstCase!.costCeilings.other=23;r.monthlyBudgetCents=count*40;
  assert.equal(assessFundedExposure(r).requiredBudgetCents,count*40);
  item.worstCase!.taxesCeilingCents=null;assert.equal(assessFundedExposure(r).approved,false);assert.equal(fundedExposureDetails(r),null);
  item.worstCase!.taxesCeilingCents=17;item.worstCase!.costCeilings.other=null;assert.equal(assessFundedExposure(r).approved,false);
 }
});

test('unmigrated exposure cannot use residual collected income to erase unknown TX liability',()=>{
 for(const count of [0,1])for(const scope of ['trial','full_refund','legacy_credits'] as const){
  const r=zeroExposureFixture(),item=r.cases[scope];item.maximumMonthlyCases=count;
  item.worstCase!.collectedRevenueCents=1000;item.worstCase!.refundableRevenueCents=999;
  item.worstCase!.taxesCeilingCents=0;item.worstCase!.costCeilings.other=0;
  r.monthlyBudgetCents=0;
  assert.equal(assessFundedExposure(r).approved,false,'a legacy flag is not scoped TX evidence');
  assert.equal(assessFundedExposure(r).reason,'unknown');assert.equal(fundedExposureDetails(r),null);
 }
});
