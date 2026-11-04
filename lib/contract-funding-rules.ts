import { assessPlanPaymentDisputeCosts, PLAN_PAYMENT_DISPUTE_COST_RULES } from '@/lib/plan-payment-dispute-cost-rules';
import { PUBLISHED_PLAN_PRICES, TRIAL_DAYS, REFUND_DAYS, type Tier, type Cycle } from '@/lib/plan';
import { CLOSING_DAYS } from '@/lib/plan-closing-rules';
import { LONGEST_PAUSE_MONTHS, PAUSE_EVERY_DAYS, PLAN_BREAKS_ENABLED } from '@/lib/plan-pause-rules';
import { CUSTOMER_COST_CATEGORIES, assessCustomerWorstCase } from '@/lib/net-margin-rules';
import { customerTaxCollectionState, customerTaxContractContextState, customerTaxContractContextSupported } from './customer-tax-review';
import { assessMinimumCustomerBase } from '@/lib/customer-base-rules';
import { fundedExposureDetails } from '@/lib/funded-exposure-rules';
import type { CommercialMarginReview, MarginScenario } from '@/lib/commercial-margin';
export const CONTRACT_KEYS=['creator_month','creator_year','pro_month','pro_year','scale_month','scale_year'] as const;
export type ContractKey=typeof CONTRACT_KEYS[number];
export const CONTRACT_ADMISSION_COVERAGE={checkout:true,planSwitch:true,pauseRestart:false,resourceAllocations:false,renewals:false,settlementAndReserveReconciliation:false} as const;
/** AV3: disabled optional facilities do not certify coverage or block unrelated
 * core lifecycle work. Every core contract obligation remains mandatory. */
