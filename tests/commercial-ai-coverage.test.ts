import {planPaymentDisputeFixture, zeroExposureFixture } from './margin-test-fixtures';
import test from "node:test";
import assert from "node:assert/strict";
import { CURRENT_AI_SPEND_POLICY as policy } from "./commercial-ai-approved-policy";
import { commercialMarginReady, commercialPlansMayOpen, CURRENT_COMMERCIAL_MARGIN_REVIEW, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, BASE_PLAN_REVENUE_CEILINGS, type CommercialMarginReview } from "@/lib/commercial-margin";
import { assessCustomerWorstCase } from "@/lib/net-margin-rules";
import { fundedCustomerWithAi, zeroFixedCompanyFixture } from "./margin-test-fixtures";
function review():CommercialMarginReview{return{companyBase:zeroFixedCompanyFixture,planPaymentDisputes:planPaymentDisputeFixture(),priceAndRightsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,taxEvidence:"TEST ONLY",costAndLimitEvidence:"TEST ONLY",allocatedFixedCostsVerified:true, fundedExposure:zeroExposureFixture(),prepaidUsageEnforced:true,scenarios:Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key=>{const gross=BASE_PLAN_REVENUE_CEILINGS[key]??10000;return[key,fundedCustomerWithAi(gross,Math.floor(gross*.65),12,key)];}))};}
test("explicitly funded synthetic review remains calculable without opening actual sales",()=>{
  assert.equal(commercialMarginReady(review()),true);
  assert.equal(CURRENT_COMMERCIAL_MARGIN_REVIEW,null);
  assert.equal(commercialMarginReady(),false);
  assert.equal(commercialPlansMayOpen(true,review()),false);
});
test("paid customer review cannot omit the configured AI cost",()=>{
  const r=review(), scenario=r.scenarios.creator_month_full!;
  scenario.costCeilings.infrastructure!+=scenario.costCeilings.ai!;
  scenario.costCeilings.ai=0;
  assert.equal(assessCustomerWorstCase(scenario).approved,true);
  assert.equal(commercialMarginReady(r),false);
});
test("annual discounted revenue still requires twelve months of AI costs",()=>{
  const r=review(), scenario=r.scenarios.creator_year_full!;
  scenario.costCeilings.ai=11;scenario.costCeilings.infrastructure!+=1;
  assert.equal(assessCustomerWorstCase(scenario).approved,true);
  assert.equal(commercialMarginReady(r),false);
});
test("the reviewed customer base needs funded AI slots for every possible paid tier",()=>{
  const p=policy!;const previous=p.fundedStores.creator;
  try{p.fundedStores.creator=0;assert.equal(commercialMarginReady(review()),false);}
  finally{p.fundedStores.creator=previous;}
});
test("expired AI funding cannot approve commercial release",()=>{
  const p=policy!;const previous=p.month;
  try{p.month="2000-01";assert.equal(commercialMarginReady(review()),false);}
  finally{p.month=previous;}
});
test("zero paid-tier spending cannot pretend that the included AI is funded",()=>{
  const p=policy!;const previous=p.storeMicroUsd.creator;
  try{p.storeMicroUsd.creator=0;assert.equal(commercialMarginReady(review()),false);}
  finally{p.storeMicroUsd.creator=previous;}
});

test("a valid ledger with enough money for one call cannot fund all included calls",()=>{
 // Studio: 40 writing jobs of two calls and 250 answers, at the fixture's one microdollar a call.
 const p=policy!, previous=p.storeMicroUsd.pro;
 try{p.storeMicroUsd.pro=329;assert.equal(commercialMarginReady(review()),false);p.storeMicroUsd.pro=330;assert.equal(commercialMarginReady(review()),true);}
 finally{p.storeMicroUsd.pro=previous;}
});

test('funded non-paying AI allocations cannot be omitted from company exposure',()=>{const p=policy!;for(const [tier,scope] of [['trial','trial'],['setup','setup'],['ended','post_cancellation']] as const){const previous={slots:p.fundedStores[tier],cap:p.storeMicroUsd[tier],company:p.companyMicroUsd};try{p.fundedStores[tier]=1;p.storeMicroUsd[tier]=10000;p.companyMicroUsd+=10000;const r=review();assert.equal(commercialMarginReady(r),false);const item=r.fundedExposure!.cases[scope];item.maximumMonthlyCases=1;item.worstCase!.costCeilings.ai=1;r.fundedExposure!.monthlyBudgetCents=1;assert.equal(commercialMarginReady(r),true);item.worstCase!.costCeilings.ai=0;assert.equal(commercialMarginReady(r),false);}finally{p.fundedStores[tier]=previous.slots;p.storeMicroUsd[tier]=previous.cap;p.companyMicroUsd=previous.company;}}});
