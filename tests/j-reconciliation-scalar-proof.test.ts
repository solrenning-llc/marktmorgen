import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileCompanyMonthlyEvidence } from "../lib/company-margin-reconciliation";
import { COMMERCIAL_PROFIT_SOURCES, commercialProfitMix, type CommercialProfitSource } from "../lib/commercial-margin";

const NOW = Date.UTC(2026, 10, 1);
function fixture() {
  return { period: "2026-10", currency: "USD", companyFixedCostsCents: 900,
    sources: Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source => [source, {
      period: "2026-10", currency: "USD", complete: true,
      amounts: { revenueCents: 1000, variableCostsCents: 100, allocatedFixedCostsCents: 100,
        taxesCents: 200, refundsCents: 50, reservesCents: 50, evidence: "SYNTHETIC ONLY; complete source reconciliation" },
    }])) as unknown as Record<CommercialProfitSource, { period: string; currency: string; complete: boolean; amounts: Record<string, unknown> }>,
  };
}

test("an object in the fixed-cost scalar is refused before any Proxy trap",()=>{
 const input=fixture();let calls=0;
 Object.assign(input,{companyFixedCostsCents:new Proxy({}, {ownKeys(){calls++;return [];}})});
 assert.equal(reconcileCompanyMonthlyEvidence(input,NOW),null);
 console.log('FIXED_SCALAR_TRAPS',calls);
 assert.equal(calls,0,'unknown scalar must not enter an executable graph traversal');
});