export const CORE_CONTRACT_ADMISSION_KEYS=['checkout','planSwitch','resourceAllocations','renewals','settlementAndReserveReconciliation'] as const;
export function contractLifecycleReady(coverage:unknown=CONTRACT_ADMISSION_COVERAGE,planBreaksEnabled:unknown=PLAN_BREAKS_ENABLED):boolean{
 if(typeof planBreaksEnabled!=='boolean')return false;
 const encoded=canonicalFinancialSnapshot(coverage);
 if(encoded===null)return false;
 const value=JSON.parse(encoded) as Record<string,unknown>|null;
 const keys=[...CORE_CONTRACT_ADMISSION_KEYS,'pauseRestart'];
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||
  !keys.every(key=>Object.hasOwn(value,key)&&typeof value[key]==='boolean'))return false;
 return CORE_CONTRACT_ADMISSION_KEYS.every(key=>value[key]===true)&&(!planBreaksEnabled||value.pauseRestart===true);
}
export const CONTRACT_FUNDING_RULES={schema:4,planPaymentDisputes:PLAN_PAYMENT_DISPUTE_COST_RULES,openingLifecycle:{core:CORE_CONTRACT_ADMISSION_KEYS,planBreaksEnabled:PLAN_BREAKS_ENABLED,optionalPauseCoverageRequiredOnlyWhenEnabled:true},pauseDueObservation:{status:'bounded-reader-only',commandCeiling:3,maxMembers:200,maxMemberBytes:1280,maxMemberPayloadBytes:256000,operation:'read-only-type-zrange',malformed:'hold-entire-batch-no-cleanup'},pauseNoticeAdmission:'funded-held-until-source-reserved-generation-and-lifetime-envelope',pauseObservation:{status:'bounded-reader-only',commandCeiling:3,maxRecordBytes:4096,maxReadRawBytes:4097,absence:'atomic-type-none-only',unreadable:'retain-no-cleanup-no-charge',operation:'read-only-type-getrange'},restartIntent:{status:'intent-only-disabled',commandCeiling:17,maxPauseBytes:1536,maxIntentBytes:4096,ownership:'permanent-first-ack-only',annualSource:'immutable-exact-annual-eligibility-at-claim',sourceSnapshot:'atomic-active-receipts-and-reserved-cash',ack:'single-owner-with-exact-immutable-snapshot',provider:'not-authorized-by-intent',submissionBarrier:'one-way-uncertain-before-any-post-no-rearm',barrierCommandCeiling:17,resultHeadroomBytes:256,sourceIndex:'permanent-per-original-grant-never-reclaimed',maxSourceIndexRawBytes:182,recovery:'at-most-three-lifetime-provider-reads-no-post-no-empty-search-absence',activatedRecovery:'exact-live-committed-paid-binding-without-provider-read-or-counter-write',activatedRecoveryRawFieldBytes:4736,publicationCheckpoint:'atomic-exact-paid-binding-observed-renews-shared',maxPublicationCheckpointBytes:384,jointPublication:{status:'implemented-disabled',writeCommandCeiling:64,readbackCommandCeiling:64,maxReadbacks:1,lockAttempts:1,lockSeconds:15,ownerRawBytes:1000000,ownerReadRawBytes:1000001,maxPublishedReceiptBytes:1536,publicationStageCommandCeiling:149,notice:'not-authorized-by-publication'},maxRecoveryReads:3,recoveryCommandCeiling:17,resultCommandCeiling:17,resultRetention:'exact-first-ID-after-deadline-is-evidence-not-activation',barrierEnvelope:'same-field-and-4096bytes-including-state',priceRead:'one-complete-exact-existing-published-monthly-unit-no-creation',prePostStoreSource:'bounded-current-owner-inactive-monthly-exact-grant-source-before-first-post',prePostStoreCommandCeiling:1,prePostStoreMaxRawBytes:1000001},restartReservation:{status:'primitive-only-disabled',commandCeiling:17,source:'expired-paid-monthly-immutable-active-and-activated-receipt',cash:'new-full-grant-retain-old-liabilities',submission:'not-authorized-by-reservation'},checkoutActivation:{schema:1,source:'provider-owned-subscription',receipt:'one-grant-one-subscription-initial-phase-and-period',cash:'retain',pending:'clear-only-after-activation',scope:'initial-checkout-only',ack:'deadline-rechecked-after-ack',observedRecovery:'initial-grant-required-for-search-and-list-adoption'},ledger:'nl:contract-reserve:v1',maxInteger:1_000_000_000_000,paidMonths:{month:1,year:12},longestMonthDays:31,shortestMonthDays:28,trialDays:TRIAL_DAYS,refundDays:REFUND_DAYS,closingDays:CLOSING_DAYS,longestPauseMonths:LONGEST_PAUSE_MONTHS,pauseEveryDays:PAUSE_EVERY_DAYS,reservation:'refund-principal-paid-costs-taxes-and-full-coverage-company-allocation',failure:'retain',pending:'one-grant-per-store',checkout:'reject-existing-active-binding',switchSource:'same-current-funded-subscription-with-immutable-source-grant',switchActivation:'atomic-active-pointer-after-provider-phase-proof-retain-all-cash',currentTermObservation:'committed-exact-phase-period-only-with-current-review-no-new-activation-after-deadline',resourceCohortRequestBytes:12288,resourceCohortRestart:{status:'lineage-validation-only-disabled',commandCeiling:40,publishedReceiptBytes:1536,checkpointBytes:384,intentBytes:4096,sourceReceiptBytes:1024,sourceBindingBytes:256,ownership:'permanent-source-owner-and-joint-publication-required',cash:'retain-all-current-and-source-principal'},resourceCohort:'one-monthly-or-twelve-annual-fields-exact-active-paid-proof-reconcile-six-slot-principals-retain-all-cash',grant:'single-use',activationDelayDays:1,liabilityHorizon:'last-admission-plus-activation-delay-and-full-reviewed-coverage',checkoutLifetimeSeconds:3600,submissionSeconds:300,coverage:CONTRACT_ADMISSION_COVERAGE} as const;
export type ContractFundingPolicy={reviewId:string;financialSnapshot:string;admissionsUntil:string;liabilitiesThrough:string;reviewedLiabilityTailDays:number|null;allTermCostsAndLiabilitiesBounded:boolean;coverageEvidence:string;reserveEvidence:string;reservedFundsCents:number;carryForwardReservedCents:number;fundedGrants:Record<ContractKey,number>};
export type ContractFundingContext={termsSnapshot:string;review:CommercialMarginReview|null};
export const CURRENT_CONTRACT_FUNDING_POLICY:ContractFundingPolicy|null=null;
const integer=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const bounded=(n:unknown):n is number=>integer(n)&&n<=CONTRACT_FUNDING_RULES.maxInteger;
/** Stable own-data financial evidence, without executing accessors or toJSON. */
export function canonicalFinancialSnapshot(value:unknown):string|null {
 const active=new WeakSet<object>();
 function encode(v:unknown,depth:number):string|null {
  if(depth>30)return null;
  if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);
  if(typeof v==='number')return Number.isSafeInteger(v)?String(v):null;
  if(!v||typeof v!=='object'||active.has(v))return null;
  const proto=Object.getPrototypeOf(v);if(!Array.isArray(v)&&proto!==Object.prototype&&proto!==null)return null;
  // Context wrappers are copied before the shared configuration in several
  // paths. Capture their original fiscal kind before ownKeys can swap review
  // values, then verify the exact serialized result cannot downgrade TX.
  const reviewField=Object.getOwnPropertyDescriptor(v,'review');
  const hasScenarios=reviewField&&Object.hasOwn(reviewField,'value')&&reviewField.value&&typeof reviewField.value==='object'&&Object.getOwnPropertyDescriptor(reviewField.value,'scenarios');
  const contextKind=hasScenarios?customerTaxCollectionState(reviewField.value):null;
  if(contextKind==='unknown')return null;
  const keys=Reflect.ownKeys(v);if(keys.some(key=>typeof key!=='string'))return null;
  // A snapshot must not turn original fiscal presence into legacy absence.
  // Read known descriptors even when a Proxy omits them from ownKeys.
  for(const name of ['taxReview','taxContext']){
   const d=Object.getOwnPropertyDescriptor(v,name);
   if(d?!keys.includes(name):name in v)return null;
  }
  const descriptors=new Map<string,PropertyDescriptor>();
  for(const key of keys as string[]){
   const d=key==='review'?reviewField:Object.getOwnPropertyDescriptor(v,key);
   if(!d||!Object.hasOwn(d,'value')||(!d.enumerable&&!(Array.isArray(v)&&key==='length')))return null;
   descriptors.set(key,d);
  }
  active.add(v);let result:string|null=null;
  if(Array.isArray(v)){
   const length=descriptors.get('length')?.value;if(!Number.isSafeInteger(length)||length<0||keys.length!==length+1){active.delete(v);return null;}
   const parts:string[]=[];for(let i=0;i<length;i++){const d=descriptors.get(String(i));if(!d||!Object.hasOwn(d,'value')){active.delete(v);return null;}const part=encode(d.value,depth+1);if(part===null){active.delete(v);return null;}parts.push(part);}result='['+parts.join(',')+']';
  }else{
   const parts:string[]=[];for(const key of (keys as string[]).sort()){const d=descriptors.get(key);if(!d||!Object.hasOwn(d,'value')){active.delete(v);return null;}const part=encode(d.value,depth+1);if(part===null){active.delete(v);return null;}parts.push(JSON.stringify(key)+':'+part);}result='{'+parts.join(',')+'}';
  }
  active.delete(v);
  if(contextKind!==null&&result!==null&&(result.length>1024*1024||customerTaxContractContextState(JSON.parse(result))!==contextKind))return null;
  return result;
 }
 try{const result=encode(value,0);return result!==null&&new TextEncoder().encode(result).length<=1024*1024?result:null;}catch{return null;}
}
/** Conservative calendar bound, including repeated permitted pauses. The tail
 * is a separately reviewed liability horizon, not a guessed legal limitation. */
