import { assessPlanPaymentDisputeCosts, PLAN_PAYMENT_DISPUTE_COST_RULES, PLAN_PAYMENT_DISPUTE_KEYS, type PlanPaymentDisputeReview } from "@/lib/plan-payment-dispute-cost-rules";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_IDS, LLC_FIXED_COST_ALLOCATION } from "@/lib/llc-fixed-costs";
import {CONTRACT_FUNDING_RULES,contractLifecycleReady,CURRENT_CONTRACT_FUNDING_POLICY,contractFundingConfiguration,canonicalFinancialSnapshot} from '@/lib/contract-funding-rules';
import { CURRENT_EXPOSURE_BUDGET_POLICY, exposureBudgetConfiguration, EXPOSURE_ADMISSION_RULES } from '@/lib/exposure-budget-policy';
import { assessFundedExposure, FUNDED_EXPOSURE_RULES, type FundedExposureReview } from '@/lib/funded-exposure-rules';
import { AI_ENTITLEMENT_RULES, aiEntitlementsFunded } from '@/lib/ai-entitlement-rules';
import { AUTOMATIC_UPLOAD_BUDGET_CEILINGS, UPLOAD_BUDGET_RULES, currentUploadBudgetPolicy, isUploadBudgetConfigured } from "@/lib/upload-budget-policy";
/** Client-safe release policy. No secrets, tax rates inferred from residence, or optimistic defaults.
 * Paid plans remain closed until every individual worst case is reviewed and passes the owner's floor.
 */
