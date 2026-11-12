/**
 * "Grow without switching" (245 [SP2], unit 1; added 12 November 2026): what each larger plan adds to the one below
 * it, read from the very rows the pricing page shows (lib/pricing-page-data.ts, PRICING_GROUPS), keeping only the
 * rows whose value changes from one plan to the next. No figure is typed here: a price or a limit changed in
 * lib/plan.ts changes this page with it. Server-side data, like the pricing page's.
 */
import { PRICING_GROUPS, PRICING_PLANS } from "@/lib/pricing-page-data";
import { TIERS, type Tier } from "@/lib/plan";

export type GrowthLine = { group: string; label: string; from: string; to: string };
export type GrowthStep = { from: Tier; to: Tier; fromTitle: string; toTitle: string; toPrice: { monthly: string; annual: string }; lines: GrowthLine[] };

/** Each step up, Store to Studio and Studio to Scale, with every row of the pricing table that changes on it. */
export function growthSteps(): GrowthStep[] {
  const title = (tier: Tier) => PRICING_PLANS.find((p) => p.tier === tier)!.title;
  const steps: GrowthStep[] = [];
  for (let i = 1; i < TIERS.length; i += 1) {
    const from = TIERS[i - 1];
    const to = TIERS[i];
    const plan = PRICING_PLANS.find((p) => p.tier === to)!;
    const lines = PRICING_GROUPS.flatMap((group) =>
      group.rows.filter((row) => row.values[from] !== row.values[to]).map((row) => ({ group: group.title, label: row.label, from: row.values[from], to: row.values[to] })),
    );
    steps.push({ from, to, fromTitle: title(from), toTitle: title(to), toPrice: { monthly: plan.monthly, annual: plan.annual }, lines });
  }
  return steps;
}
