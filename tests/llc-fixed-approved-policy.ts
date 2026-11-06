/** Explicitly known hypothetical zero ceilings for isolated model controls.
 * Never imported by production. No supplier quote, waiver or operating approval. */
import {LLC_FIXED_COST_IDS,type FixedCostCeiling} from "../lib/llc-fixed-costs";
export * from "../lib/llc-fixed-costs";
export function fixedCostsFixture(retentionCents=0):FixedCostCeiling[]{
 return LLC_FIXED_COST_IDS.map(id=>({id,fullMonthlyUsdCents:id==="deployment-artifact-retention"?retentionCents:0,fullAnnualUsdCents:id==="deployment-artifact-retention"?retentionCents*12:0,evidence:"TEST ONLY: explicitly known hypothetical ceiling; no supplier operation",reserveReviewed:true}));
}
export const CURRENT_LLC_FIXED_COST_CEILINGS=fixedCostsFixture();
