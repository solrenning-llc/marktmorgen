/** MR27Oct: registered full-use cost checks with complete synthetic dated TX evidence through the real adapter.
 * Unknown costs outside this registry remain unapproved; no model result opens sales.
 * Existing25c monthly/100c annual cost room and every AI/upload entitlement are preserved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLISHED_PLAN_PRICES, TIERS, type Cycle, type Tier } from "@/lib/plan";
import {maximumPretaxCostCents} from "@/lib/cost-envelope";
import {reviewedUnitUnder} from "@/lib/reviewed-receiving";
import {reviewedReceivingTaxInput} from "./reviewed-receiving-fixture";
import {syntheticTaxContext} from "./customer-tax-review-fixture";
import { commercialMarginReady } from "@/lib/commercial-margin";
import { AUTOMATIC_AI_STORE_MICRO_USD, currentAiSpendPolicy } from "@/lib/ai-spend-policy";
import { currentUploadBudgetPolicy } from "@/lib/upload-budget-policy";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { ANSWERS_MONTHLY } from "@/lib/answers-rules";
import { ANSWER_MICRO_USD, WRITING_JOB_MICRO_USD } from "@/lib/spend-cost-table";
import { PLANS_ON_SALE } from "@/lib/opening";
import { aiCeilingUsd, perPaymentCost, uploadOpsUsd, worstCost, worstLines } from "./plan-cost-model";

const months = (cycle: Cycle) => (cycle === "year" ? 12 : 1);
function sum(tier: Tier, cycle: Cycle) {
  const priceCents = PUBLISHED_PLAN_PRICES[tier][cycle];
  const paid = priceCents / 100;
  const monthly = worstCost(tier);
  const ai = aiCeilingUsd(tier), uploads = uploadOpsUsd(tier);
  const after = perPaymentCost(tier);
  const usageCents = Math.ceil(Math.round((months(cycle) * monthly + after) * 1e7) / 1e5);
  const input=reviewedReceivingTaxInput(priceCents,usageCents,syntheticTaxContext(tier+'_'+cycle+'_full',months(cycle) as 1|12));
  const unit=reviewedUnitUnder(priceCents,usageCents,input,true);assert.ok(unit);
  const allowed=maximumPretaxCostCents(unit.revenueCents,unit.taxCents)!/100;
  const receiving = unit.totalCents / 100;
  const total = receiving + usageCents / 100;
  const other = monthly - ai - uploads;
  return { paid, allowed, receiving, other, ai, uploads, after, total, room: allowed - total, unit };
}

test("each plan's AI ceiling is its published writing jobs and answers at the priced units", () => {
  for (const tier of TIERS) assert.equal(AUTOMATIC_AI_STORE_MICRO_USD[tier], AI_MONTHLY[tier] * WRITING_JOB_MICRO_USD + ANSWERS_MONTHLY[tier] * ANSWER_MICRO_USD);
  const ai = currentAiSpendPolicy()!, uploads = currentUploadBudgetPolicy()!;
  for (const tier of TIERS) assert.equal(ai.storeMicroUsd[tier], AUTOMATIC_AI_STORE_MICRO_USD[tier]);
  for (const scope of ["trial", "setup", "ended"] as const) {
    assert.equal(ai.storeMicroUsd[scope], 0);
    assert.equal(ai.fundedStores[scope], 0);
    assert.deepEqual(uploads.perStore[scope], { opens: 0, authorizedBytes: 0, controlRequests: 0 });
    assert.equal(uploads.fundedStores[scope], 0);
  }
});

for (const tier of TIERS) for (const cycle of ["month", "year"] as const) {
  const name = `${tier}, ${cycle}`;
  test(`${name}: every allowance used in full, the AI and upload ceilings included, keeps positive modeled net with complete dated TX books/operations/FX`, () => {
    const row = sum(tier, cycle);
    console.log(`${name}: paid $${row.paid.toFixed(2)}, costs allowed $${row.allowed.toFixed(4)}; receiving $${row.receiving.toFixed(4)} + ${months(cycle)} x ($${row.other.toFixed(4)} other + $${row.ai.toFixed(4)} AI + $${row.uploads.toFixed(4)} uploads) + $${row.after.toFixed(4)} kept after the plan ends = $${row.total.toFixed(4)}; room $${row.room.toFixed(4)}; net ${(row.unit.netBps / 100).toFixed(2)}%`);
    // The sums agree with the cost envelope: within a cent of rounding, the costs allowed are the receiving model's own budget.
    assert.ok(Math.abs(row.allowed * 100 - (row.unit.usageRoomCents + row.unit.totalCents)) <= 1, `${name}: the envelope and the receiving model disagree`);
    assert.ok(row.unit.meetsFloor && row.unit.netCents > 0, `${name}: nonpositive full-use registered net`);
    assert.ok(row.total <= row.allowed, `${name} costs exceed its positive-profit budget`);
    assert.equal(PLANS_ON_SALE, false);
  });
}

test("every current plan keeps its unchanged cost room on both cycles, and Store still without AI", () => {
  // MR changes the target only: buffers and published rights do not shrink.
  assert.equal(AUTOMATIC_AI_STORE_MICRO_USD.creator, 0);
  for (const tier of TIERS) for (const cycle of ["month", "year"] as const) {
    const row = sum(tier, cycle);
    assert.ok(row.room >= (cycle === "year" ? 1 : 0.25), `${tier}, ${cycle}: room $${row.room.toFixed(4)}`);
  }
});

test("missing real commercial review remains closed despite modeled positive units", () => {
  assert.equal(commercialMarginReady(), false); assert.equal(PLANS_ON_SALE, false);
});

test("the worst month, line by line", () => {
  for (const tier of TIERS) {
    const lines = Object.entries(worstLines(tier)).map(([id, usd]) => `${id} $${usd.toFixed(4)}`).join(", ");
    console.log(`${tier}: ${lines}; total $${worstCost(tier).toFixed(4)}`);
  }
});
