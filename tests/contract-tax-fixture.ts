import { canonicalFinancialSnapshot, type ContractFundingContext, type ContractFundingPolicy } from '../lib/contract-funding-rules';
import { CUSTOMER_COST_CATEGORIES } from '../lib/net-margin-rules';
import type { ContractTaxCoverage, TaxContext } from '../lib/customer-tax-review';
import { contractFixture } from './contract-funding-fixture';
import type {CommercialMarginReview} from '../lib/commercial-margin';
import { txCustomerFixture, syntheticTaxEvidence } from './customer-tax-review-fixture';

/** Synthetic dated coverage, supplied through the exact production contract.
 * No actual future profit, exchange quote, legal fact or bank reserve is proved. */
export function applyContractTaxCoverage<T extends {now:Date;review:CommercialMarginReview;context:ContractFundingContext;policy:ContractFundingPolicy}>(f:T):T {
  const contract: ContractTaxCoverage = {
    reviewId: f.policy.reviewId, termsSnapshot: f.context.termsSnapshot,
    admissionsFrom: f.now.toISOString(), admissionsUntil: f.policy.admissionsUntil,
    liabilitiesThrough: f.policy.liabilitiesThrough, evidence: syntheticTaxEvidence(),
  };
  const from = contract.admissionsFrom.slice(0, 10);
  const through = new Date(Math.ceil(Date.parse(contract.liabilitiesThrough) / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
  for (const [key, old] of Object.entries(f.review.scenarios)) {
    if (!old) throw Error('Missing synthetic full-rights scenario');
    const gross = old.collectedRevenueCents!;
    const costs = CUSTOMER_COST_CATEGORIES.reduce((sum, category) => sum + old.costCeilings[category]!, 0);
    const scope: TaxContext = { scenario: key, months: key.includes('_year_') ? 12 : 1, from, through, contract: { ...contract } };
    const tx = txCustomerFixture(gross, costs, scope);
    tx.costCeilings = { ...old.costCeilings };
    f.review.scenarios[key as keyof typeof f.review.scenarios] = tx;
  }
  f.policy.financialSnapshot = canonicalFinancialSnapshot(f.review)!;
  return f;
}
export const contractTaxFixture = () => contractFixture();
