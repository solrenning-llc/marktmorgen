import { hasPro, monthlyEmails, TIERS, type Tier } from "@/lib/plan";

/**
 * The pricing page group (lib/pricing-page-data.ts, PRICING_GROUPS) that lists the list-email allowance the check
 * measures; the calculator links "published allowances" there. tests/plan-fit-rules.test.ts holds it to the group
 * whose rows include "list-email", so a regrouped table fails the test instead of leaving a wrong link.
 */
export const PLAN_FIT_ALLOWANCES_GROUP = "email-and-workflows";

/** Inputs to the public plan-fit check. Text stays text until it is validated exactly. */
export type PlanFitInput = {
  monthlyListEmails: string;
  needsListEmail: boolean;
  needsCustomDomain: boolean;
  needsBrandingRemoval: boolean;
};

export type PlanFitResult =
  | { kind: "incomplete" }
  | { kind: "invalid" }
  | { kind: "fit"; tier: Tier; monthlyListEmails: number }
  | { kind: "no-fit"; monthlyListEmails: number; maximumMonthlyListEmails: number };

/**
 * The first unit of 266 [CI4]: recommend the least expensive plan that meets
 * the list-email allowance and the three Pro tools already built. This is
 * descriptive only; it never starts or changes a subscription.
 */
export function findPlanFit(input: PlanFitInput): PlanFitResult {
  if (input.monthlyListEmails === "") return { kind: "incomplete" };
  if (
    typeof input.monthlyListEmails !== "string" ||
    !/^\d+$/.test(input.monthlyListEmails) ||
    typeof input.needsListEmail !== "boolean" ||
    typeof input.needsCustomDomain !== "boolean" ||
    typeof input.needsBrandingRemoval !== "boolean"
  ) {
    return { kind: "invalid" };
  }

  const monthlyListEmails = Number(input.monthlyListEmails);
  if (!Number.isSafeInteger(monthlyListEmails) || monthlyListEmails < 0) {
    return { kind: "invalid" };
  }

  const needsPro = input.needsListEmail || input.needsCustomDomain || input.needsBrandingRemoval || monthlyListEmails > 0;
  for (const tier of TIERS) {
    if (needsPro && !hasPro(tier)) continue;
    if (monthlyEmails(tier) < monthlyListEmails) continue;
    return { kind: "fit", tier, monthlyListEmails };
  }

  return {
    kind: "no-fit",
    monthlyListEmails,
    maximumMonthlyListEmails: monthlyEmails(TIERS[TIERS.length - 1]),
  };
}
