import { test } from "node:test";
import assert from "node:assert/strict";
import { companyMonthlyMarginPresentation } from "../lib/company-margin-report";
import {
  COMMERCIAL_PROFIT_SOURCES,
  commercialPlansMayOpen,
  type CommercialProfitMixInput,
  type ProfitSourceAmounts,
} from "../lib/commercial-margin";

const NOW = Date.UTC(2026, 10, 1);

function fixture(): CommercialProfitMixInput {
  return {
    basis: "reconciled_actual",
    interval: "month",
    period: "2026-10",
    currency: "USD",
    companyFixedCostsCents: 900,
    sources: Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source => [source, {
      revenueCents: 1_000,
      variableCostsCents: 100,
      allocatedFixedCostsCents: 100,
      taxesCents: 200,
      refundsCents: 50,
      reservesCents: 50,
      evidence: "SYNTHETIC ONLY; synthetic-person@example.com; synthetic-account-id",
    }])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number], ProfitSourceAmounts>,
  };
}

test("a complete reconciled month has one deterministic private owner presentation", () => {
  const input = fixture() as CommercialProfitMixInput & { privateEmail?: string };
  input.privateEmail = "synthetic-person@example.com";
  const presentation = companyMonthlyMarginPresentation(input, NOW);
  assert.deepEqual(presentation, {
    schema: 1,
    reportId: "company-margin:2026-10:v1",
    month: "2026-10",
    currency: "USD",
    basis: "reconciled_actual",
    subject: "Marktmorgen company margin — October 2026",
    text: [
      "Marktmorgen company margin — October 2026",
      "Report ID: company-margin:2026-10:v1",
      "Basis: reconciled actuals for the complete UTC calendar month.",
      "Revenue: $90.00",
      "Variable costs: $9.00",
      "Fixed costs: $9.00",
      "Taxes: $18.00",
      "Refunds: $4.50",
      "Reserves: $4.50",
      "Net profit: $45.00",
      "Net margin: 50.00%",
      "Target: 60.00% — not met.",
      "Informational only: this report does not open sales or change any price, limit, commission, flag or gate.",
    ].join("\n"),
  });
  assert.equal(Object.isFrozen(presentation), true);
  assert.deepEqual(companyMonthlyMarginPresentation(input, NOW), presentation);
  assert.doesNotMatch(JSON.stringify(presentation), /example\.com|synthetic-account|evidence|privateEmail|SYNTHETIC/);
});

test("losses, zero revenue and the exact target remain truthful presentation states", () => {
  const lossInput = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) lossInput.sources[source]!.revenueCents = 0;
  const loss = companyMonthlyMarginPresentation(lossInput, NOW);
  assert.match(loss!.text, /Revenue: \$0\.00/);
  assert.match(loss!.text, /Net profit: -\$45\.00/);
  assert.match(loss!.text, /Net margin: not measurable because revenue was \$0\.00\./);
  assert.match(loss!.text, /Target: 60\.00% — not measurable because revenue was \$0\.00\./);
  assert.doesNotMatch(loss!.text, /met\./);

  const exactTarget = fixture();
  for (const source of COMMERCIAL_PROFIT_SOURCES) exactTarget.sources[source]!.revenueCents = 1_250;
  assert.match(companyMonthlyMarginPresentation(exactTarget, NOW)!.text, /Net margin: 60\.00%\nTarget: 60\.00% — met\./);
  exactTarget.sources.training!.reservesCents = 51;
  assert.match(companyMonthlyMarginPresentation(exactTarget, NOW)!.text, /Net margin: 59\.99%\nTarget: 60\.00% — not met\./);
  assert.equal(commercialPlansMayOpen(true), false);
});

test("unknown, malformed or uninspectable accounting never gets a presentation", () => {
  assert.equal(companyMonthlyMarginPresentation(null, NOW), null);
  const missing = fixture(); missing.sources.training!.taxesCents = null;
  assert.equal(companyMonthlyMarginPresentation(missing, NOW), null);
  const wrongMonth = fixture(); wrongMonth.period = "2026-09";
  assert.equal(companyMonthlyMarginPresentation(wrongMonth, NOW), null);
  assert.equal(companyMonthlyMarginPresentation(fixture(), Number.NaN), null);

  let reads = 0;
  const accessor = fixture();
  Object.defineProperty(accessor.sources.training, "revenueCents", {
    enumerable: true,
    get() { reads++; throw new Error("getter"); },
  });
  assert.equal(companyMonthlyMarginPresentation(accessor, NOW), null);
  assert.equal(reads, 0);

  const revoked = Proxy.revocable(fixture(), {}); revoked.revoke();
  assert.equal(companyMonthlyMarginPresentation(revoked.proxy, NOW), null);
});

test("the month and idempotency key come only from the complete UTC period", () => {
  const october = companyMonthlyMarginPresentation(fixture(), NOW)!;
  const novemberInput = fixture(); novemberInput.period = "2026-11";
  const november = companyMonthlyMarginPresentation(novemberInput, Date.UTC(2026, 11, 1))!;
  assert.equal(october.reportId, "company-margin:2026-10:v1");
  assert.equal(november.reportId, "company-margin:2026-11:v1");
  assert.equal(november.subject, "Marktmorgen company margin — November 2026");
  assert.notEqual(october.reportId, november.reportId);
});
