import assert from "node:assert/strict";
import { test } from "node:test";
import { companyMonthlyMarginReport, companyMonthlyMarginPresentation } from "../lib/company-margin-report";
import { commercialProfitMix, COMMERCIAL_PROFIT_SOURCES, type CommercialProfitMixInput, type ProfitSourceAmounts } from "../lib/commercial-margin";

const NOW = Date.UTC(2026, 10, 1);
function fixture(): CommercialProfitMixInput {
  return { basis: "reconciled_actual", interval: "month", period: "2026-10", currency: "USD",
    companyFixedCostsCents: 900, sources: Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source => [source, {
      revenueCents: 1000, variableCostsCents: 100, allocatedFixedCostsCents: 100,
      taxesCents: 200, refundsCents: 50, reservesCents: 50, evidence: "SYNTHETIC ONLY; no actual cost approval",
    }])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number], ProfitSourceAmounts> };
}
function unknown(input: CommercialProfitMixInput): void {
  const report = companyMonthlyMarginReport(input, NOW);
  assert.equal(report.status, "unknown");
  for (const field of ["revenueCents", "variableCostsCents", "fixedCostsCents", "taxesCents", "refundsCents", "reservesCents", "netProfitCents", "netMarginBps", "targetMet"] as const) {
    assert.equal(report[field], null, field);
  }
  assert.equal(companyMonthlyMarginPresentation(input, NOW), null);
}

// Codex J's 237d6006: the real monthly caller must preserve the direct refusal.
test("monthly report preserves refusal of a supplier cost hidden by a Proxy", () => {
  const input = fixture();
  input.sources.training = new Proxy(Object.assign(input.sources.training!, { unreviewedSupplierCents: null }), {
    ownKeys(target) { return Reflect.ownKeys(target).filter(key => key !== "unreviewedSupplierCents"); },
  });
  assert.equal(commercialProfitMix(input).reason, "unknown");
  unknown(input);
});

test("transparent and revoked proxies cannot be laundered into accounting snapshots", () => {
  for (const position of ["root", "sources", ...COMMERCIAL_PROFIT_SOURCES] as const) {
    const input = fixture();
    const value = position === "root" ? input : position === "sources" ? input.sources : input.sources[position]!;
    const wrapped = Proxy.revocable(value, {});
    const supplied = position === "root" ? wrapped.proxy as CommercialProfitMixInput : input;
    if (position === "sources") input.sources = wrapped.proxy as CommercialProfitMixInput["sources"];
    else if (position !== "root") input.sources[position] = wrapped.proxy as ProfitSourceAmounts;
    unknown(supplied);
    wrapped.revoke();
    unknown(supplied);
  }
});

test("extra root and source costs, inherited fields and accessors stay unknown", () => {
  for (const extra of [null, 0, 100_000]) {
    unknown(Object.assign(fixture(), { unreviewedSupplierCents: extra }));
    const input = fixture(); Object.assign(input.sources.training!, { unreviewedSupplierCents: extra }); unknown(input);
  }
  const inherited = fixture(); inherited.sources.training = Object.create(inherited.sources.training); unknown(inherited);
  let reads = 0;
  const accessor = fixture();
  Object.defineProperty(accessor.sources.training!, "taxesCents", { enumerable: true, get() { reads++; return 0; } });
  unknown(accessor);
  assert.equal(reads, 0);
});

test("auxiliary proxies cannot remove an unpriced cost before financial validation", () => {
  const input = fixture();
  const row = Object.assign(input.sources.training!, { unreviewedSupplierCents: null });
  let traps = 0;
  const supplied = Object.assign({ aux: new Proxy({}, { ownKeys() { traps++; delete (row as Partial<typeof row>).unreviewedSupplierCents; return []; } }) }, input);
  unknown(supplied);
  assert.equal(traps, 0);
});

test("held-store inspection cannot sanitize or change the accounting input", () => {
  const input = fixture();
  Object.assign(input.sources.training!, { unreviewedSupplierCents: null });
  const held = new Proxy({ month: "2026-10", count: 1, peak: 1 }, {
    ownKeys(target) { delete (input.sources.training as ProfitSourceAmounts & { unreviewedSupplierCents?: null }).unreviewedSupplierCents; return Reflect.ownKeys(target); },
  });
  assert.equal(companyMonthlyMarginReport(input, NOW, held).status, "unknown");

  const valid = fixture();
  const mutatingHeld = new Proxy({ month: "2026-10", count: 1, peak: 1 }, {
    ownKeys(target) { valid.sources.training!.taxesCents = 0; return Reflect.ownKeys(target); },
  });
  assert.equal(companyMonthlyMarginReport(valid, NOW, mutatingHeld).taxesCents, 1800);
});

test("valid own data, null prototypes and explicit zero retain exact totals", () => {
  const input = fixture();
  input.sources.training = Object.assign(Object.create(null), input.sources.training);
  assert.equal(companyMonthlyMarginReport(input, NOW).netProfitCents, 4500);
  for (const source of COMMERCIAL_PROFIT_SOURCES) {
    for (const key of ["revenueCents", "variableCostsCents", "allocatedFixedCostsCents", "taxesCents", "refundsCents", "reservesCents"] as const) input.sources[source]![key] = 0;
  }
  input.companyFixedCostsCents = 0;
  const report = companyMonthlyMarginReport(input, NOW);
  assert.equal(report.status, "complete");
  assert.equal(report.netProfitCents, 0);
  assert.equal(report.netMarginBps, null);
});

test("a rejected late-row Proxy cannot execute a getter installed on an earlier row", () => {
  const input = fixture();
  let reads = 0;
  input.sources.training = new Proxy(input.sources.training!, {
    ownKeys(target) {
      Object.defineProperty(input.sources.plan_subscriptions!, "evidence", {
        enumerable: true, configurable: true, get() { reads++; return "SYNTHETIC ONLY"; },
      });
      return Reflect.ownKeys(target);
    },
  });
  assert.equal(companyMonthlyMarginReport(input, NOW).status, "unknown");
  assert.equal(reads, 0);
});
