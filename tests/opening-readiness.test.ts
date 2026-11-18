/**
 * One list of what opening waits on, read from the gates themselves.
 *
 * lib/opening.ts decides whether a plan can be started with one AND of the
 * owner's request and four gates. lib/opening-readiness.ts lists the same
 * conditions, each with the state its own function returns today, who has
 * to act, and where it lives, so the owner's summary of what is missing
 * (docs/opening-readiness-status-*.md, AV1 step 12) is never typed from
 * memory. These checks fail when the list and lib/opening.ts disagree: a
 * gate added or removed in one and not the other, a state that is not the
 * gate's own answer, or a list that says everything is ready while plans are
 * still closed. Nothing here changes a flag, a review or a record.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { commercialMarginDataReady, commercialPlansMayOpen, commercialReviewData, CURRENT_COMMERCIAL_MARGIN_REVIEW, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, type CommercialMarginReview } from "@/lib/commercial-margin";
import { taxGateValid } from "@/lib/tax-gate";
import { deemedSupplierProblems, deemedSupplierReady } from "@/lib/deemed-supplier";
import { stripePlatformEligibilityReady } from "@/lib/stripe-platform-eligibility";
import { CONTRACT_ADMISSION_COVERAGE, CORE_CONTRACT_ADMISSION_KEYS, CURRENT_CONTRACT_FUNDING_POLICY, type ContractFundingPolicy, contractFundingConfiguration, contractLifecycleReady } from "@/lib/contract-funding-rules";
import { CURRENT_EXPOSURE_BUDGET_POLICY, type ExposureBudgetPolicy, exposureBudgetConfiguration } from "@/lib/exposure-budget-policy";
import { COMMISSION_LIVE, COMMISSION_PLANS_PUBLISHED } from "@/lib/plan";
import { SHARE_PROVED_IN_TEST_MODE } from "@/lib/platform-share";
import {
  OPENING_GATES,
  COMMERCIAL_REVIEW_PARTS,
  commercialReviewParts,
  openingReadiness,
  openingReadinessDetails,
} from "@/lib/opening-readiness";
import { done, is, part } from "./check";
import { CURRENT_PRICE_AND_RIGHTS_SNAPSHOT as SNAPSHOT, REQUIRED_MARGIN_SCENARIOS, BASE_PLAN_REVENUE_CEILINGS } from "@/lib/commercial-margin";
import { fundedCustomerWithAi, planPaymentDisputeFixture, zeroExposureFixture, zeroFixedCompanyFixture } from "./margin-test-fixtures";

const others = () => openingReadiness().filter((condition) => condition.id !== "ownerRequest");

const root = process.cwd();
const source = readFileSync(join(root, "lib/opening.ts"), "utf8");

part("The list names exactly the gates lib/opening.ts ANDs together");
const line = source.match(/export const PLANS_ON_SALE: boolean =([^;]+);/);
is("PLANS_ON_SALE is still one expression", line !== null, true);
const called = (line?.[1] ?? "")
  .split("&&")
  .map((term) => term.trim().match(/^([A-Za-z]\w*)\(/)?.[1] ?? `unreadable: ${term.trim()}`);
is("every term of it is a call to a gate", called.every((name) => !name.startsWith("unreadable")), true);
is("the list's gates are those calls, in the same order", OPENING_GATES.map((gate) => gate.check), called);
is("the owner's request goes into the commercial review, as the list says", /commercialPlansMayOpen\(OPENING_REQUESTED\)/.test(line?.[1] ?? ""), true);
is("and OPENING_REQUESTED is declared once, by the owner, in lib/opening.ts", (source.match(/const OPENING_REQUESTED: boolean = (true|false);/g) ?? []).length, 1);

part("Each state is the gate's own answer");
const byId = Object.fromEntries(openingReadiness().map((condition) => [condition.id, condition]));
is("commercial review", byId.commercialReview?.ready, commercialPlansMayOpen(true));
is("tax gate setting", byId.taxGate?.ready, taxGateValid());
is("deemed supplier records", byId.deemedSupplier?.ready, deemedSupplierReady());
is("Stripe platform eligibility", byId.stripePlatform?.ready, stripePlatformEligibilityReady());
is("the deemed-supplier reasons are the gate's own", openingReadinessDetails().deemedSupplierProblems, deemedSupplierProblems());

part("The owner's request is read, never guessed");
const requestedInSource = /const OPENING_REQUESTED: boolean = true;/.test(source);
const allGates = Object.fromEntries(OPENING_GATES.map((gate) => [gate.id, true])) as Record<(typeof OPENING_GATES)[number]["id"], boolean>;
const requestOf = (state: Parameters<typeof openingReadiness>[0]) => openingReadiness(state).find((condition) => condition.id === "ownerRequest")?.ready;
is("plans on sale: the request was given", requestOf({ plansOnSale: true, gates: allGates }), true);
is("every gate ready while plans are closed: the request was not given", requestOf({ plansOnSale: false, gates: allGates }), false);
for (const gate of OPENING_GATES) {
  is(`${gate.id} not ready while plans are closed: the gates cannot tell, so unknown`, requestOf({ plansOnSale: false, gates: { ...allGates, [gate.id]: false } }), null);
}
is("today, with the real gates", byId.ownerRequest?.ready, PLANS_ON_SALE ? true : others().every((condition) => condition.ready === true) ? false : null);
is("and it never says requested while the source says false", byId.ownerRequest?.ready === true && !requestedInSource, false);
is("while unknown, it says it does not read OPENING_REQUESTED, and where it is", byId.ownerRequest?.ready !== null || /not read here/i.test(byId.ownerRequest?.needs ?? ""), true);
is("an injected answer replaces only that gate's state in the list", openingReadiness({ gates: { taxGate: !taxGateValid() } }).find((condition) => condition.id === "taxGate")?.ready, !taxGateValid());

part("Ready everywhere exactly when plans are on sale");
is("every condition ready ⇔ PLANS_ON_SALE", openingReadiness().every((condition) => condition.ready === true), PLANS_ON_SALE);
if (!PLANS_ON_SALE) {
  const waiting = openingReadiness().filter((condition) => condition.ready !== true);
  is("closed: at least one condition says what it waits on", waiting.length > 0, true);
  is("and each waiting condition names who acts and what it needs", waiting.every((condition) => condition.who.length > 0 && condition.needs.trim().length > 0), true);
}

part("Inside the commercial review");
const parts = Object.fromEntries(openingReadinessDetails().commercialReview.map((row) => [row.id, row]));
is("the parts are listed once each", openingReadinessDetails().commercialReview.map((row) => row.id), COMMERCIAL_REVIEW_PARTS.map((row) => row.id));
is("commission", parts.commission?.ready, !COMMISSION_PLANS_PUBLISHED || (COMMISSION_LIVE && SHARE_PROVED_IN_TEST_MODE));
is("contract lifecycle", parts.contractLifecycle?.ready, contractLifecycleReady());
// Each part is the gate's own check (commercialPlansMayOpen in lib/commercial-margin.ts), never only "recorded" (reviews of #3665).
const reviewed = commercialReviewData(CURRENT_COMMERCIAL_MARGIN_REVIEW);
is("exposure budget policy accepted against the current terms", parts.exposureBudget?.ready, reviewed !== null && exposureBudgetConfiguration(CURRENT_EXPOSURE_BUDGET_POLICY, { termsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, review: reviewed.fundedExposure }) !== null);
is("contract funding policy accepted against the current terms", parts.contractFunding?.ready, reviewed !== null && contractFundingConfiguration(CURRENT_CONTRACT_FUNDING_POLICY, { termsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, review: reviewed }) !== null);
is("commercial margin review accepted, with every worst case approved", parts.marginReview?.ready, reviewed !== null && commercialMarginDataReady(reviewed));
is("each part also says whether its record exists at all", [parts.exposureBudget?.recorded, parts.contractFunding?.recorded, parts.marginReview?.recorded], [CURRENT_EXPOSURE_BUDGET_POLICY !== null, CURRENT_CONTRACT_FUNDING_POLICY !== null, CURRENT_COMMERCIAL_MARGIN_REVIEW !== null]);
is(
  "the missing core coverages are the false ones in CONTRACT_ADMISSION_COVERAGE",
  openingReadinessDetails().missingCoreCoverage,
  CORE_CONTRACT_ADMISSION_KEYS.filter((key) => CONTRACT_ADMISSION_COVERAGE[key] !== true),
);
is(
  "the commercial review is ready exactly when every part is: a false gate always shows a false part",
  commercialPlansMayOpen(true),
  openingReadinessDetails().commercialReview.every((row) => row.ready === true),
);

part("A record that exists but fails its own check is never ready (Codex G and Claude 3 on #3665, MEDIUM)");
{
  // Synthetic records, recorded but stale or incomplete: present, so "recorded" is true, and refused by the gate's own checks.
  const staleReview = { priceAndRightsSnapshot: "stale" } as unknown as CommercialMarginReview;
  const staleExposure = { reviewId: "stale-review", termsSnapshot: "stale", review: {}, reservedFundsCents: 1, reserveEvidence: "synthetic" } as unknown as ExposureBudgetPolicy;
  const staleContract = { reviewId: "stale-review", financialSnapshot: "stale", fundedGrants: {} } as unknown as ContractFundingPolicy;
  const rows = commercialReviewParts({ review: staleReview, exposure: staleExposure, contract: staleContract });
  const by = Object.fromEntries(rows.map((row) => [row.id, row]));
  is("all three are recorded", [by.exposureBudget?.recorded, by.contractFunding?.recorded, by.marginReview?.recorded], [true, true, true]);
  is("and none of them is ready, because the gate refuses each", [by.exposureBudget?.ready, by.contractFunding?.ready, by.marginReview?.ready], [false, false, false]);
  is("the gate itself agrees: it would not open on that review", commercialPlansMayOpen(true, staleReview), false);
  is("nothing recorded reads as not ready either", commercialReviewParts({ review: null, exposure: null, contract: null }).filter((row) => row.recorded !== undefined).map((row) => [row.recorded, row.ready]), [[false, false], [false, false], [false, false]]);
}

part("With a review the gate accepts, the exposure and contract validators decide (Claude 1 on #3665 at c7c9db5, LOW)");
{
  // Synthetic, same shape as tests/net-margin.test.ts: a review commercialReviewData accepts, so neither part stops at the parse.
  const accepted = {
    companyBase: zeroFixedCompanyFixture,
    planPaymentDisputes: planPaymentDisputeFixture(),
    priceAndRightsSnapshot: SNAPSHOT,
    taxEvidence: "TEST ONLY: hypothetical ceilings",
    costAndLimitEvidence: "TEST ONLY: hypothetical enforced limits",
    allocatedFixedCostsVerified: true,
    fundedExposure: zeroExposureFixture(),
    prepaidUsageEnforced: true,
    scenarios: Object.fromEntries(REQUIRED_MARGIN_SCENARIOS.map((key) => { const gross = BASE_PLAN_REVENUE_CEILINGS[key] ?? 10000; return [key, fundedCustomerWithAi(gross, Math.floor(gross * 0.65), 12, key)]; })),
  } as unknown as CommercialMarginReview;
  is("the synthetic review passes the gate's own parse", commercialReviewData(accepted) !== null, true);
  const staleExposure = { reviewId: "stale-review", termsSnapshot: "stale", review: {}, reservedFundsCents: 1, reserveEvidence: "synthetic" } as unknown as ExposureBudgetPolicy;
  const staleContract = { reviewId: "stale-review", financialSnapshot: "stale", fundedGrants: {} } as unknown as ContractFundingPolicy;
  const by = Object.fromEntries(commercialReviewParts({ review: accepted, exposure: staleExposure, contract: staleContract }).map((row) => [row.id, row]));
  is("a stale exposure budget policy is recorded and not ready", [by.exposureBudget?.recorded, by.exposureBudget?.ready], [true, false]);
  is("a stale contract funding policy is recorded and not ready", [by.contractFunding?.recorded, by.contractFunding?.ready], [true, false]);
  is("each is exactly its validator's answer on that review", [by.exposureBudget?.ready, by.contractFunding?.ready], [exposureBudgetConfiguration(staleExposure, { termsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, review: commercialReviewData(accepted)!.fundedExposure }) !== null, contractFundingConfiguration(staleContract, { termsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, review: commercialReviewData(accepted)! }) !== null]);
}

part("The owner's dated summary names every gate");
const summaries = readdirSync(join(root, "docs")).filter((name) => /^opening-readiness-status-\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort();
is("there is a dated summary", summaries.length > 0, true);
const latest = summaries.length ? readFileSync(join(root, "docs", summaries[summaries.length - 1]), "utf8") : "";
is(
  "the newest one names each gate's function and OPENING_REQUESTED",
  [...OPENING_GATES.map((gate) => gate.check), "OPENING_REQUESTED"].filter((name) => !latest.includes(name)),
  [],
);

done();
