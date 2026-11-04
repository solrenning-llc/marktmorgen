import { customerTaxReviewFields } from './customer-tax-review';
import { CUSTOMER_COST_CATEGORIES, type CustomerWorstCase } from '@/lib/net-margin-rules';
export const EXPOSURE_SCOPES = ['trial','setup','full_refund','non_payment','post_cancellation','paused','legacy_credits','platform_waitlist'] as const;
export const FUNDED_EXPOSURE_RULES = {schema:1,period:'worst-recognized-month',offsets:'none-no-future-conversions',fixedTaxShield:'none',scopes:EXPOSURE_SCOPES} as const;
export type ExposureScope = typeof EXPOSURE_SCOPES[number];
export type FundedExposureReview = {month:string; evidence:string; admissionLimitsEnforced:boolean; monthlyBudgetCents:number|null; cases:Record<ExposureScope,{maximumMonthlyCases:number|null;worstCase:CustomerWorstCase|null}>};
export type FundedExposureAssessment = {approved:boolean;reason:'unknown'|'invalid'|'unbounded'|'underfunded'|'approved';requiredBudgetCents:number|null;monthlyBudgetCents:number|null};
const integer=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
/** Review accessors and inherited values cannot fabricate costs or occurrence caps. */
function own(value:unknown,key:string):unknown {try {if(!value||typeof value!=='object'||Array.isArray(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}}
/** Exposure is a known loss ceiling, never approval of a paying customer's
 * profit or a tax regime. Every legacy amount/flag remains mandatory, including
 * zero-count scopes; TX evidence stays refused before these manual snapshots.
 * Net collected income requires a scoped TX review, so it remains closed until
 * the exposure migration. A legacy tax flag cannot certify a zero liability. */
function knownLossNet(unit:CustomerWorstCase):{net:bigint|null;reason:'unknown'|'invalid'} {
 const values=[unit.collectedRevenueCents,unit.refundableRevenueCents,unit.taxesCeilingCents,...CUSTOMER_COST_CATEGORIES.map(key=>unit.costCeilings[key])];
 if(values.some(value=>value===null||value===undefined))return {net:null,reason:'unknown'};
 if(!values.every(integer)||unit.refundableRevenueCents!>unit.collectedRevenueCents!)return {net:null,reason:'invalid'};
 if(unit.allCostsBounded!==true||unit.allTaxesReviewed!==true||unit.revenueCollected!==true)return {net:null,reason:'unknown'};
 if(unit.collectedRevenueCents!==unit.refundableRevenueCents)return {net:null,reason:'unknown'};
 const net=BigInt(unit.collectedRevenueCents!)-BigInt(unit.refundableRevenueCents!)-BigInt(unit.taxesCeilingCents!)-CUSTOMER_COST_CATEGORIES.reduce((sum,key)=>sum+BigInt(unit.costCeilings[key]!),BigInt(0));
 return net>BigInt(Number.MAX_SAFE_INTEGER)||net< -BigInt(Number.MAX_SAFE_INTEGER)?{net:null,reason:'invalid'}:{net,reason:'unknown'};
}
const fail=(reason:FundedExposureAssessment['reason']):FundedExposureAssessment=>({approved:false,reason,requiredBudgetCents:null,monthlyBudgetCents:null});
/** Sum simultaneous recognized losses. No profit margin is invented for a free
 * account: its complete exposure consumes the paid company's available surplus.
 * A review is not a runtime admission ledger or permission to deny legal refunds.
 */
export function assessFundedExposure(review:FundedExposureReview|null,now=new Date()):FundedExposureAssessment {
 if(!Number.isFinite(now.getTime())||own(review,'month')!==now.toISOString().slice(0,7)||typeof own(review,'evidence')!=='string'||!(own(review,'evidence') as string).trim())return fail('unknown');
 if(own(review,'admissionLimitsEnforced')!==true)return fail('unbounded');
 const budget=own(review,'monthlyBudgetCents'),cases=own(review,'cases');if(!integer(budget))return fail(budget==null?'unknown':'invalid');
 let required=BigInt(0);
 for(const scope of EXPOSURE_SCOPES){
  const item=own(cases,scope),count=own(item,'maximumMonthlyCases'),raw=own(item,'worstCase'),costs=own(raw,'costCeilings');
  if(raw&&typeof raw==='object'&&customerTaxReviewFields(raw).present)return fail('unknown');
  if(!integer(count))return fail(count==null?'unknown':'invalid');
  const unit={collectedRevenueCents:own(raw,'collectedRevenueCents'),refundableRevenueCents:own(raw,'refundableRevenueCents'),taxesCeilingCents:own(raw,'taxesCeilingCents'),costCeilings:Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,own(costs,key)])),allCostsBounded:own(raw,'allCostsBounded')===true,allTaxesReviewed:own(raw,'allTaxesReviewed')===true,revenueCollected:own(raw,'revenueCollected')===true} as CustomerWorstCase;
  // A pre-opening waitlist has no collected subscription revenue. Interest or
  // later conversions cannot offset this scope's costs or another obligation.
  if(scope==='platform_waitlist'&&unit.collectedRevenueCents!==0)return fail(unit.collectedRevenueCents==null?'unknown':'invalid');
  const assessed=knownLossNet(unit);
  if(assessed.net===null)return fail(assessed.reason);
  // Positive results never offset this occurrence or another obligation.
  const net=assessed.net;
  if(net<BigInt(0))required+=(-net)*BigInt(count);
 }
 if(required>BigInt(Number.MAX_SAFE_INTEGER))return fail('invalid');
 return {approved:BigInt(budget)>=required,reason:BigInt(budget)>=required?'approved':'underfunded',requiredBudgetCents:Number(required),monthlyBudgetCents:budget};
}

