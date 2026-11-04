/** Historical planning model only, superseded by TX and MR. Its old prices,
 * 27.5% floor and 60% target reproduce prior tests; never import into product
 * code, a current resource budget or a release/admission decision. */
export const PLANNING_TAX_FLOOR = 0.275;
export const NET_MARGIN_FLOOR = 0.60;
export const LOCKED_PLAN_PRICES = {
  Store: { month: 22, year: 220, commissionBps: 625 },
  Studio: { month: 149, year: 1490, commissionBps: 275 },
  Scale: { month: 349, year: 3490, commissionBps: 0 },
} as const;
export type LockedPlan = keyof typeof LOCKED_PLAN_PRICES;
export type BillingCycle = 'month' | 'year';
/** Every amount is monthly, including annual receiving costs divided by 12. Zero must be explicit. */
export type WorstCaseCosts = {
  card: number; internationalCard: number; currencyConversion: number;
  billing: number; taxCalculation: number; remittance: number;
  hostingAndDatabase: number; storageAndRetention: number; videoStorage: number;
  videoDelivery: number; fileDelivery: number; email: number; ai: number;
  otherUsage: number; referral: number; refundsAndDisputes: number; support: number;
};
const receivingKeys = ['card','internationalCard','currencyConversion','billing','taxCalculation','remittance'] as const;
const usageKeys = ['hostingAndDatabase','storageAndRetention','videoStorage','videoDelivery','fileDelivery','email','ai','otherUsage'] as const;
const otherKeys = ['referral','refundsAndDisputes','support'] as const;
const costKeys = [...receivingKeys,...usageKeys,...otherKeys];
export type PolicyInput = {
  plan: LockedPlan; cycle: BillingCycle;
  costs: Partial<WorstCaseCosts>;
  /** Combined burden supported by tax research; the planning floor still applies. */
  combinedProfitTaxRate: number;
};
export type PolicyAssessment = {
  status: 'unverified' | 'below_floor' | 'meets_model_floor';
  missing: string[]; revenue: number; taxRate: number | null;
  receiving: number | null; R: number | null; C: number | null;
  A: number | null; D: number | null; S: number | null; L: number | null;
  profitTax: number | null; netProfit: number | null; netMargin: number | null;
  totalPretaxCostCeiling: number | null; usageCeiling: number | null;
  companyHeadroomBeforeFixed: number | null;
};
const validCost = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
export function assessWorstCasePolicy(input: PolicyInput): PolicyAssessment {
  const revenue = LOCKED_PLAN_PRICES[input.plan][input.cycle] / (input.cycle === 'year' ? 12 : 1);
  const missing: string[] = costKeys.filter(key => !validCost(input.costs[key]));
  if (!validCost(input.combinedProfitTaxRate) || input.combinedProfitTaxRate >= 1) missing.push('combinedProfitTaxRate');
  const unknown: PolicyAssessment = { status:'unverified', missing, revenue, taxRate:null, receiving:null,R:null,C:null,A:null,D:null,S:null,L:null,profitTax:null,netProfit:null,netMargin:null,totalPretaxCostCeiling:null,usageCeiling:null,companyHeadroomBeforeFixed:null };
  if (missing.length) return unknown;
  const sum = (keys: readonly (keyof WorstCaseCosts)[]) => keys.reduce((n,key)=>n+input.costs[key]!,0);
  const receiving=sum(receivingKeys), C=sum(usageKeys), A=input.costs.referral!, D=input.costs.refundsAndDisputes!, S=input.costs.support!;
  const total=receiving+C+A+D+S;
  if (!Number.isFinite(total)) return {...unknown,missing:['finiteCostTotal']};
  const taxRate=Math.max(PLANNING_TAX_FLOOR,input.combinedProfitTaxRate);
  const R=revenue-receiving, L=R-C-A-D-S;
  const profitTax=Math.max(0,L)*taxRate, netProfit=L-profitTax, netMargin=netProfit/revenue;
  const totalPretaxCostCeiling=revenue-NET_MARGIN_FLOOR*revenue/(1-taxRate);
  const usageCeiling=totalPretaxCostCeiling-receiving-A-D-S;
  // Compare spend directly to the ceiling: rounding a displayed margin must never approve an overspend.
  return {status:total<=totalPretaxCostCeiling?'meets_model_floor':'below_floor',missing:[],revenue,taxRate,receiving,R,C,A,D,S,L,profitTax,netProfit,netMargin,totalPretaxCostCeiling,usageCeiling,companyHeadroomBeforeFixed:totalPretaxCostCeiling-total};
}
/** Fixed costs are monthly pre-tax equivalents. Convert non-deductible expenses by dividing by (1-taxRate) before calling. */
export function minimumPolicyCustomerBase(rows: PolicyAssessment[], monthlyFixedCosts: number) {
  if (!rows.length || !validCost(monthlyFixedCosts) || rows.some(r=>r.status==='unverified'||r.companyHeadroomBeforeFixed===null)) return {status:'unverified' as const,customers:null};
  const room=Math.min(...rows.map(r=>r.companyHeadroomBeforeFixed!));
  if (room<0 || (room===0&&monthlyFixedCosts>0)) return {status:'no_finite_base' as const,customers:null};
  const customers=monthlyFixedCosts===0?1:Math.max(1,Math.ceil(monthlyFixedCosts/room));
  return Number.isSafeInteger(customers)?{status:'modeled' as const,customers}:{status:'unverified' as const,customers:null};
}
/** A trial or guaranteed full refund is a loss exposure, not a profitable paid unit. */
export function acquisitionLossExposure(usage:number,receivingFeesRetained:number,refundOrDisputeFees:number,support:number):number|null {
  const values=[usage,receivingFeesRetained,refundOrDisputeFees,support];
  if (!values.every(validCost)) return null;
  const sum=values.reduce((a,b)=>a+b,0); return Number.isFinite(sum)?sum:null;
}
