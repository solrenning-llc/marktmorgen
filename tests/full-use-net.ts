/**
 * One plan at full use, after every cost and every tax (moved here from tests/spend-floor.test.ts on 4 November
 * 2026, so tests/plan-margin.test.ts reads the same figures): its price, the costs the reviewed receiving model
 * allows under it, what receiving costs, its usage (every allowance, the AI and upload ceilings, what is kept after
 * it ends), the room left, and the unit after the taxes of complete synthetic dated TX evidence.
 */
import assert from "node:assert/strict";
import { PUBLISHED_PLAN_PRICES, type Cycle, type Tier } from "@/lib/plan";
import { maximumPretaxCostCents } from "@/lib/cost-envelope";
import { reviewedUnitUnder } from "@/lib/reviewed-receiving";
import { reviewedReceivingTaxInput } from "./reviewed-receiving-fixture";
import { syntheticTaxContext } from "./customer-tax-review-fixture";
import { aiCeilingUsd, perPaymentCost, uploadOpsUsd, worstCost } from "./plan-cost-model";

export const months = (cycle: Cycle) => (cycle === "year" ? 12 : 1);
/** The cost room the spend floor keeps under each plan (tests/margin-alignment-table.ts, roomKept): 25 cents a month, a dollar a year. */
export const roomOf = (cycle: Cycle) => (cycle === "year" ? 1 : 0.25);

export function fullUseNet(tier: Tier, cycle: Cycle) {
  const priceCents = PUBLISHED_PLAN_PRICES[tier][cycle];
  const paid = priceCents / 100;
  const monthly = worstCost(tier);
  const ai = aiCeilingUsd(tier), uploads = uploadOpsUsd(tier);
  const after = perPaymentCost(tier);
  const usageCents = Math.ceil(Math.round((months(cycle) * monthly + after) * 1e7) / 1e5);
  const input = reviewedReceivingTaxInput(priceCents, usageCents, syntheticTaxContext(tier + "_" + cycle + "_full", months(cycle) as 1 | 12));
  const unit = reviewedUnitUnder(priceCents, usageCents, input, true);
  assert.ok(unit);
  const allowed = maximumPretaxCostCents(unit.revenueCents, unit.taxCents)! / 100;
  const receiving = unit.totalCents / 100;
  const total = receiving + usageCents / 100;
  const other = monthly - ai - uploads;
  return { paid, allowed, receiving, other, ai, uploads, after, total, room: allowed - total, unit };
}
