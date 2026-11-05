import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANY_NET_MARGIN_TARGET_BPS, companyMonthlyMarginReport, lastCompleteCompanyMonth } from "../lib/company-margin-report";
import { COMMERCIAL_PROFIT_SOURCES, CURRENT_COMMERCIAL_PROFIT_MIX_INPUT, commercialPlansMayOpen, type CommercialProfitMixInput, type ProfitSourceAmounts } from "../lib/commercial-margin";

const NOW = Date.UTC(2026, 10, 1);
function fixture(): CommercialProfitMixInput {
  return { basis: "reconciled_actual", interval: "month", period: "2026-10", currency: "USD",
    companyFixedCostsCents: 900, sources: Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source => [source, {
      revenueCents: 1000, variableCostsCents: 100, allocatedFixedCostsCents: 100,
      taxesCents: 200, refundsCents: 50, reservesCents: 50,
      evidence: "SYNTHETIC ONLY; same-month complete most-tax accounting, no actual invoice",
    }])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number], ProfitSourceAmounts> };
}
test("the real company report deducts all categories and measures the 60% target without a sale gate", () => {
  const result = companyMonthlyMarginReport(fixture(), NOW);
  assert.deepEqual(result, { schema: 1, month: "2026-10", currency: "USD", basis: "reconciled_actual",
    status: "complete", reason: "complete", revenueCents: 9000, variableCostsCents: 900,
    fixedCostsCents: 900, taxesCents: 1800, refundsCents: 450, reservesCents: 450,
    netProfitCents: 4500, netMarginBps: 5000, targetBps: 6000, targetMet: false, heldStores: null, heldStoresPeak: null });
  assert.equal(COMPANY_NET_MARGIN_TARGET_BPS, 6000);
  assert.equal(commercialPlansMayOpen(true), false);
});
test("unknown accounting never becomes zero, a percentage or target achievement", () => {
  assert.equal(CURRENT_COMMERCIAL_PROFIT_MIX_INPUT, null);
  for (const source of COMMERCIAL_PROFIT_SOURCES) {
    for (const key of ["revenueCents", "variableCostsCents", "allocatedFixedCostsCents", "taxesCents", "refundsCents", "reservesCents"] as const) {
      const input = fixture(); input.sources[source]![key] = null;
      const result = companyMonthlyMarginReport(input, NOW);
      assert.equal(result.status, "unknown"); assert.equal(result.netProfitCents, null);
      assert.equal(result.netMarginBps, null); assert.equal(result.targetMet, null);
    }
    const input = fixture(); input.sources[source] = null;
    assert.equal(companyMonthlyMarginReport(input, NOW).status, "unknown");
    const noEvidence = fixture(); noEvidence.sources[source]!.evidence = "";
    assert.equal(companyMonthlyMarginReport(noEvidence, NOW).status, "unknown");
  }
  assert.equal(companyMonthlyMarginReport(null, NOW).status, "unknown");
  const inherited = fixture(); inherited.sources = Object.create(inherited.sources);
  assert.equal(companyMonthlyMarginReport(inherited, NOW).status, "unknown");
});
test("only the previous complete UTC month and reconciled actual data are reportable", () => {
  const cases = [Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1), Date.UTC(2026, 10, 30, 23, 59, 59), Date.UTC(2026, 11, 1)];
  assert.deepEqual(cases.map(lastCompleteCompanyMonth), ["2025-12", "2026-02", "2026-10", "2026-11"]);
  assert.equal(lastCompleteCompanyMonth(Date.UTC(2024, 2, 1)), "2024-02");
  for (const now of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(companyMonthlyMarginReport(fixture(), now).reason, "invalid_clock");
  }
  for (const period of ["2026", "2026-09", "2026-11", "2026-1", "", "2026-10-01"]) {
    const input = fixture(); input.period = period;
    assert.equal(companyMonthlyMarginReport(input, NOW).reason, "wrong_period_or_basis");
  }
  const forecast = fixture(); forecast.basis = "worst_case";
  assert.equal(companyMonthlyMarginReport(forecast, NOW).reason, "wrong_period_or_basis");
  const annual = fixture(); annual.interval = "year";
  assert.equal(companyMonthlyMarginReport(annual, NOW).reason, "wrong_period_or_basis");
});
test("fixed costs cannot disappear, double count or change accounting period", () => {
  for (const fixed of [0, 899, 901, 10800]) {
    const input = fixture(); input.companyFixedCostsCents = fixed;
    const result = companyMonthlyMarginReport(input, NOW);
    assert.equal(result.reason, "fixed_cost_allocation_mismatch");
    assert.equal(result.netProfitCents, null); assert.equal(result.fixedCostsCents, null);
  }
});
test("losses and zero-revenue months remain visible without invented percentages", () => {
  const input = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) input.sources[source]!.revenueCents = 0;
  const loss = companyMonthlyMarginReport(input, NOW);
  assert.equal(loss.status, "complete"); assert.equal(loss.netProfitCents, -4500);
  assert.equal(loss.netMarginBps, null); assert.equal(loss.targetMet, null);
  for (const source of COMMERCIAL_PROFIT_SOURCES) input.sources[source]!.revenueCents = 400;
  const earningLoss = companyMonthlyMarginReport(input, NOW);
  assert.equal(earningLoss.netProfitCents, -900); assert.equal(earningLoss.netMarginBps, -2500);
  assert.equal(earningLoss.targetMet, false);
  for (const source of COMMERCIAL_PROFIT_SOURCES) input.sources[source]!.revenueCents = 500;
  assert.equal(companyMonthlyMarginReport(input, NOW).netProfitCents, 0);
  assert.equal(companyMonthlyMarginReport(input, NOW).targetMet, false);
});
test("target decisions use exact cents and do not turn the target into permission", () => {
  const input = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) input.sources[source]!.revenueCents = 1250;
  assert.equal(companyMonthlyMarginReport(input, NOW).netMarginBps, 6000);
  assert.equal(companyMonthlyMarginReport(input, NOW).targetMet, true);
  input.sources.training!.reservesCents = 51;
  assert.equal(companyMonthlyMarginReport(input, NOW).netMarginBps, 5999);
  assert.equal(companyMonthlyMarginReport(input, NOW).targetMet, false);
  assert.equal(commercialPlansMayOpen(true), false);
});
test("supplied private fields and provenance never appear in the aggregate output; getters never execute", () => {
  const input = fixture() as CommercialProfitMixInput & { privateEmail?: string };
  input.privateEmail = "synthetic-person@example.com";
  input.sources.training!.evidence += "; synthetic-account-id; synthetic-person@example.com";
  const rendered = JSON.stringify(companyMonthlyMarginReport(input, NOW));
  assert.doesNotMatch(rendered, /example.com|synthetic-account|evidence|privateEmail|SYNTHETIC/);
  let reads = 0;
  const accessor = fixture();
  Object.defineProperty(accessor.sources.training, "revenueCents", { enumerable: true, get() { reads++; throw new Error("getter"); } });
  assert.equal(companyMonthlyMarginReport(accessor, NOW).status, "unknown");
  assert.equal(reads, 0);
});
test("unsafe inputs and aggregate overflow fail without partial totals", () => {
  for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); input.sources.training!.taxesCents = amount;
    assert.equal(companyMonthlyMarginReport(input, NOW).status, "unknown");
  }
  const huge = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) huge.sources[source]!.revenueCents = Number.MAX_SAFE_INTEGER;
  const result = companyMonthlyMarginReport(huge, NOW);
  assert.equal(result.status, "unknown"); assert.equal(result.revenueCents, null);
});

test("held counts are monthly private aggregates and do not certify unknown money", () => {
  const result = companyMonthlyMarginReport(null, NOW, { month: "2026-10", count: 2, peak: 5, privateEmail: "private@example.test" });
  assert.equal(result.heldStores, 2); assert.equal(result.heldStoresPeak, 5);
  assert.equal(result.status, "unknown"); assert.equal(result.netProfitCents, null);
  assert.doesNotMatch(JSON.stringify(result), /private|example/);
  for (const held of [null, {}, { month: "2026-09", count: 2, peak: 5 }, { month: "2026-10", count: 2, peak: 1 }, { month: "2026-10", count: -1, peak: 5 }, Object.create({ month: "2026-10", count: 2, peak: 5 })]) {
    assert.equal(companyMonthlyMarginReport(fixture(), NOW, held).heldStores, null);
  }
  let reads = 0;
  const held = { month: "2026-10", peak: 5, get count() { reads++; return 2; } };
  assert.equal(companyMonthlyMarginReport(fixture(), NOW, held).heldStores, null);
  assert.equal(reads, 0);
  assert.equal(companyMonthlyMarginReport(null, NOW, { month: "2026-10", count: 0, peak: 0 }).heldStores, 0);
});