/** Canonical immutable-value copy used for funding bindings and reservations. */
export function fundedExposureDetails(review:FundedExposureReview|null,now=new Date()):{month:string;budgetCents:number;snapshot:string;allocations:Record<ExposureScope,{slots:number;cents:number}>}|null {
 // Capture each raw once: a Proxy cannot swap in TX between checking and copying.
 const cases={} as FundedExposureReview['cases'];
 for(const scope of EXPOSURE_SCOPES){
  const item=own(own(review,'cases'),scope),raw=own(item,'worstCase'),costs=own(raw,'costCeilings');
  if(raw&&typeof raw==='object'&&customerTaxReviewFields(raw).present)return null;
  cases[scope]={maximumMonthlyCases:own(item,'maximumMonthlyCases'),worstCase:{collectedRevenueCents:own(raw,'collectedRevenueCents'),refundableRevenueCents:own(raw,'refundableRevenueCents'),taxesCeilingCents:own(raw,'taxesCeilingCents'),costCeilings:Object.fromEntries(CUSTOMER_COST_CATEGORIES.map(key=>[key,own(costs,key)])),allCostsBounded:own(raw,'allCostsBounded'),allTaxesReviewed:own(raw,'allTaxesReviewed'),revenueCollected:own(raw,'revenueCollected')}} as FundedExposureReview['cases'][ExposureScope];
 }
 const copy={month:own(review,'month'),evidence:own(review,'evidence'),admissionLimitsEnforced:own(review,'admissionLimitsEnforced'),monthlyBudgetCents:own(review,'monthlyBudgetCents'),cases} as FundedExposureReview;
 if(!assessFundedExposure(copy,now).approved)return null;
 const allocations={} as Record<ExposureScope,{slots:number;cents:number}>;
 for(const scope of EXPOSURE_SCOPES){const item=copy.cases[scope],unit=item.worstCase!,a=knownLossNet(unit);if(a.net===null)return null;const net=a.net;if(net< -BigInt(Number.MAX_SAFE_INTEGER))return null;allocations[scope]={slots:item.maximumMonthlyCases!,cents:net<BigInt(0)?Number(-net):0};}
 const snapshot=JSON.stringify([FUNDED_EXPOSURE_RULES,copy.month,copy.evidence,copy.monthlyBudgetCents,EXPOSURE_SCOPES.map(scope=>{const item=copy.cases[scope],u=item.worstCase!;return [scope,item.maximumMonthlyCases,u.collectedRevenueCents,u.refundableRevenueCents,u.taxesCeilingCents,CUSTOMER_COST_CATEGORIES.map(key=>[key,u.costCeilings[key]]),u.allCostsBounded,u.allTaxesReviewed,u.revenueCollected];})]);
 return {month:copy.month,budgetCents:copy.monthlyBudgetCents!,snapshot,allocations};
}