export function contractCoverageDays(cycle:Cycle,tailDays:number):number|null {
 if(!integer(tailDays)||tailDays<REFUND_DAYS+CLOSING_DAYS||(cycle!=='month'&&cycle!=='year'))return null;
 const pauseDays=LONGEST_PAUSE_MONTHS*31;
 if(!integer(PAUSE_EVERY_DAYS)||PAUSE_EVERY_DAYS<=pauseDays)return null;
 const base=CONTRACT_FUNDING_RULES.paidMonths[cycle]*31+TRIAL_DAYS+tailDays;
 if(!integer(base))return null;
 let days=base;
 for(let i=0;i<1000;i++){const next=base+(1+Math.floor(days/PAUSE_EVERY_DAYS))*pauseDays;if(!integer(next))return null;if(next===days)return days;days=next;}
 return null;
}
const iso=(value:unknown):number|null=>{if(typeof value!=='string')return null;const n=Date.parse(value);return Number.isFinite(n)&&new Date(n).toISOString()===value?n:null;};
export type ContractFundingConfiguration={reviewId:string;binding:string;cashLimitCents:number;carryForwardCents:number;fundedGrants:Record<ContractKey,number>;grantCents:Record<ContractKey,number>;coverageDays:Record<Cycle,number>;admissionsUntilMs:number;liabilitiesThroughMs:number};
/** Pure reserve calculation. The caller must also enforce commercialMarginReady
 * and actual admission coverage before enabling real sales. */
