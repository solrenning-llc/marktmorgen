import test from 'node:test';
import assert from 'node:assert/strict';
import {commercialMarginReady,commercialPlansMayOpen,CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,REQUIRED_MARGIN_SCENARIOS,BASE_PLAN_REVENUE_CEILINGS,type CommercialMarginReview} from '@/lib/commercial-margin';
import {CURRENT_EXPOSURE_BUDGET_POLICY} from '@/lib/exposure-budget-policy';
import {COMMISSION_LIVE} from '@/lib/plan';
import {SHARE_PROVED_IN_TEST_MODE} from '@/lib/platform-share';
import {planPaymentDisputeFixture,fundedCustomerWithAi,zeroFixedCompanyFixture,zeroExposureFixture} from './margin-test-fixtures';
test('a passing synthetic financial review and enabled commission cannot open sales without a reserve',()=>{const review:CommercialMarginReview={companyBase:zeroFixedCompanyFixture,fundedExposure:zeroExposureFixture(),planPaymentDisputes:planPaymentDisputeFixture(),priceAndRightsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,taxEvidence:'TEST ONLY',costAndLimitEvidence:'TEST ONLY',allocatedFixedCostsVerified:true,prepaidUsageEnforced:true,scenarios:Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key=>{const gross=BASE_PLAN_REVENUE_CEILINGS[key]??10000;return [key,fundedCustomerWithAi(gross,Math.floor(gross*.65),12,key)];}))};assert.equal(COMMISSION_LIVE,true);assert.equal(SHARE_PROVED_IN_TEST_MODE,true);assert.equal(commercialMarginReady(review),true);assert.equal(CURRENT_EXPOSURE_BUDGET_POLICY,null);assert.equal(commercialPlansMayOpen(true,review),false);});
