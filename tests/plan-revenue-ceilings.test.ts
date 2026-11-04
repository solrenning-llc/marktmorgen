import {planPaymentDisputeFixture, zeroExposureFixture } from './margin-test-fixtures';
import {fundedCustomerWithAi,zeroFixedCompanyFixture} from './margin-test-fixtures';
import { BASE_PLAN_REVENUE_CEILINGS, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, commercialMarginReady, commercialPlansMayOpen, type CommercialMarginReview, type MarginScenario } from "@/lib/commercial-margin";
import { PUBLISHED_PLAN_PRICES } from "@/lib/plan";
import { assessCustomerWorstCase, type CustomerWorstCase } from "@/lib/net-margin-rules";
import { done, is } from "./check";
const funded = (gross: number,key:MarginScenario='creator_month_full'): CustomerWorstCase => fundedCustomerWithAi(gross,Math.floor(gross*.65),12,key);
const review = (): CommercialMarginReview => ({ companyBase:zeroFixedCompanyFixture, planPaymentDisputes:planPaymentDisputeFixture(),priceAndRightsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, taxEvidence: "TEST ONLY", costAndLimitEvidence: "TEST ONLY", allocatedFixedCostsVerified:true, fundedExposure:zeroExposureFixture(), prepaidUsageEnforced: true, scenarios: Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key => [key, funded(BASE_PLAN_REVENUE_CEILINGS[key] ?? 10000,key)])) });
is("all six subscription ceilings are the price list of 18 October 2026", BASE_PLAN_REVENUE_CEILINGS, { creator_month_full: 6900, creator_year_full: 69000, pro_month_full: 44900, pro_year_full: 449000, scale_month_full: 99900, scale_year_full: 999000 });
is("hypothetical exact-floor model remains assessable", commercialMarginReady(review()), true);
for (const [key, ceiling] of Object.entries(BASE_PLAN_REVENUE_CEILINGS) as [MarginScenario, number][]) {
 const inflated = funded(ceiling + 1,key);
 is(key + " inflated revenue can fool arithmetic alone", assessCustomerWorstCase(inflated).approved, true);
 const bad = review(); bad.scenarios[key] = inflated;
 is(key + " rejects one invented revenue cent", commercialMarginReady(bad), false);
 const futureSales = review(); futureSales.scenarios[key] = funded(ceiling + 1000000,key);
 is(key + " cannot rely on future sales or commissions", commercialMarginReady(futureSales), false);
 const discounted = review(); discounted.scenarios[key] = funded(ceiling - 1,key);
 is(key + " lower actual collections remain assessable", commercialMarginReady(discounted), true);
 const unpaid = review(); unpaid.scenarios[key] = { ...funded(ceiling,key), revenueCollected: false };
 is(key + " still needs collected revenue", commercialMarginReady(unpaid), false);
 const refunded = review(); refunded.scenarios[key] = { ...funded(ceiling,key), refundableRevenueCents: ceiling };
 is(key + " still rejects full refunds after costs", commercialMarginReady(refunded), false);
}
for (const tier of ["creator", "pro", "scale"] as const) {
 is(tier + " annual ceiling is ten months", BASE_PLAN_REVENUE_CEILINGS[(tier + "_year_full") as MarginScenario], PUBLISHED_PLAN_PRICES[tier].month * 10);
 const twelve = review(); twelve.scenarios[(tier + "_year_full") as MarginScenario] = funded(PUBLISHED_PLAN_PRICES[tier].month * 12,(tier+'_year_full') as MarginScenario);
 is(tier + " annual cannot invent two extra monthly payments", commercialMarginReady(twelve), false);
}
is("pricing bounds do not certify actual taxes or costs", commercialMarginReady(), false);
is("hypothetical arithmetic cannot open paid sales", commercialPlansMayOpen(true, review()), false);
done();
