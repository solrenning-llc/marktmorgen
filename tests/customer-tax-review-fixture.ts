import { CUSTOMER_COST_CATEGORIES, type CustomerWorstCase } from '../lib/net-margin-rules';
import { CUSTOMER_TAX_REVIEW_POLICY, OTHER_CUSTOMER_TAX_COMPONENTS, customerTaxCeiling, type CustomerTaxReview, type TaxContext } from '../lib/customer-tax-review';
export const syntheticTaxEvidence = () => ({ date: '2026-10-01', source: 'TEST ONLY: synthetic official-source reference', facts: 'TEST ONLY: isolated full-rights scenario; no actual LLC facts or tax exemption established' });
export function syntheticTaxContext(scenario='creator_month_full',months?:1|12):TaxContext {
  const interval=months??(scenario.includes('_year_')?12:1);
  return {scenario,from:'2026-10-01',through:interval===12?'2027-10-01':'2026-11-01',months:interval};
}
export function txCustomerFixture(gross = 10_000, cost = 0, supplied?: TaxContext, refundable = 0): CustomerWorstCase {
  const scope: TaxContext = supplied ?? syntheticTaxContext();
  const first = Number(scope.from.slice(0, 4)), last = new Date(Date.parse(scope.through) - 1).getUTCFullYear();
  const pretaxCeiling=Math.max(0,gross-refundable-cost);
  let remaining = pretaxCeiling * 5;
  const review: CustomerTaxReview = {
    schema: 1, policy: CUSTOMER_TAX_REVIEW_POLICY.id, basis: CUSTOMER_TAX_REVIEW_POLICY.basis,
    currency: 'USD', accountingCurrency: 'BRL',
    scope: { ...scope }, revenueCents: gross, refundableCents: refundable, pretaxCeilingCents: pretaxCeiling,
    fx: { from: scope.from, through: scope.through,
      usdToBrl: { numerator: 5, denominator: 1, evidence: syntheticTaxEvidence() },
      brlToUsd: { numerator: 1, denominator: 5, evidence: syntheticTaxEvidence() } },
    books: Array.from({ length: last - first + 1 }, (_, i) => {
      const year = first + i, amount = i === last - first ? remaining : Math.floor(remaining / 2);
      remaining -= amount;
      return { year, annualProfitCents: amount, evidence: syntheticTaxEvidence(),
        exchangeCoverage: { ...syntheticTaxEvidence(), facts: 'TEST ONLY: complete incoming operations for this isolated scoped book, including an explicitly empty ledger' }, exchanges: [{
        at: i === 0 ? scope.from : `${year}-01-01`, brlCents: amount, evidence: syntheticTaxEvidence(),
      }] };
    }),
    irpf: syntheticTaxEvidence(), iof: syntheticTaxEvidence(), coverage: syntheticTaxEvidence(),
    components: Object.fromEntries(OTHER_CUSTOMER_TAX_COMPONENTS.map(key => [key, {
      status: 'not-applicable', usdCents: 0, evidence: syntheticTaxEvidence(),
    }])) as CustomerTaxReview['components'],
  };
  const tax = customerTaxCeiling(review, scope, { revenueCents: gross, refundableCents: refundable, pretaxCents: BigInt(gross - refundable - cost) });
  if (tax === null) throw Error('Invalid synthetic TX ceiling');
  return { collectedRevenueCents: gross, refundableRevenueCents: refundable, taxesCeilingCents: tax,
    costCeilings: Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(k => [k, k === 'other' ? cost : 0])),
    allCostsBounded: true, allTaxesReviewed: true, revenueCollected: true, taxReview: review, taxContext: { ...scope } };
}