import { assessMinimumCustomerBase, CUSTOMER_BASE_RULES, type CustomerBaseReview } from "@/lib/customer-base-rules";
import { PLAN_PRICES, COMMISSION_BPS, COMMISSION_LIVE, COMMISSION_PLANS_PUBLISHED, PUBLISHED_PLAN_PRICES, TRIAL_DAYS, REFUND_DAYS, PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS, TRIAL_MONTHLY_EMAILS } from "@/lib/plan";
import { SHARE_PROVED_IN_TEST_MODE } from "@/lib/platform-share";
import { assessCustomerWorstCase, CUSTOMER_COST_CATEGORIES, MINIMUM_NET_MARGIN_BPS, MINIMUM_NET_PROFIT_CENTS, type CustomerWorstCase } from "@/lib/net-margin-rules";
import { CUSTOMER_TAX_REVIEW_POLICY, customerTaxScenarioMatches, customerTaxCollectionState } from './customer-tax-review';
import { AI_SPEND_RULES, AUTOMATIC_AI_SPEND_CEILINGS, currentAiSpendPolicy, aiStoreCostCents, isAiSpendPolicyValid } from "@/lib/ai-spend-policy";
import { AI_REQUEST_LIMITS, SUPPORTED_AI_MODELS } from "@/lib/ai-request-rules";
import { AI_MONTHLY, AI_PER_MINUTE, MAX_AI_NOTES, READ_PDF_PAGES, READ_PDF_JOBS } from "@/lib/ai-rules";
import { VIDEO_HOURS_INCLUDED, VIDEO_CENTS_PER_HOUR_OVER } from "@/lib/watch-rules";
import { PAID_VIDEO_HOURS, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { BUYER_RESERVE_BPS, VISITS_INCLUDED, VISIT_CENTS_PER_THOUSAND_OVER, SETUP_VISITS, TRIAL_VISITS, ROOM_LIVE_PARTS, ROOM_IDLE_PARTS } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED, ORDER_CENTS_PER_THOUSAND_OVER, TRIAL_ORDERS } from "@/lib/order-rules";
import { STORAGE_BRAKE_BYTES, PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { TRIAL_STORAGE_BYTES, SETUP_STORAGE_BYTES, SETUP_VIDEO_SECONDS } from "@/lib/plan-standing";
import { MAX_FILE_BYTES, MAX_STAMP_BYTES } from "@/lib/product-file";
import { TOP_HEIGHT, MOST_KEPT_BYTES, UPLOAD_WINDOW_SECONDS, ABANDONED_AFTER_MS, GIVE_UP_AFTER_MS } from "@/lib/stream-rules";
import { MAX_LEADS, MAX_IMPORT } from "@/lib/contact-rules";
import { CLOSING_DAYS, RECHECK_DAYS } from "@/lib/plan-closing-rules";
import { PAUSE_MONTHS, PAID_MONTHS_BEFORE_PAUSE, PAUSE_EVERY_DAYS } from "@/lib/plan-pause-rules";
import { INVITE_PROGRAM_OPEN, INVITE_SHARE_PERCENT, INVITE_BONUS_CENTS, LEGACY_INVITE_RECORDING_UNTIL } from "@/lib/creator-invite-rules";
import { QUIZ_USAGE_POLICY, QUIZ_MONTHLY_SUBMISSIONS } from "@/lib/quiz-usage-rules";
import { WORKFLOW_LIMITS } from "@/lib/flow-limits";
import { IMPORT_ALLOWANCES } from "@/lib/import-limits";
import { IMPORTS_PER_SHARE_MONTH, PREVIEWS_PER_SHARE_MONTH, SHARE_LIMITS } from "@/lib/funnel-share-rules";
import { TEAM_LIMITS } from "@/lib/team-scheduling-rules";
import { NEXT_OFFER_CHOICES, NEXT_OFFER_KEEP_SECONDS, NEXT_OFFER_OUTPUT_TOKENS, NEXT_OFFER_PRODUCTS, NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { ASSIST_REMINDERS_PER_STORE_DAY, ASSIST_REMIND_KEEP_SECONDS, ASSIST_REMIND_OUTPUT_TOKENS, ASSIST_REMIND_PRODUCTS, ASSIST_REMIND_REQUEST_UNITS, ASSIST_REMIND_VERSION } from "@/lib/assistant-reminder-rules";
import { ADD_ON_ROOM_CENTS, ADD_ON_FEES, ASSISTANT_INPUT_BYTES, ASSISTANT_KEEP_SECONDS, ASSISTANT_MESSAGES_MONTHLY, ASSISTANT_MODEL, ASSISTANT_OUTPUT_TOKENS, ASSISTANT_PRICE_CENTS, DISPUTE_RESERVE_BPS, REFUND_RESERVE_BPS, REMITTANCE_BPS } from "@/lib/store-assistant-rules";
export const REQUIRED_MARGIN_SCENARIOS=[
 "creator_month_full","creator_year_full","pro_month_full","pro_year_full","scale_month_full","scale_year_full",
 "video_overage","visits_overage","orders_overage",
] as const;
export type MarginScenario=typeof REQUIRED_MARGIN_SCENARIOS[number];
/** Base-plan worst cases cannot rely on future sales, overages or twelve monthly
 * payments for an annual subscription. Only the approved subscription can fund them.
 */
export const BASE_PLAN_REVENUE_CEILINGS: Partial<Record<MarginScenario, number>> = {
 creator_month_full: PUBLISHED_PLAN_PRICES.creator.month,
 creator_year_full: PUBLISHED_PLAN_PRICES.creator.year,
 pro_month_full: PUBLISHED_PLAN_PRICES.pro.month,
 pro_year_full: PUBLISHED_PLAN_PRICES.pro.year,
 scale_month_full: PUBLISHED_PLAN_PRICES.scale.month,
 scale_year_full: PUBLISHED_PLAN_PRICES.scale.year,
};
/** Existing spend-floor cost buffers, not published entitlement limits. */
export const COMMERCIAL_SPEND_FLOOR_ROOM_CENTS = { month: 25, year: 100 } as const;
/** Hold the existing cost room without crediting a speculative tax deduction.
 * The caller passes only the detached own-data review snapshot.
 */
function scenarioWithPlanRoom(key: MarginScenario, scenario: CustomerWorstCase | null): CustomerWorstCase | null {
 if(BASE_PLAN_REVENUE_CEILINGS[key]===undefined)return scenario;
 if(!scenario||!assessCustomerWorstCase(scenario).approved)return null;
 const room=key.includes("_year_")?COMMERCIAL_SPEND_FLOOR_ROOM_CENTS.year:COMMERCIAL_SPEND_FLOOR_ROOM_CENTS.month;
 const other=scenario.costCeilings.other!+room;
 if(!Number.isSafeInteger(other))return null;
 return {...scenario,costCeilings:{...scenario.costCeilings,other}};
}

/** Bind a review to actual priced rights, including free and post-cancellation use.
 * Vendor pricing, tax evidence and enforcement still require an independent review.
 */
export const CURRENT_COMMERCIAL_TERMS = {
 // Since 18 October 2026 (schema 22): the price list of the owner's decision of 11:21, one list with no share of a sale, and the limits raised with it.
 // Schema24: a complete LLC inventory and its ceilings bind every financial review.
 schemaVersion: 29,
 customerTaxReview: CUSTOMER_TAX_REVIEW_POLICY,
 planPaymentDisputes: PLAN_PAYMENT_DISPUTE_COST_RULES,
 marginPolicy: { decision: '2026-10-27T07:42:00-03:00', unit: 'strictly-positive-net-cents', minimumNetProfitCents: MINIMUM_NET_PROFIT_CENTS, company: 'nonnegative-at-computed-minimum-base', companyTargetBps: 6000, targetBasis: 'monthly-reconciled-actual-not-a-sales-gate', spendFloorRoom: COMMERCIAL_SPEND_FLOOR_ROOM_CENTS, assistantCostRoomCents: ADD_ON_ROOM_CENTS },
 usageAdmission: { schema: 1, paidVisits: "finite-plan-threshold", paidVideo: "finite-explicit-threshold", unknownTraffic: "pause", supplierByteCeilingProven: false },
 uploadAdmission: { rules: UPLOAD_BUDGET_RULES, policy: AUTOMATIC_UPLOAD_BUDGET_CEILINGS },
 customerBaseRules: CUSTOMER_BASE_RULES,
 llcFixedCosts: { allocation: LLC_FIXED_COST_ALLOCATION, required: LLC_FIXED_COST_IDS, ceilings: CURRENT_LLC_FIXED_COST_CEILINGS, budget: "full-month-and-year-included-before-separately-funded-exposure", annual: "complete-ceilings-and-reserve-review-no-automatic-amortization" },
 fundedExposureRules: FUNDED_EXPOSURE_RULES,
 exposureAdmissionRules: EXPOSURE_ADMISSION_RULES,
 contractFundingRules:CONTRACT_FUNDING_RULES,
 invitations: { open: INVITE_PROGRAM_OPEN, legacySharePercent: INVITE_SHARE_PERCENT, legacyBonusCents: INVITE_BONUS_CENTS, legacyRecordingUntil: LEGACY_INVITE_RECORDING_UNTIL },
 quizzes: { newQuizPolicy: QUIZ_USAGE_POLICY, submissionsPerStoreUtcMonth: QUIZ_MONTHLY_SUBMISSIONS, legacyQuizzesExempt: true },
 workflows: WORKFLOW_LIMITS,
 // Since 17 October 2026 (schema 18): monthly figures for imports, shared funnels and team calls,
 // and no use sold past a plan (visits rest, new orders are admitted only within the figure).
 imports: IMPORT_ALLOWANCES,
 funnelShare: { perPlan: SHARE_LIMITS, perLinkMonth: { previews: PREVIEWS_PER_SHARE_MONTH, imports: IMPORTS_PER_SHARE_MONTH } },
 teamScheduling: { perPlan: TEAM_LIMITS },
 // Since 17 October 2026 (schema 19): the Store assistant add-on, its price, its pool and the reserves its own payment carries.
 storeAssistant: { priceCents: ASSISTANT_PRICE_CENTS, messagesMonthly: ASSISTANT_MESSAGES_MONTHLY, model: ASSISTANT_MODEL, inputBytes: ASSISTANT_INPUT_BYTES, outputTokens: ASSISTANT_OUTPUT_TOKENS, keepSeconds: ASSISTANT_KEEP_SECONDS, fees: ADD_ON_FEES, disputeReserveBps: DISPUTE_RESERVE_BPS, refundReserveBps: REFUND_RESERVE_BPS, remittanceBps: REMITTANCE_BPS, refunds: "law-only", sold: "paid-plan-only",
  // Since 17 October 2026 (schema 20): its next product after a purchase, from the same pool at the same worst cost per reply, its reads counted as public requests.
  nextOffer: { pool: "shared", products: NEXT_OFFER_PRODUCTS, choices: NEXT_OFFER_CHOICES, outputTokens: NEXT_OFFER_OUTPUT_TOKENS, keepSeconds: NEXT_OFFER_KEEP_SECONDS, requestUnits: NEXT_OFFER_REQUEST_UNITS, email: "confirmation-only-with-consent" },
  // Since 17 October 2026 (schema 21): one checkout reminder asked for at checkout, its AI line from the same pool at the same worst cost per reply, its email from the store's own figure, its reads counted as public requests.
  reminder: { pool: "shared", products: ASSIST_REMIND_PRODUCTS, outputTokens: ASSIST_REMIND_OUTPUT_TOKENS, keepSeconds: ASSIST_REMIND_KEEP_SECONDS, requestUnits: ASSIST_REMIND_REQUEST_UNITS, perStoreDay: ASSIST_REMINDERS_PER_STORE_DAY, consent: ASSIST_REMIND_VERSION, email: "store-email-figure", basis: "explicit-checkbox-only", perCheckout: 1 } },
 basePlanRevenueCeilings: BASE_PLAN_REVENUE_CEILINGS,
 minimumNetMarginBps: MINIMUM_NET_MARGIN_BPS,
 costCategories: CUSTOMER_COST_CATEGORIES,
 scenarios: REQUIRED_MARGIN_SCENARIOS,
 prices: PLAN_PRICES,
 publishedPrices: PUBLISHED_PLAN_PRICES,
 commission: COMMISSION_BPS,
 commissionLive: COMMISSION_LIVE,
 commissionOffer: COMMISSION_PLANS_PUBLISHED,
 commissionProven: SHARE_PROVED_IN_TEST_MODE,
 trialDays: TRIAL_DAYS,
 refundDays: REFUND_DAYS,
 email: { admission: "strict-counter-ack-retain-dispatched-attempts-v1", trial: TRIAL_MONTHLY_EMAILS, pro: PRO_MONTHLY_EMAILS, scale: SCALE_MONTHLY_EMAILS, maxLeads: MAX_LEADS, maxImport: MAX_IMPORT },
 ai: { entitlements: AI_ENTITLEMENT_RULES, financialCoverage: "funded-slots-and-customer-ceilings-v1", spendRules: AI_SPEND_RULES, spendPolicy: AUTOMATIC_AI_SPEND_CEILINGS, requestLimits: AI_REQUEST_LIMITS, supportedModels: SUPPORTED_AI_MODELS, monthly: AI_MONTHLY, perMinute: AI_PER_MINUTE, maxNotes: MAX_AI_NOTES, pdfPages: READ_PDF_PAGES, pdfJobs: READ_PDF_JOBS },
 storage: { paidBytesByTier: PAID_STORAGE_BYTES, defaultPaidBytes: STORAGE_BRAKE_BYTES, trialNeverExceedsPaidTier: true, trialBytes: TRIAL_STORAGE_BYTES, setupBytes: SETUP_STORAGE_BYTES, maxFileBytes: MAX_FILE_BYTES, maxStampBytes: MAX_STAMP_BYTES },
 video: { paidHoursByTier: PAID_VIDEO_HOURS, trialSeconds: TRIAL_VIDEO_SECONDS, legacyBillingIncludedHours: VIDEO_HOURS_INCLUDED, setupSeconds: SETUP_VIDEO_SECONDS, overageCentsPerHour: VIDEO_CENTS_PER_HOUR_OVER, topHeight: TOP_HEIGHT, maxKeptBytes: MOST_KEPT_BYTES, uploadWindowSeconds: UPLOAD_WINDOW_SECONDS, abandonedAfterMs: ABANDONED_AFTER_MS, giveUpAfterMs: GIVE_UP_AFTER_MS },
 traffic: { included: VISITS_INCLUDED, setup: SETUP_VISITS, trial: TRIAL_VISITS, overage: "not-sold", buyerReserveBps: BUYER_RESERVE_BPS, overageCentsPerThousand: VISIT_CENTS_PER_THOUSAND_OVER, roomLiveParts: ROOM_LIVE_PARTS, roomIdleParts: ROOM_IDLE_PARTS },
 orders: { included: ORDERS_INCLUDED, trial: TRIAL_ORDERS, overage: "not-sold", admission: "paid-stores-counted-plus-open-day-v1", overageCentsPerThousand: ORDER_CENTS_PER_THOUSAND_OVER },
 closure: { days: CLOSING_DAYS, recheckDays: RECHECK_DAYS },
 pause: { months: PAUSE_MONTHS, paidMonthsRequired: PAID_MONTHS_BEFORE_PAUSE, everyDays: PAUSE_EVERY_DAYS },
} as const;
export const CURRENT_PRICE_AND_RIGHTS_SNAPSHOT = JSON.stringify(CURRENT_COMMERCIAL_TERMS);
export type CommercialMarginReview={
 planPaymentDisputes?:PlanPaymentDisputeReview|null;
 priceAndRightsSnapshot:string;
 companyBase:CustomerBaseReview|null;
 fundedExposure:FundedExposureReview|null;
 taxEvidence:string;
 costAndLimitEvidence:string;
 allocatedFixedCostsVerified:boolean;
 prepaidUsageEnforced:boolean;
 scenarios:Partial<Record<MarginScenario,CustomerWorstCase|null>>;
};
/** No verified all-tax/all-cost review exists yet. Unknown is not zero or permission to sell. */
export const CURRENT_COMMERCIAL_MARGIN_REVIEW:CommercialMarginReview|null=null;
/** Reviews are data, never executable accessors, inherited assertions or JSON hooks.
 * The same bounded canonical representation already binds contract funding.
 * Keep real reviews absent until their evidence is established independently.
 */
function commercialReviewData(review:CommercialMarginReview|null):CommercialMarginReview|null{
 if(!review||typeof review!=="object"||Array.isArray(review))return null;
 const taxState=customerTaxCollectionState(review);
 if(taxState==='unknown')return null;
 const encoded=canonicalFinancialSnapshot(review);
 if(encoded===null)return null;
 const data=JSON.parse(encoded) as CommercialMarginReview;
 return customerTaxCollectionState(data)===taxState?data:null;
}
export function commercialMarginReady(review:CommercialMarginReview|null=CURRENT_COMMERCIAL_MARGIN_REVIEW):boolean{
 const data=commercialReviewData(review);
 return data!==null&&commercialMarginDataReady(data);
}
/** Called only with the detached own-data snapshot produced above. */
function commercialMarginDataReady(review:CommercialMarginReview):boolean{
 const uploadPolicy=currentUploadBudgetPolicy();
 if(!isUploadBudgetConfigured(uploadPolicy))return false;
 const aiPolicy=currentAiSpendPolicy();
 if(!isAiSpendPolicyValid(aiPolicy)||!aiEntitlementsFunded(aiPolicy))return false;
 if(!review||review.priceAndRightsSnapshot!==CURRENT_PRICE_AND_RIGHTS_SNAPSHOT)return false;
 if(typeof review.taxEvidence!=="string"||!review.taxEvidence.trim()||typeof review.costAndLimitEvidence!=="string"||!review.costAndLimitEvidence.trim())return false;
 if(review.allocatedFixedCostsVerified!==true||review.prepaidUsageEnforced!==true||!review.scenarios)return false;
 // Every scoped TX record belongs to this exact scenario, not another plan or interval.
 for(const key of REQUIRED_MARGIN_SCENARIOS){
  const scenario=review.scenarios[key];
  if(scenario&&!customerTaxScenarioMatches(scenario,key))return false;
 }
 // A reserve for a lost plan payment must include the reviewed maximum paid
 // principal and fees. The fees are already an expense category: require their
 // complete ceiling there, without adding the same fee a second time.
 const disputes=assessPlanPaymentDisputeCosts(review.planPaymentDisputes);
 if(!disputes)return false;
 for(const key of PLAN_PAYMENT_DISPUTE_KEYS){
  const fee=review.scenarios[(key+"_full") as MarginScenario]?.costCeilings.refundAndDisputeFees;
  if(typeof fee!=="number"||!Number.isSafeInteger(fee)||fee<disputes[key].feesCents)return false;
 }
 // Aggregate flags cannot approve unknown or omitted lines in the actual LLC
 // inventory. Include the full cost/tax total once; never add it a second time
 // or borrow the separately earmarked acquisition/closing exposure budget.
 const llc=allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS);
 const fixedCosts=review.companyBase?.monthlyFixedCostsCeilingCents;
 const fixedTaxes=review.companyBase?.monthlyFixedTaxesCeilingCents;
 if(!llc || typeof fixedCosts!=="number" || !Number.isSafeInteger(fixedCosts) || fixedCosts<0
  || typeof fixedTaxes!=="number" || !Number.isSafeInteger(fixedTaxes) || fixedTaxes<0)return false;
 const fixedBudget=BigInt(fixedCosts)+BigInt(fixedTaxes);
 if(fixedBudget<BigInt(llc.monthlyUsdCents)||fixedBudget*BigInt(12)<BigInt(llc.annualUsdCents))return false;
 const exposure=assessFundedExposure(review.fundedExposure);
 if(!exposure.approved||!review.companyBase||review.companyBase.monthlyFixedCostsCeilingCents==null)return false;
 const combinedCosts=review.companyBase.monthlyFixedCostsCeilingCents+exposure.monthlyBudgetCents!;
 if(!Number.isSafeInteger(combinedCosts))return false;
 const company = assessMinimumCustomerBase(
  Object.keys(BASE_PLAN_REVENUE_CEILINGS).map(key=>({months:key.includes("_year_")?12:1,scenario:scenarioWithPlanRoom(key as MarginScenario,review.scenarios[key as MarginScenario]??null)})), {...review.companyBase,monthlyFixedCostsCeilingCents:combinedCosts},
 );
 if(!company.reviewedBaseSufficient)return false;
 // Non-paying AI allocations must be represented in the funded company
 // exposure too; a pool cannot disappear from the accounting scenarios.
 for(const [tier,scope] of [['trial','trial'],['setup','setup'],['ended','post_cancellation']] as const){
  if(aiPolicy.fundedStores[tier]===0)continue;
  const item=review.fundedExposure!.cases[scope], aiCents=aiStoreCostCents(aiPolicy,tier,1);
  const cost=item?.worstCase?.costCeilings.ai;
  if(!item||item.maximumMonthlyCases===null||item.maximumMonthlyCases<aiPolicy.fundedStores[tier]||aiCents===null||typeof cost!=='number'||!Number.isSafeInteger(cost)||cost<aiCents)return false;
 }
 // Until an authenticated plan mix is bound to this review, fund enough
 // upload allocations for any mix of the reviewed paid customer base.
 if((["creator","pro","scale"] as const).some(tier=>uploadPolicy.fundedStores[tier]<review.companyBase!.reviewedPayingCustomers! || aiPolicy.fundedStores[tier]<review.companyBase!.reviewedPayingCustomers! || aiPolicy.storeMicroUsd[tier]<Math.max(...SUPPORTED_AI_MODELS.map(model=>aiPolicy.requestMicroUsd[model]))))return false;
 return REQUIRED_MARGIN_SCENARIOS.every(key=>{
  const scenario=review.scenarios[key]??null;
  const ceiling=BASE_PLAN_REVENUE_CEILINGS[key];
  if(ceiling!==undefined && (!scenario || typeof scenario.collectedRevenueCents!=="number" || scenario.collectedRevenueCents>ceiling))return false;
  if(ceiling!==undefined){
   const tier=key.startsWith("creator_")?"creator":key.startsWith("pro_")?"pro":"scale";
   const aiCents=aiStoreCostCents(aiPolicy,tier,key.includes("_year_")?12:1);
   const reviewedAi=scenario?.costCeilings?.ai;
   if(aiCents===null || typeof reviewedAi!=="number" || !Number.isSafeInteger(reviewedAi) || reviewedAi<aiCents)return false;
  }
  return assessCustomerWorstCase(scenarioWithPlanRoom(key,scenario)).approved;
 });
}
export function commercialPlansMayOpen(requested:boolean,review:CommercialMarginReview|null=CURRENT_COMMERCIAL_MARGIN_REVIEW):boolean{
 if(requested!==true)return false;
 review=commercialReviewData(review);
 if(review===null)return false;
 const commissionReady=!COMMISSION_PLANS_PUBLISHED||(COMMISSION_LIVE&&SHARE_PROVED_IN_TEST_MODE);
 const exposureReady=review!==null&&exposureBudgetConfiguration(CURRENT_EXPOSURE_BUDGET_POLICY,{termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:review.fundedExposure})!==null;
 const contractReady=review!==null&&contractFundingConfiguration(CURRENT_CONTRACT_FUNDING_POLICY,{termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review})!==null;
 const lifecycleReady=contractLifecycleReady();
 return requested===true&&commissionReady&&exposureReady&&contractReady&&lifecycleReady&&commercialMarginDataReady(review);
}


/** Descriptive accounting only. These figures never approve a customer or open sales. */
export const COMMERCIAL_PROFIT_SOURCES = [
 "plan_subscriptions", "add_ons", "email_packages", "captions",
 "network_and_sponsorship", "paid_recommendations", "list_validation",
 "referral_commissions", "training",
] as const;
export type CommercialProfitSource = typeof COMMERCIAL_PROFIT_SOURCES[number];
export type ProfitSourceAmounts = {
 /** Marktmorgen revenue only, never a creator's gross proceeds or an unpaid authorization. */
 revenueCents: number|null;
 variableCostsCents: number|null;
 allocatedFixedCostsCents: number|null;
 taxesCents: number|null;
 refundsCents: number|null;
 reservesCents: number|null;
 /** Dated provenance covers all costs, the most onerous taxes and the allocation method. */
 evidence: string;
};
export type CommercialProfitMixInput = {
 basis: "worst_case"|"reconciled_actual";
 interval: "month"|"year";
 period: string;
 currency: "USD";
 /** The entire LLC fixed cost for this SAME period, including Hazelsong. */
 companyFixedCostsCents: number|null;
 sources: Record<CommercialProfitSource, ProfitSourceAmounts|null>;
};
export type CommercialProfitMix = {
 basis: CommercialProfitMixInput["basis"]|null;
 interval: CommercialProfitMixInput["interval"]|null;
 period: string|null;
 rows: {source:CommercialProfitSource;netProfitCents:number|null;shareOfNetProfitBps:number|null}[];
 totalNetProfitCents:number|null;
 reason:"known"|"unknown"|"fixed_cost_allocation_mismatch"|"nonpositive_total";
};
const profitAmountKeys = [
 "revenueCents","variableCostsCents","allocatedFixedCostsCents","taxesCents","refundsCents","reservesCents",
] as const;
function profitCents(value:unknown):value is number {
 return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
}
function safeProfitNumber(value:bigint):number|null {
 return value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER)?null:Number(value);
}
/** A missing source is unknown, even when sales are closed. Explicit evidenced zero is supported.
 * Negative source profits remain negative; their share may be negative or exceed 100%.
 * Shares are truncated to one basis point and need not sum to exactly 10,000.
 */
