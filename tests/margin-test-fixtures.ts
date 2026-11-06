import { PUBLISHED_PLAN_PRICES, type Tier, type Cycle } from "@/lib/plan";
import { PLAN_PAYMENT_DISPUTE_KEYS, type PlanPaymentDisputeReview } from "@/lib/plan-payment-dispute-cost-rules";
import { EXPOSURE_SCOPES, type FundedExposureReview } from '@/lib/funded-exposure-rules';
import {CUSTOMER_COST_CATEGORIES,type CustomerWorstCase} from '@/lib/net-margin-rules';
import {txCustomerFixture,syntheticTaxContext} from './customer-tax-review-fixture';
import type {TaxContext} from '../lib/customer-tax-review';
/** Synthetic economics only. Construct an exact net target by invoking the
 * real reviewed tax calculator; no duplicated IRPF/IOF formula or legacy floor.
 * This is data for the same production assessor, never an approval override. */
export function fundedCustomerScenario(gross=10000,net=6000,scope:TaxContext|string='creator_month_full'):CustomerWorstCase{
 if(!Number.isSafeInteger(gross)||gross<=0||!Number.isSafeInteger(net)||net<0)throw Error('Invalid synthetic economics');
 const context=typeof scope==='string'?syntheticTaxContext(scope):scope;
 let cost=0;
 for(let attempt=0;attempt<64;attempt++){
  const result=txCustomerFixture(gross,cost,context),actual=gross-cost-result.taxesCeilingCents!;
  if(actual<net)throw Error('Synthetic net target exceeds the reviewed tax budget');
  if(actual===net){result.costCeilings=Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,key==='infrastructure'?cost:0]));return result;}
  cost+=actual-net;
 }
 throw Error('Synthetic reviewed net target did not converge');
}
export const zeroFixedCompanyFixture={monthlyFixedCostsCeilingCents:0,monthlyFixedTaxesCeilingCents:0,allFixedCostsBounded:true,allFixedTaxesReviewed:true,fixedCostsEvidence:'TEST ONLY: zero fixed costs',fixedTaxEvidence:'TEST ONLY: zero fixed taxes',reviewedPayingCustomers:1};

/** Reallocate existing synthetic costs; keep the same total, tax and net result. */
export function fundedCustomerWithAi(gross=10000,net=6000,aiCents=12,scope:TaxContext|string='creator_month_full'):CustomerWorstCase{
 const value=fundedCustomerScenario(gross,net,scope);
 const infrastructure=value.costCeilings.infrastructure!;
 if(infrastructure<aiCents)throw new Error('Synthetic scenario has no room for its AI allocation');
 return {...value,costCeilings:{...value.costCeilings,infrastructure:infrastructure-aiCents,ai:aiCents}};
}

/** No exposure in this synthetic fixture only; never a production cost estimate. */
export function zeroExposureFixture():FundedExposureReview{return{month:new Date().toISOString().slice(0,7),evidence:'TEST ONLY: no acquisition or legacy obligations',admissionLimitsEnforced:true,monthlyBudgetCents:0,cases:Object.fromEntries(EXPOSURE_SCOPES.map(scope=>[scope,{maximumMonthlyCases:0,worstCase:{collectedRevenueCents:0,refundableRevenueCents:0,taxesCeilingCents:0,costCeilings:Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,0])),allCostsBounded:true,allTaxesReviewed:true,revenueCollected:true}}])) as FundedExposureReview['cases']};}

/** Explicit hypothetical waiver, never evidence about a real provider or balance. */
export function planPaymentDisputeFixture():PlanPaymentDisputeReview {
 return Object.fromEntries(PLAN_PAYMENT_DISPUTE_KEYS.map(key=>{
  const [tier,cycle]=key.split("_") as [Tier,Cycle];
  return [key,{maximumPaidPrincipalCents:PUBLISHED_PLAN_PRICES[tier][cycle],maximumTotalFeesCents:0,
   allContractPaymentsBounded:true,liabilityTailReviewed:true,evidence:"TEST ONLY: bounded single paid principal and explicitly waived lost-dispute fees, not real provider evidence"}];
 }));
}
