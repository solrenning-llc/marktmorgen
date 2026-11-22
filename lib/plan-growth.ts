/**
 * "Grow without switching" (245 [SP2], unit 1; added 12 November 2026): what each larger plan adds to the one below
 * it, read from the very rows the pricing page shows (lib/pricing-page-data.ts, PRICING_GROUPS), keeping only the
 * rows whose value changes from one plan to the next. No figure is typed here: a price or a limit changed in
 * lib/plan.ts changes this page with it. Server-side data, like the pricing page's.
 */
import { PRICING_GROUPS, PRICING_PLANS } from "@/lib/pricing-page-data";
import { TIERS, type Tier } from "@/lib/plan";

export type GrowthLine = { group: string; label: string; from: string; to: string; note?: string };
export type GrowthStep = {
  from: Tier;
  to: Tier;
  fromTitle: string;
  toTitle: string;
  toPrice: { monthly: string; annual: string };
  lines: GrowthLine[];
  /** Each group's own note on its period, as the pricing page says it under the group's heading. */
  periods: Record<string, string>;
  /** What the larger plan switches on that no row of the table counts (lib/plan.ts canUse): said beside the rows. */
  features: string[];
};

/**
 * What Studio switches on that the table has no row for: the store on its own domain (only where this deployment
 * offers domains, as the pricing page's card says it) and our name off the foot of the page (canUse "domain" and
 * "branding", lib/plan.ts). Scale has them too, so they are said on the step up from Store only.
 */
function featuresOf(from: Tier, to: Tier, domains: boolean): string[] {
  if (from !== "creator" || to === "creator") return [];
  return [...(domains ? ["Your store on your own domain, with its certificate handled for you"] : []), "Our name off the foot of your page, so it carries yours and nothing of ours"];
}

/** Each step up, Store to Studio and Studio to Scale, with every row of the pricing table that changes on it. */
export function growthSteps(domains: boolean): GrowthStep[] {
  const title = (tier: Tier) => PRICING_PLANS.find((p) => p.tier === tier)!.title;
  const steps: GrowthStep[] = [];
  for (let i = 1; i < TIERS.length; i += 1) {
    const from = TIERS[i - 1];
    const to = TIERS[i];
    const plan = PRICING_PLANS.find((p) => p.tier === to)!;
    const lines = PRICING_GROUPS.flatMap((group) =>
      group.rows.filter((row) => row.values[from] !== row.values[to]).map((row) => ({ group: group.title, label: row.label, from: row.values[from], to: row.values[to], ...(row.note ? { note: row.note } : {}) })),
    );
    const periods = Object.fromEntries(PRICING_GROUPS.map((group) => [group.title, group.period]));
    steps.push({ from, to, fromTitle: title(from), toTitle: title(to), toPrice: { monthly: plan.monthly, annual: plan.annual }, lines, periods, features: featuresOf(from, to, domains) });
  }
  return steps;
}
