import {test} from "node:test";
import assert from "node:assert/strict";
import {commercialMarginReady,CURRENT_COMMERCIAL_TERMS,CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,REQUIRED_MARGIN_SCENARIOS,BASE_PLAN_REVENUE_CEILINGS,type CommercialMarginReview} from "@/lib/commercial-margin";
import {CURRENT_LLC_FIXED_COST_CEILINGS as lines,LLC_FIXED_COST_ALLOCATION,LLC_FIXED_COST_IDS} from "./llc-retention-approved-policy";
import {planPaymentDisputeFixture,zeroExposureFixture,fundedCustomerWithAi} from "./margin-test-fixtures";
const review=(fixed=100):CommercialMarginReview=>({
 companyBase:{monthlyFixedCostsCeilingCents:fixed,monthlyFixedTaxesCeilingCents:0,allFixedCostsBounded:true,allFixedTaxesReviewed:true,fixedCostsEvidence:"TEST ONLY: complete full LLC ceilings",fixedTaxEvidence:"TEST ONLY: explicit hypothetical taxes",reviewedPayingCustomers:100},
 planPaymentDisputes:planPaymentDisputeFixture(),priceAndRightsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,taxEvidence:"TEST ONLY",costAndLimitEvidence:"TEST ONLY",
 allocatedFixedCostsVerified:true,fundedExposure:zeroExposureFixture(),prepaidUsageEnforced:true,
 scenarios:Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key=>{const gross=BASE_PLAN_REVENUE_CEILINGS[key]??10000;return[key,fundedCustomerWithAi(gross,Math.floor(gross*.7),12,key)];})),
});
test("actual commercial gate includes the complete full LLC inventory before exposure",()=>{
 assert.equal(commercialMarginReady(review(100)),true,"known hypothetical nonzero retention is fully included");
 assert.equal(commercialMarginReady(review(99)),false,"aggregate flags cannot hide one cent of omitted overhead");
 assert.equal(commercialMarginReady(review(101)),true);
 assert.equal(commercialMarginReady(),false,"actual commercial review stays absent");
 assert.equal(LLC_FIXED_COST_ALLOCATION.marktmorgenBps,10000);
 assert.equal(LLC_FIXED_COST_ALLOCATION.hazelsongBps,0);
 assert.ok(LLC_FIXED_COST_IDS.includes("deployment-artifact-retention"));
 assert.equal(CURRENT_COMMERCIAL_TERMS.llcFixedCosts.ceilings,lines);
 assert.deepEqual(CURRENT_COMMERCIAL_TERMS.llcFixedCosts.required,LLC_FIXED_COST_IDS);
});
test("unknown monthly/annual ceilings, reserves or evidence block even a generous aggregate",()=>{
 const row=lines.find(x=>x.id==="deployment-artifact-retention")!;
 const original={...row};
 try{
  for(const patch of [{fullMonthlyUsdCents:null},{fullAnnualUsdCents:null},{reserveReviewed:false},{evidence:""}]){
   Object.assign(row,original,patch);
   assert.equal(commercialMarginReady(review(10000)),false);
  }
 }finally{Object.assign(row,original);}
 assert.equal(commercialMarginReady(review()),true);
});
test("omitting the retention line cannot pass the actual commercial gate",()=>{
 const index=lines.findIndex(x=>x.id==="deployment-artifact-retention");
 const [removed]=lines.splice(index,1);
 try{assert.equal(commercialMarginReady(review(10000)),false);}
 finally{lines.splice(index,0,removed);}
 assert.equal(commercialMarginReady(review()),true);
});
test("exposure money cannot replace missing fixed overhead and old inventory snapshots fail",()=>{
 const insufficient=review(99);
 insufficient.fundedExposure!.monthlyBudgetCents=100;
 assert.equal(commercialMarginReady(insufficient),false);
 const old=JSON.parse(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT);
 delete old.llcFixedCosts;
 assert.equal(commercialMarginReady({...review(),priceAndRightsSnapshot:JSON.stringify(old)}),false);
 const changed=JSON.parse(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT);
 changed.llcFixedCosts.ceilings.find((x:{id:string})=>x.id==="deployment-artifact-retention").fullAnnualUsdCents+=1;
 assert.equal(commercialMarginReady({...review(),priceAndRightsSnapshot:JSON.stringify(changed)}),false);
 assert.equal(commercialMarginReady(review()),true);
});

test("the full annual ceiling must fit too, including a single unpaid cent",()=>{
 const row=lines.find(x=>x.id==="deployment-artifact-retention")!;
 const original={...row};
 try{
  row.fullAnnualUsdCents=1201;
  assert.equal(commercialMarginReady(review(100)),false,"twelve monthly budgets cover only1200");
  assert.equal(commercialMarginReady(review(101)),true,"both complete ceilings fit");
  row.fullMonthlyUsdCents=0;
  assert.equal(commercialMarginReady(review(0)),false,"known annual liability is not monthly zero");
  assert.equal(commercialMarginReady(review(100)),false,"annual comparison never rounds away a cent");
  assert.equal(commercialMarginReady(review(101)),true);
  const taxBudget=review(1);
  taxBudget.companyBase!.monthlyFixedTaxesCeilingCents=100;
  assert.equal(commercialMarginReady(taxBudget),true,"full fixed costs and taxes are checked once");
  row.fullAnnualUsdCents=Number.MAX_SAFE_INTEGER;
  assert.equal(commercialMarginReady(review(10000)),false,"safe annual amount is compared without overflow");
 }finally{Object.assign(row,original);}
 assert.equal(commercialMarginReady(review()),true);
});
