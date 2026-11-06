import {planPaymentDisputeFixture, zeroExposureFixture } from './margin-test-fixtures';
import {fundedCustomerWithAi} from './margin-test-fixtures';
import { BASE_PLAN_REVENUE_CEILINGS, CURRENT_COMMERCIAL_TERMS, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, commercialMarginReady, REQUIRED_MARGIN_SCENARIOS, type CommercialMarginReview } from "@/lib/commercial-margin";
import { STORAGE_BRAKE_BYTES } from "@/lib/storage-rules";
import { STORAGE_BRAKE_BYTES as UPLOAD_STORAGE_BYTES } from "@/lib/storage-quota";
import { AI_REQUEST_LIMITS, SUPPORTED_AI_MODELS } from "@/lib/ai-request-rules";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { VISITS_INCLUDED } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { PAID_VIDEO_HOURS, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { done, is } from "./check";
const review = (): CommercialMarginReview => ({
 companyBase:{monthlyFixedCostsCeilingCents:0,monthlyFixedTaxesCeilingCents:0,allFixedCostsBounded:true,allFixedTaxesReviewed:true,fixedCostsEvidence:"TEST ONLY: zero fixed costs",fixedTaxEvidence:"TEST ONLY: zero fixed taxes",reviewedPayingCustomers:1},planPaymentDisputes:planPaymentDisputeFixture(),priceAndRightsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,
 taxEvidence: "TEST ONLY: hypothetical taxes",
 costAndLimitEvidence: "TEST ONLY: hypothetical funded limits",
 allocatedFixedCostsVerified:true, fundedExposure:zeroExposureFixture(),
 prepaidUsageEnforced: true,
 scenarios: Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map(key => { const gross = BASE_PLAN_REVENUE_CEILINGS[key] ?? 10000; return [key, fundedCustomerWithAi(gross,Math.floor(gross*.65),12,key)]; })),
});
is("hypothetical current review passes calculation", commercialMarginReady(review()), true);
is("actual review remains absent", commercialMarginReady(), false);
is("upload and review use one storage ceiling", UPLOAD_STORAGE_BYTES, STORAGE_BRAKE_BYTES);
is("default storage uses the smallest explicit paid tier", STORAGE_BRAKE_BYTES, 5 * 1024 * 1024 * 1024);
is("review uses actual AI entitlements", CURRENT_COMMERCIAL_TERMS.ai.monthly, AI_MONTHLY);
is("review uses actual visit entitlements", CURRENT_COMMERCIAL_TERMS.traffic.included, VISITS_INCLUDED);
is("review uses actual order entitlements", CURRENT_COMMERCIAL_TERMS.orders.included, ORDERS_INCLUDED);
is("review captures actual per-tier playback thresholds", CURRENT_COMMERCIAL_TERMS.video.paidHoursByTier, PAID_VIDEO_HOURS);
is("review captures reduced trial playback", CURRENT_COMMERCIAL_TERMS.video.trialSeconds, TRIAL_VIDEO_SECONDS);
function checkLeaves(value: unknown, path: string[] = []) {
 if (value !== null && typeof value === "object") {
  for (const [key, child] of Object.entries(value)) checkLeaves(child, [...path, key]);
  return;
 }
 const changed = JSON.parse(CURRENT_PRICE_AND_RIGHTS_SNAPSHOT);
 let parent = changed;
 for (const key of path.slice(0, -1)) parent = parent[key];
 parent[path[path.length - 1]] = typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : String(value) + " changed";
 is("old review rejected after " + path.join(".") + " changes", commercialMarginReady({ ...review(), priceAndRightsSnapshot: JSON.stringify(changed) }), false);
}
is("review captures enforced AI request limits", CURRENT_COMMERCIAL_TERMS.ai.requestLimits, AI_REQUEST_LIMITS);
is("review captures allowed provider models", CURRENT_COMMERCIAL_TERMS.ai.supportedModels, SUPPORTED_AI_MODELS);
checkLeaves(CURRENT_COMMERCIAL_TERMS);
const legacy = JSON.stringify({ prices: CURRENT_COMMERCIAL_TERMS.prices, commission: CURRENT_COMMERCIAL_TERMS.commission, trialDays: CURRENT_COMMERCIAL_TERMS.trialDays });
is("partial legacy contract cannot approve current rights", commercialMarginReady({ ...review(), priceAndRightsSnapshot: legacy }), false);

const withoutDisputeEvidence=review();
delete withoutDisputeEvidence.planPaymentDisputes;
is("a legacy review cannot approve unreviewed lost-plan-payment liabilities",commercialMarginReady(withoutDisputeEvidence),false);
const unknownDisputeFee=review();
unknownDisputeFee.planPaymentDisputes!.creator_month!.maximumTotalFeesCents=null;
is("unknown lost-dispute fees are not zero",commercialMarginReady(unknownDisputeFee),false);
const omittedDisputeFee=review();
omittedDisputeFee.planPaymentDisputes!.creator_month!.maximumTotalFeesCents=30;
is("a reviewed fee absent from the per-customer expense ceiling is rejected",commercialMarginReady(omittedDisputeFee),false);
omittedDisputeFee.scenarios.creator_month_full!.costCeilings.refundAndDisputeFees=30;
is("an explicitly represented fee remains calculable without opening sales",commercialMarginReady(omittedDisputeFee),true);
done();
