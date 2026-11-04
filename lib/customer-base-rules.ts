import { assessCustomerWorstCase, MINIMUM_NET_MARGIN_BPS, MINIMUM_NET_PROFIT_CENTS, type CustomerWorstCase } from '@/lib/net-margin-rules';

export const CUSTOMER_BASE_RULES = {
  schema: 2,
  marginBps: MINIMUM_NET_MARGIN_BPS,
  minimumUnitNetCents: MINIMUM_NET_PROFIT_CENTS,
  companyFloor: 'nonnegative-after-whole-fixed-costs-and-funded-exposures',
  basis: 'worst-month-fixed-ceilings-and-every-plan-mix',
  annualNormalization: 'exact-rational-twelve-months',
  fixedTaxShield: 'none-assumed',
  missingCost: 'deny',
} as const;
export type CustomerBaseReview = {
  monthlyFixedCostsCeilingCents: number | null;
  monthlyFixedTaxesCeilingCents: number | null;
  allFixedCostsBounded: boolean;
  allFixedTaxesReviewed: boolean;
  fixedCostsEvidence: string;
  fixedTaxEvidence: string;
  /** Reviewed snapshot, not a live customer counter or a promise of retention. */
  reviewedPayingCustomers: number | null;
};
export type CustomerBaseUnit = { months: 1 | 12; scenario: CustomerWorstCase | null };
export type CustomerBaseAssessment = {
  status: 'unknown' | 'invalid' | 'below_unit_floor' | 'no_finite_base' | 'calculated';
  minimumCustomers: number | null;
  reviewedBaseSufficient: boolean;
};
const stopped = (status: CustomerBaseAssessment['status']): CustomerBaseAssessment => ({status,minimumCustomers:null,reviewedBaseSufficient:false});
const cents = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Every scenario uses all monthly rights at their maximum. For an annual
 * plan the supplied period costs/taxes must cover twelve such worst months.
 * No sales commissions, average usage or expected mix can repair a failing unit.
 * Fixed cost/tax ceilings are worst recognized monthly expenses, not annual
 * cash invoices divided by twelve without a reviewed accrual/reserve policy.
 */
export function assessMinimumCustomerBase(units: CustomerBaseUnit[], fixed: CustomerBaseReview | null): CustomerBaseAssessment {
  if (!fixed || !units.length || fixed.monthlyFixedCostsCeilingCents == null || fixed.monthlyFixedTaxesCeilingCents == null || fixed.reviewedPayingCustomers == null) return stopped('unknown');
  if (!cents(fixed.monthlyFixedCostsCeilingCents) || !cents(fixed.monthlyFixedTaxesCeilingCents) || !cents(fixed.reviewedPayingCustomers)) return stopped('invalid');
  if (fixed.allFixedCostsBounded !== true || fixed.allFixedTaxesReviewed !== true || typeof fixed.fixedCostsEvidence !== 'string' || !fixed.fixedCostsEvidence.trim() || typeof fixed.fixedTaxEvidence !== 'string' || !fixed.fixedTaxEvidence.trim()) return stopped('unknown');
  const fixedCents = BigInt(fixed.monthlyFixedCostsCeilingCents) + BigInt(fixed.monthlyFixedTaxesCeilingCents);
  let minimum = BigInt(1);
  for (const unit of units) {
    if (!unit || (unit.months !== 1 && unit.months !== 12)) return stopped('invalid');
    const result = assessCustomerWorstCase(unit.scenario,unit.months);
    if (!result.approved) return stopped(result.reason === 'below_floor' || result.reason === 'no_revenue' ? 'below_unit_floor' : 'unknown');
    // Headroom in cents*basis-points for the full paid period. Keep months
    // in the denominator until integer ceiling division; never round revenue.
    const headroom = BigInt(result.netCents!) * BigInt(10000) - BigInt(unit.scenario!.collectedRevenueCents!) * BigInt(MINIMUM_NET_MARGIN_BPS);
    if (fixedCents > BigInt(0) && headroom === BigInt(0)) return stopped('no_finite_base');
    if (fixedCents === BigInt(0)) continue;
    const needed = fixedCents * BigInt(10000) * BigInt(unit.months);
    const count = (needed + headroom - BigInt(1)) / headroom;
    if (count > minimum) minimum = count;
  }
  if (minimum > BigInt(Number.MAX_SAFE_INTEGER)) return stopped('invalid');
  return {status:'calculated',minimumCustomers:Number(minimum),reviewedBaseSufficient:BigInt(fixed.reviewedPayingCustomers) >= minimum};
}
