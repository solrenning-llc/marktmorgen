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
/** Financial evidence is own data, never inherited defaults or executable reads. */
function ownReviewData(record: unknown, key: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const field = Object.getOwnPropertyDescriptor(record, key);
  return field && Object.hasOwn(field, 'value') ? field.value : undefined;
}

/** Every scenario uses all monthly rights at their maximum. For an annual
 * plan the supplied period costs/taxes must cover twelve such worst months.
 * No sales commissions, average usage or expected mix can repair a failing unit.
 * Fixed cost/tax ceilings are worst recognized monthly expenses, not annual
 * cash invoices divided by twelve without a reviewed accrual/reserve policy.
 */
export function assessMinimumCustomerBase(units: CustomerBaseUnit[], fixed: CustomerBaseReview | null): CustomerBaseAssessment {
  try {
    if (!Array.isArray(units) || Object.getPrototypeOf(units) !== Array.prototype) return stopped('unknown');
    const length = ownReviewData(units, 'length');
    if (!cents(length) || length === 0 || Reflect.ownKeys(units).length !== length + 1) return stopped('unknown');
    if (!fixed || typeof fixed !== 'object' || Array.isArray(fixed)) return stopped('unknown');
    // Read every fixed-cost field once before validation and exact arithmetic.
    const fixedCosts = ownReviewData(fixed, 'monthlyFixedCostsCeilingCents');
    const fixedTaxes = ownReviewData(fixed, 'monthlyFixedTaxesCeilingCents');
    const payingCustomers = ownReviewData(fixed, 'reviewedPayingCustomers');
    const costsBounded = ownReviewData(fixed, 'allFixedCostsBounded');
    const taxesReviewed = ownReviewData(fixed, 'allFixedTaxesReviewed');
    const costsEvidence = ownReviewData(fixed, 'fixedCostsEvidence');
    const taxEvidence = ownReviewData(fixed, 'fixedTaxEvidence');
    if (fixedCosts == null || fixedTaxes == null || payingCustomers == null) return stopped('unknown');
    if (!cents(fixedCosts) || !cents(fixedTaxes) || !cents(payingCustomers)) return stopped('invalid');
    if (costsBounded !== true || taxesReviewed !== true || typeof costsEvidence !== 'string' || !costsEvidence.trim() || typeof taxEvidence !== 'string' || !taxEvidence.trim()) return stopped('unknown');
    const fixedCents = BigInt(fixedCosts) + BigInt(fixedTaxes);
    let minimum = BigInt(1);
    // Descriptors bind the actual dense array. A supplied iterator cannot omit
    // a weaker unit, and an indexed accessor cannot supply changing evidence.
    for (let index = 0; index < length; index += 1) {
      const unit = ownReviewData(units, String(index));
      if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return stopped('invalid');
      const months = ownReviewData(unit, 'months');
      const scenario = ownReviewData(unit, 'scenario') as CustomerWorstCase | null;
      if (months !== 1 && months !== 12) return stopped('invalid');
      const result = assessCustomerWorstCase(scenario, months);
      if (!result.approved) return stopped(result.reason === 'below_floor' || result.reason === 'no_revenue' ? 'below_unit_floor' : 'unknown');
      // MR's percentage floor is zero. Use only the assessor's detached net
      // result; never re-read a scenario after it has been assessed.
      const headroom = BigInt(result.netCents!) * BigInt(10000);
      if (fixedCents > BigInt(0) && headroom === BigInt(0)) return stopped('no_finite_base');
      if (fixedCents === BigInt(0)) continue;
      const needed = fixedCents * BigInt(10000) * BigInt(months);
      const count = (needed + headroom - BigInt(1)) / headroom;
      if (count > minimum) minimum = count;
    }
    if (minimum > BigInt(Number.MAX_SAFE_INTEGER)) return stopped('invalid');
    return {status:'calculated',minimumCustomers:Number(minimum),reviewedBaseSufficient:BigInt(payingCustomers) >= minimum};
  } catch { return stopped('unknown'); }
}
