import {planPaymentDisputeFixture, zeroExposureFixture } from './margin-test-fixtures';
import {fundedCustomerScenario,fundedCustomerWithAi} from './margin-test-fixtures';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMinimumCustomerBase, type CustomerBaseReview, type CustomerBaseUnit } from '../lib/customer-base-rules';
import { type CustomerWorstCase } from '../lib/net-margin-rules';
import { commercialMarginReady, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, BASE_PLAN_REVENUE_CEILINGS, type CommercialMarginReview } from '../lib/commercial-margin';
const scenario = (gross=10000,net=7000,months:1|12=1): CustomerWorstCase => fundedCustomerScenario(gross,net,months===12?'creator_year_full':'creator_month_full');
const fixed=(amount=10000,count=10):CustomerBaseReview=>({monthlyFixedCostsCeilingCents:amount,monthlyFixedTaxesCeilingCents:0,allFixedCostsBounded:true,allFixedTaxesReviewed:true,fixedCostsEvidence:'TEST ONLY',fixedTaxEvidence:'TEST ONLY',reviewedPayingCustomers:count});
const unit=(gross=10000,net=7000,months:1|12=1):CustomerBaseUnit=>({months,scenario:scenario(gross,net,months)});
test('two customers with $70 net cover the full $100 fixed without a global loss',()=>{assert.deepEqual(assessMinimumCustomerBase([unit()],fixed(10000,2)),{status:'calculated',minimumCustomers:2,reviewedBaseSufficient:true});assert.equal(assessMinimumCustomerBase([unit()],fixed(10000,1)).reviewedBaseSufficient,false);});
test('one cent of additional fixed cost requires the next whole customer',()=>{assert.equal(assessMinimumCustomerBase([unit()],fixed(14001,2)).minimumCustomers,3);});
test('annual revenue is divided exactly without rounding monthly cents',()=>{const annual=unit(22000,15401,12);assert.equal(assessMinimumCustomerBase([annual],fixed(18342,15)).minimumCustomers,15);const at14=14*15401/12;assert.ok(at14<18342);});
test('any mix uses the weakest per-customer surplus',()=>{assert.equal(assessMinimumCustomerBase([unit(),unit(10000,6500)],fixed(13001)).minimumCustomers,3);});
test('more customers cannot repair a zero-profit paying unit',()=>{assert.equal(assessMinimumCustomerBase([unit(10000,0)],fixed(1,1000000)).status,'below_unit_floor');});
test('positive profit below sixty percent can fund an explicitly calculated base',()=>{assert.equal(assessMinimumCustomerBase([unit(10000,5999)],fixed(1,1)).minimumCustomers,1);});
test('zero unit net is never repaired by free fixed costs; one net cent funds a finite base',()=>{assert.equal(assessMinimumCustomerBase([unit(10000,0)],fixed(1)).status,'below_unit_floor');assert.equal(assessMinimumCustomerBase([unit(10000,0)],fixed(0)).status,'below_unit_floor');assert.equal(assessMinimumCustomerBase([unit(10000,1)],fixed(10000,10000)).minimumCustomers,10000);});
test('unknown costs and tax review never become zero',()=>{assert.equal(assessMinimumCustomerBase([unit()],null).status,'unknown');assert.equal(assessMinimumCustomerBase([unit()],{...fixed(),monthlyFixedTaxesCeilingCents:null}).status,'unknown');assert.equal(assessMinimumCustomerBase([unit()],{...fixed(),allFixedTaxesReviewed:false}).status,'unknown');assert.equal(assessMinimumCustomerBase([unit()],{...fixed(),fixedCostsEvidence:''}).status,'unknown');});
test('fixed taxes consume surplus without assuming deductibility',()=>{assert.equal(assessMinimumCustomerBase([unit()],{...fixed(10000,20),monthlyFixedTaxesCeilingCents:10000}).minimumCustomers,3);});
test('invalid counts, amounts, periods and unsafe computed bases are rejected',()=>{for(const n of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(assessMinimumCustomerBase([unit()],fixed(n)).status,'invalid');assert.equal(assessMinimumCustomerBase([unit()],{...fixed(),reviewedPayingCustomers:-1}).status,'invalid');assert.equal(assessMinimumCustomerBase([{months:2 as 1,scenario:scenario()}],fixed()).status,'invalid');assert.equal(assessMinimumCustomerBase([unit(10000,1,12)],fixed(Number.MAX_SAFE_INTEGER)).status,'invalid');});
test('no unit or unreviewed unit never produces a minimum',()=>{assert.equal(assessMinimumCustomerBase([],fixed()).status,'unknown');assert.equal(assessMinimumCustomerBase([{months:1,scenario:null}],fixed()).status,'unknown');});
function review():CommercialMarginReview{return{companyBase:fixed(100,100),planPaymentDisputes:planPaymentDisputeFixture(),priceAndRightsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,taxEvidence:'TEST ONLY',costAndLimitEvidence:'TEST ONLY',allocatedFixedCostsVerified:true, fundedExposure:zeroExposureFixture(),prepaidUsageEnforced:true,scenarios:Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key=>{const gross=BASE_PLAN_REVENUE_CEILINGS[key]??10000;return[key,fundedCustomerWithAi(gross,Math.floor(gross*.7),12,key)];}))};}
test('commercial gate includes the minimum base, not just individual profit',()=>{const r=review();assert.equal(commercialMarginReady(r),true);assert.equal(commercialMarginReady({...r,companyBase:null}),false);assert.equal(commercialMarginReady({...r,companyBase:{...r.companyBase!,reviewedPayingCustomers:0}}),false);assert.equal(commercialMarginReady({...r,companyBase:fixed(10000000,100)}),false);assert.equal(commercialMarginReady(),false);});
test('six approved price-cycle cases are required even when others pass',()=>{const r=review();delete r.scenarios.creator_year_full;assert.equal(commercialMarginReady(r),false);});

