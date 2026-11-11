/**
 * What opening waits on, read from the gates themselves.
 *
 * lib/opening.ts opens plans with one AND: the owner's request inside the
 * commercial review, then the tax gate setting, the deemed-supplier records
 * and the Stripe platform eligibility review. This lists the same conditions,
 * each with the answer its own function gives today, who has to act and what
 * it needs, so the owner's summary of what is missing (AV1 step 12,
 * docs/opening-readiness-status-*.md) is read from the code instead of
 * typed from memory. tests/opening-readiness.test.ts fails when this list and
 * lib/opening.ts disagree.
 *
 * It only reads. It changes no flag, review, record, price, limit or
 * commission, and calls no provider. A "ready" here is the gate's own answer,
 * never a certification of margin, tax or legal compliance.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { commercialPlansMayOpen, CURRENT_COMMERCIAL_MARGIN_REVIEW } from "@/lib/commercial-margin";
import { taxGateValid } from "@/lib/tax-gate";
import { deemedSupplierProblems, deemedSupplierReady } from "@/lib/deemed-supplier";
import { stripePlatformEligibilityReady } from "@/lib/stripe-platform-eligibility";
import { CONTRACT_ADMISSION_COVERAGE, CORE_CONTRACT_ADMISSION_KEYS, CURRENT_CONTRACT_FUNDING_POLICY, contractLifecycleReady } from "@/lib/contract-funding-rules";
import { CURRENT_EXPOSURE_BUDGET_POLICY } from "@/lib/exposure-budget-policy";
import { COMMISSION_LIVE, COMMISSION_PLANS_PUBLISHED } from "@/lib/plan";
import { SHARE_PROVED_IN_TEST_MODE } from "@/lib/platform-share";

/** Who has to act before a condition can be ready. */
export type OpeningActor = "owner" | "agents" | "agents, then the owner";

export type OpeningCondition = Readonly<{
  id: "ownerRequest" | "commercialReview" | "taxGate" | "deemedSupplier" | "stripePlatform";
  /** true or false is the gate's own answer; null only for the owner's request when the gates cannot tell. */
  ready: boolean | null;
  who: OpeningActor;
  where: string;
  needs: string;
}>;

/** The gates of PLANS_ON_SALE, in the order lib/opening.ts ANDs them, by the function each one calls. */
export const OPENING_GATES = Object.freeze([
  {
    id: "commercialReview",
    check: "commercialPlansMayOpen",
    who: "agents, then the owner",
    where: "lib/commercial-margin.ts",
    needs: "Core contract coverage built and tested, then the exposure budget, contract funding and commercial margin reviews filled with proven figures only, and approved by the owner.",
    ready: () => commercialPlansMayOpen(true),
  },
  {
    id: "taxGate",
    check: "taxGateValid",
    who: "agents",
    where: "lib/tax-gate.ts",
    needs: "A gate reading that sales may be judged on (TX policy). Scoped tax evidence is still required inside the commercial review.",
    ready: () => taxGateValid(),
  },
  {
    id: "deemedSupplier",
    check: "deemedSupplierReady",
    who: "agents, then the owner",
    where: "lib/deemed-supplier.ts",
    needs: "For EU, UK, US and other: a built and tested treatment, collecting the tax or refusing that jurisdiction's consumers at checkout before any charge, then its record.",
    ready: () => deemedSupplierReady(),
  },
  {
    id: "stripePlatform",
    check: "stripePlatformEligibilityReady",
    who: "owner",
    where: "lib/stripe-platform-eligibility.ts",
    needs: "A US Stripe platform account in the LLC's name and dated proof of direct charges for creators in the US, Canada, the UK and Europe.",
    ready: () => stripePlatformEligibilityReady(),
  },
] as const satisfies readonly {
  id: OpeningCondition["id"];
  check: string;
  who: OpeningActor;
  where: string;
  needs: string;
  ready: () => boolean;
}[]);

/** The parts commercialPlansMayOpen needs together. "Recorded" is necessary, not sufficient. */
export const COMMERCIAL_REVIEW_PARTS = Object.freeze([
  { id: "commission", needs: "No commission plan published, or the platform share live and proved in test mode.", ready: () => !COMMISSION_PLANS_PUBLISHED || (COMMISSION_LIVE && SHARE_PROVED_IN_TEST_MODE) },
  { id: "contractLifecycle", needs: "Every core key of CONTRACT_ADMISSION_COVERAGE true (lib/contract-funding-rules.ts).", ready: () => contractLifecycleReady() },
  { id: "exposureBudget", needs: "CURRENT_EXPOSURE_BUDGET_POLICY recorded from a reviewed, dated budget (lib/exposure-budget-policy.ts).", ready: () => CURRENT_EXPOSURE_BUDGET_POLICY !== null },
  { id: "contractFunding", needs: "CURRENT_CONTRACT_FUNDING_POLICY recorded from reviewed reserves and funded grants (lib/contract-funding-rules.ts).", ready: () => CURRENT_CONTRACT_FUNDING_POLICY !== null },
  { id: "marginReview", needs: "CURRENT_COMMERCIAL_MARGIN_REVIEW recorded from proven per-customer worst cases (lib/commercial-margin.ts).", ready: () => CURRENT_COMMERCIAL_MARGIN_REVIEW !== null },
] as const);

/**
 * Every condition of opening with its state today. The owner's request is
 * not exported by lib/opening.ts and is never guessed: plans on sale means it
 * was given; every gate ready while plans are closed means it was not;
 * otherwise the gates cannot tell, and it says null.
 */
export function openingReadiness(): readonly OpeningCondition[] {
  const gates: OpeningCondition[] = OPENING_GATES.map((gate) => ({ id: gate.id, ready: gate.ready(), who: gate.who, where: gate.where, needs: gate.needs }));
  const gatesReady = gates.every((gate) => gate.ready === true);
  const request: OpeningCondition = {
    id: "ownerRequest",
    ready: PLANS_ON_SALE ? true : gatesReady ? false : null,
    who: "owner",
    where: "lib/opening.ts (OPENING_REQUESTED)",
    needs: "The owner's request, given last, once every gate is ready and the minimum customer base is computed and shown.",
  };
  return Object.freeze([request, ...gates]);
}

/** The reasons behind the two gates with more than one part. */
export function openingReadinessDetails(): Readonly<{
  commercialReview: readonly Readonly<{ id: (typeof COMMERCIAL_REVIEW_PARTS)[number]["id"]; ready: boolean; needs: string }>[];
  missingCoreCoverage: readonly string[];
  deemedSupplierProblems: readonly string[];
}> {
  return Object.freeze({
    commercialReview: Object.freeze(COMMERCIAL_REVIEW_PARTS.map((row) => Object.freeze({ id: row.id, ready: row.ready(), needs: row.needs }))),
    missingCoreCoverage: Object.freeze(CORE_CONTRACT_ADMISSION_KEYS.filter((key) => CONTRACT_ADMISSION_COVERAGE[key] !== true)),
    deemedSupplierProblems: Object.freeze(deemedSupplierProblems()),
  });
}
