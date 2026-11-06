import { CUSTOMER_TAX_REVIEW_POLICY, OTHER_CUSTOMER_TAX_COMPONENTS, type CustomerTaxInput, type CustomerTaxReview } from "../lib/customer-tax-review";
import { assistantMonthWorst } from "../lib/store-assistant-rules";

export const ASSISTANT_TAX_TEST_NOW = new Date("2026-10-15T12:00:00.000Z");
const evidence = () => ({date:"2026-10-01",source:"SYNTHETIC TEST ONLY",facts:"Complete synthetic isolated add-on scenario, no actual LLC review or jurisdiction exemption certified"});

/** Actual annual-book/entry calculator input; no approval function is mocked. */
export function assistantTaxFixture(messages = 700): CustomerTaxInput {
  const month=assistantMonthWorst(messages);
  const scope={scenario:"store_assistant_month_full",from:"2026-10-01",through:"2026-11-01",months:1 as const};
  const profit=Math.max(0,month.revenueCents-month.totalCents);
  const review:CustomerTaxReview={
    schema:1,policy:CUSTOMER_TAX_REVIEW_POLICY.id,basis:CUSTOMER_TAX_REVIEW_POLICY.basis,
    currency:"USD",accountingCurrency:"BRL",scope:{...scope},revenueCents:month.revenueCents,refundableCents:0,pretaxCeilingCents:profit,
    fx:{from:scope.from,through:scope.through,
      usdToBrl:{numerator:5,denominator:1,evidence:evidence()},brlToUsd:{numerator:1,denominator:5,evidence:evidence()}},
    books:[{year:2026,annualProfitCents:profit*5+1000,evidence:evidence(),exchangeCoverage:evidence(),
      exchanges:[{at:"2026-10-10",brlCents:10_001,evidence:evidence()},{at:"2026-10-20",brlCents:3,evidence:evidence()}]}],
    irpf:evidence(),iof:evidence(),coverage:evidence(),
    components:Object.fromEntries(OTHER_CUSTOMER_TAX_COMPONENTS.map(key=>[key,{status:"ceiling",usdCents:1,evidence:evidence()}])) as CustomerTaxReview["components"],
  };
  return {taxReview:review,taxContext:{...scope}};
}