test('commercial company base includes the entire funded exposure without a tax shield',()=>{const r=review();r.companyBase=fixed(0,1);assert.equal(commercialMarginReady(r),true);const exposure=r.fundedExposure!;exposure.cases.trial.maximumMonthlyCases=3;exposure.cases.trial.worstCase!.costCeilings.ai=1500;exposure.monthlyBudgetCents=4500;assert.equal(commercialMarginReady(r),false);r.companyBase.reviewedPayingCustomers=2;assert.equal(commercialMarginReady(r),true);exposure.monthlyBudgetCents=4499;assert.equal(commercialMarginReady(r),false);});
test('a missing separately funded exposure review keeps paid plans closed',()=>{assert.equal(commercialMarginReady({...review(),fundedExposure:null}),false);});

test('funding acquisition never repairs a paying customer with zero net profit',()=>{const r=review();r.companyBase=fixed(0,10000);r.scenarios.creator_month_full=fundedCustomerWithAi(2200,0);assert.equal(commercialMarginReady(r),false);});

test('minimum-base fixed evidence must be own data and never execute accessors',()=>{
 const inherited=Object.create(fixed());
 assert.equal(assessMinimumCustomerBase([unit()],inherited).status,'unknown');
 for(const key of Object.keys(fixed()) as (keyof CustomerBaseReview)[]){
  let reads=0;
  const supplied=fixed();
  Object.defineProperty(supplied,key,{enumerable:true,get(){reads++;return fixed()[key];}});
  const result=assessMinimumCustomerBase([unit()],supplied);
  assert.equal(result.reviewedBaseSufficient,false,key);
  assert.equal(result.minimumCustomers,null,key);
  assert.equal(reads,0,key);
 }
 assert.deepEqual(assessMinimumCustomerBase([unit()],Object.assign(Object.create(null),fixed(10000,2))),
  {status:'calculated',minimumCustomers:2,reviewedBaseSufficient:true});
});
test('minimum-base unit fields and array slots never execute supplied code',()=>{
 for(const key of ['months','scenario'] as const){
  let reads=0;const supplied=unit();
  Object.defineProperty(supplied,key,{enumerable:true,get(){reads++;return unit()[key];}});
  assert.equal(assessMinimumCustomerBase([supplied],fixed()).reviewedBaseSufficient,false);
  assert.equal(reads,0,key);
 }
 assert.equal(assessMinimumCustomerBase([Object.create(unit())],fixed()).minimumCustomers,null);
 let reads=0;const indexed=[unit()];
 Object.defineProperty(indexed,'0',{enumerable:true,get(){reads++;return unit();}});
 assert.equal(assessMinimumCustomerBase(indexed,fixed()).minimumCustomers,null);
 assert.equal(reads,0);
 const sparse=[unit(),unit()];Reflect.deleteProperty(sparse,'0');
 assert.equal(assessMinimumCustomerBase(sparse,fixed()).minimumCustomers,null);
 const nullData=Object.assign(Object.create(null),unit());
 assert.equal(assessMinimumCustomerBase([nullData],fixed()).minimumCustomers,2);
});
test('a supplied iterator cannot hide the weakest unit or a losing annual contract',()=>{
 let reads=0;const supplied=[unit(),unit(10000,0,12)];
 Object.defineProperty(supplied,Symbol.iterator,{value:function*(){reads++;yield supplied[0];}});
 assert.equal(assessMinimumCustomerBase(supplied,fixed()).minimumCustomers,null);
 assert.equal(reads,0);
 assert.equal(assessMinimumCustomerBase([unit(),unit(10000,0,12)],fixed()).status,'below_unit_floor');
 class UnreviewedUnits extends Array<CustomerBaseUnit>{}
 assert.equal(assessMinimumCustomerBase(new UnreviewedUnits(unit()),fixed()).minimumCustomers,null);
});
test('minimum-base arithmetic never re-reads an assessed scenario through a get trap',()=>{
 let reads=0;const reviewed=scenario();
 const supplied=new Proxy(reviewed,{get(){reads++;throw new Error('unreviewed read');}});
 assert.deepEqual(assessMinimumCustomerBase([{months:1,scenario:supplied}],fixed(10000,2)),
  {status:'calculated',minimumCustomers:2,reviewedBaseSufficient:true});
 assert.equal(reads,0);
 const revoked=Proxy.revocable([unit()],{});revoked.revoke();
 assert.equal(assessMinimumCustomerBase(revoked.proxy,fixed()).minimumCustomers,null);
 const trapped=new Proxy(fixed(),{getOwnPropertyDescriptor(){throw new Error('missing evidence');}});
 assert.equal(assessMinimumCustomerBase([unit()],trapped).minimumCustomers,null);
 for(const bad of [null,{},'units']){
  assert.equal(assessMinimumCustomerBase(bad as unknown as CustomerBaseUnit[],fixed()).minimumCustomers,null);
 }
});

test('minimum-base tax period uses the captured own months without a second supplied read',()=>{
 let monthDescriptors=0,getReads=0;
 const supplied=new Proxy(unit(),{
  get(){getReads++;throw new Error('unreviewed read');},
  getOwnPropertyDescriptor(target,key){
   if(key==='months'){
    monthDescriptors++;
    return {value:monthDescriptors===1?1:12,enumerable:true,configurable:true,writable:true};
   }
   return Reflect.getOwnPropertyDescriptor(target,key);
  },
 });
 assert.deepEqual(assessMinimumCustomerBase([supplied],fixed(10000,2)),
  {status:'calculated',minimumCustomers:2,reviewedBaseSufficient:true});
 assert.equal(monthDescriptors,1);
 assert.equal(getReads,0);
 const mismatch={months:12 as const,scenario:scenario(10000,7000,1)};
 assert.equal(assessMinimumCustomerBase([mismatch],fixed()).minimumCustomers,null);
});