export function commercialProfitMix(input:CommercialProfitMixInput|null):CommercialProfitMix {
 const result:CommercialProfitMix={
  basis:null,interval:null,period:null,
  rows:COMMERCIAL_PROFIT_SOURCES.map(source=>({source,netProfitCents:null,shareOfNetProfitBps:null})),
  totalNetProfitCents:null,reason:"unknown",
 };
 const encoded=canonicalFinancialSnapshot(input);
 if(encoded===null)return result;
 const data=JSON.parse(encoded) as CommercialProfitMixInput|null;
 if(!data||Array.isArray(data)||(data.basis!=="worst_case"&&data.basis!=="reconciled_actual")||
  (data.interval!=="month"&&data.interval!=="year")||data.currency!=="USD"||
  typeof data.period!=="string"||!data.period.trim()||
  !data.sources||Array.isArray(data.sources)||typeof data.sources!=="object"||
  Object.keys(data.sources).length!==COMMERCIAL_PROFIT_SOURCES.length||
  !COMMERCIAL_PROFIT_SOURCES.every(source=>Object.hasOwn(data.sources,source)))return result;
 result.basis=data.basis;result.interval=data.interval;result.period=data.period;
 let total=BigInt(0),fixed=BigInt(0),complete=true;
 for(const row of result.rows){
  const amounts=data.sources[row.source];
  if(!amounts||Array.isArray(amounts)||typeof amounts!=="object"||
   typeof amounts.evidence!=="string"||!amounts.evidence.trim()||
   !profitAmountKeys.every(key=>profitCents(amounts[key]))){complete=false;continue;}
  const net=BigInt(amounts.revenueCents!)-BigInt(amounts.variableCostsCents!)-
   BigInt(amounts.allocatedFixedCostsCents!)-BigInt(amounts.taxesCents!)-
   BigInt(amounts.refundsCents!)-BigInt(amounts.reservesCents!);
  row.netProfitCents=safeProfitNumber(net);
  if(row.netProfitCents===null)complete=false;
  total+=net;fixed+=BigInt(amounts.allocatedFixedCostsCents!);
 }
 if(!complete||!profitCents(data.companyFixedCostsCents))return result;
 if(fixed!==BigInt(data.companyFixedCostsCents)){result.reason="fixed_cost_allocation_mismatch";return result;}
 result.totalNetProfitCents=safeProfitNumber(total);
 if(result.totalNetProfitCents===null)return result;
 if(total<=BigInt(0)){result.reason="nonpositive_total";return result;}
 const shares=result.rows.map(row=>safeProfitNumber(BigInt(row.netProfitCents!)*BigInt(10000)/total));
 if(shares.some(share=>share===null)){result.totalNetProfitCents=null;return result;}
 result.rows.forEach((row,index)=>{row.shareOfNetProfitBps=shares[index];});
 result.reason="known";
 return result;
}
/** No reconciled accounting dataset or independently reviewed forecast exists yet. */
export const CURRENT_COMMERCIAL_PROFIT_MIX_INPUT:CommercialProfitMixInput|null=null;
