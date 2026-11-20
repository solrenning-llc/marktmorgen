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
  // In whole cents, never above the profit (floor), then IRPF and IOF each rounded up on its own, as
  // lib/receiving-costs.ts rounds them; no tax on a loss.
  return WORST_MONTH_TIERS.map((tier) => {
    const profitCents = Math.floor((netOf(tier, cycle) - worstCost(tier)) * 100 + 1e-9);
    const taxable = Math.max(0, profitCents);
    const taxCents = Math.ceil((taxable * MOST_CORRECT_READING.profitTaxBps) / 10_000) + Math.ceil((taxable * MOST_CORRECT_READING.incomingExchangeIofBps) / 10_000);
    return ((profitCents - taxCents) / 100).toFixed(2);
  });
}