export function contractFundingConfiguration(policy:ContractFundingPolicy|null,context:ContractFundingContext,now=new Date()):ContractFundingConfiguration|null {
 // Scoped TX may fund a contract only when it is bound to this exact policy,
 // the actual admission time and the complete existing liability horizon.
 // Inspect original data first: the canonical clone must not erase presence.
 const taxState=customerTaxContractContextState(context);
 if(taxState==='unknown'||!customerTaxContractContextSupported(context,policy,now))return null;
 // Stabilize both original inputs together. A Proxy can offer one value to
 // the precheck and another to serialization; only the captured pair may
 // decide calculations, financial bindings and the returned liability period.
 const encoded=canonicalFinancialSnapshot({policy,context});
 if(!encoded)return null;
 const captured=JSON.parse(encoded) as {policy:ContractFundingPolicy|null;context:ContractFundingContext};
 const p=captured.policy;context=captured.context;
 if(!context||typeof context!=='object'||Array.isArray(context)||customerTaxContractContextState(context)!==taxState||!customerTaxContractContextSupported(context,p,now))return null;
 const reviewEncoded=canonicalFinancialSnapshot(context.review);
 if(!reviewEncoded||!Number.isFinite(now.getTime())||typeof context.termsSnapshot!=='string'||!context.termsSnapshot)return null;
 const review=JSON.parse(reviewEncoded) as CommercialMarginReview|null;
 if(!p||!review||p.financialSnapshot!==reviewEncoded||review.priceAndRightsSnapshot!==context.termsSnapshot||typeof p.reviewId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.reviewId)||p.allTermCostsAndLiabilitiesBounded!==true||typeof p.coverageEvidence!=='string'||!p.coverageEvidence.trim()||typeof p.reserveEvidence!=='string'||!p.reserveEvidence.trim()||!bounded(p.reservedFundsCents)||!bounded(p.carryForwardReservedCents)||!p.fundedGrants)return null;
 const disputes=assessPlanPaymentDisputeCosts(review.planPaymentDisputes);
 if(!disputes)return null;
 const until=iso(p.admissionsUntil),through=iso(p.liabilitiesThrough);
 if(until===null||through===null||until<now.getTime()||p.reviewedLiabilityTailDays===null)return null;
 const monthDays=contractCoverageDays('month',p.reviewedLiabilityTailDays),yearDays=contractCoverageDays('year',p.reviewedLiabilityTailDays);
 if(monthDays===null||yearDays===null)return null;
 const exposure=fundedExposureDetails(review.fundedExposure,now),fixed=review.companyBase;
 if(!exposure||!fixed||!integer(fixed.monthlyFixedCostsCeilingCents)||!integer(fixed.monthlyFixedTaxesCeilingCents)||!integer(fixed.reviewedPayingCustomers)||fixed.reviewedPayingCustomers<1||review.allocatedFixedCostsVerified!==true||review.prepaidUsageEnforced!==true||!review.scenarios)return null;
 const fixedWithExposure=fixed.monthlyFixedCostsCeilingCents+exposure.budgetCents;
 if(!Number.isSafeInteger(fixedWithExposure))return null;
 const base=assessMinimumCustomerBase(CONTRACT_KEYS.map(key=>({months:key.endsWith('_year')?12:1,scenario:review.scenarios[(key+'_full') as MarginScenario]??null})),{...fixed,monthlyFixedCostsCeilingCents:fixedWithExposure});
 if(!base.reviewedBaseSufficient)return null;
 if(!CONTRACT_KEYS.every(key=>bounded(p.fundedGrants[key])))return null;
 const allNewGrants=CONTRACT_KEYS.reduce((sum,key)=>sum+BigInt(p.fundedGrants[key]),BigInt(0));
 if(allNewGrants<=BigInt(0)||TRIAL_DAYS>0&&BigInt(exposure.allocations.trial.slots)<allNewGrants)return null;
 const companyMonthly=BigInt(fixed.monthlyFixedCostsCeilingCents)+BigInt(fixed.monthlyFixedTaxesCeilingCents)+BigInt(exposure.budgetCents);
 const grantCents={} as Record<ContractKey,number>,coverageDays={month:monthDays,year:yearDays};
 let total=BigInt(p.carryForwardReservedCents),slots=BigInt(0),maxDays=0;
 for(const key of CONTRACT_KEYS){
  const [tier,cycle]=key.split('_') as [Tier,Cycle],count=p.fundedGrants[key],unit=review.scenarios[(key+'_full') as MarginScenario]??null;
  if(!bounded(count)||!unit||!assessCustomerWorstCase(unit).approved||unit.collectedRevenueCents!>PUBLISHED_PLAN_PRICES[tier][cycle])return null;
  if(unit.costCeilings.refundAndDisputeFees!<disputes[key].feesCents)return null;
  const months=2+Math.ceil((coverageDays[cycle]+CONTRACT_FUNDING_RULES.activationDelayDays)/28);
  const allocation=(companyMonthly*BigInt(months)+BigInt(fixed.reviewedPayingCustomers)-BigInt(1))/BigInt(fixed.reviewedPayingCustomers);
  const costs=CUSTOMER_COST_CATEGORIES.reduce((n,category)=>n+BigInt(unit.costCeilings[category]!),BigInt(unit.taxesCeilingCents!));
  // Replace the principal already reserved, rather than charging it twice.
  // Complete dispute fees stay inside costs above; annual principal is whole.
  const required=BigInt(disputes[key].principalCents)+costs+allocation;
  if(required<=BigInt(0)||required>BigInt(CONTRACT_FUNDING_RULES.maxInteger))return null;
  grantCents[key]=Number(required);total+=required*BigInt(count);slots+=BigInt(count);
  if(count>0)maxDays=Math.max(maxDays,coverageDays[cycle]);
 }
 // The last permitted admission may activate only at the end of its delay.
 // Its full paid/pause/refund/closing tail must still fit the reviewed horizon.
 const requiredThrough=until+(maxDays+CONTRACT_FUNDING_RULES.activationDelayDays)*86400000;
 if(slots===BigInt(0)||total>BigInt(p.reservedFundsCents)||!Number.isSafeInteger(requiredThrough)||through<requiredThrough)return null;
 return {reviewId:p.reviewId,binding:JSON.stringify([CONTRACT_FUNDING_RULES,context.termsSnapshot,reviewEncoded,p]),cashLimitCents:p.reservedFundsCents,carryForwardCents:p.carryForwardReservedCents,fundedGrants:p.fundedGrants,grantCents,coverageDays,admissionsUntilMs:until,liabilitiesThroughMs:through};
}
