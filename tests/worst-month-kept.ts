/**
 * What each plan keeps in its worst month under the LC rule's reading (owner, 1 November 2026): a month's receipts after
 * every fee and reserve (netOf, lib/receiving-costs.ts), less every cost line at its limit (worstCost,
 * tests/plan-cost-registry.ts), then IRPF 15% and IOF 0.38% on that profit (MOST_CORRECT_READING), the IOF taken on the
 * profit sent home before the IRPF. One formula for tests/switch-keeps-window.test.ts (section 11, above zero) and for
 * docs/margin-alignment-2026-10-18.md (the exact figures, held by its staleness test; Claude 4's LOW on #4854).
 */
import { MOST_CORRECT_READING } from "@/lib/receiving-costs";
import type { Cycle } from "@/lib/plan";
import { netOf, worstCost } from "./plan-cost-model";

export const WORST_MONTH_TIERS = ["creator", "pro", "scale"] as const;

/** Store, Studio and Scale, in dollars to the cent, on a monthly plan or in a month of a yearly one (a twelfth paid). */
export function worstMonthKept(cycle: Cycle): string[] {
  const taxShare = (MOST_CORRECT_READING.profitTaxBps + MOST_CORRECT_READING.incomingExchangeIofBps) / 10_000;
  return WORST_MONTH_TIERS.map((tier) => ((netOf(tier, cycle) - worstCost(tier)) * (1 - taxShare)).toFixed(2));
}
