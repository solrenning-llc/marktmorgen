/**
 * Art. 9a lock 3, jurisdiction "other", unit 4 (C5-20261120-2110-9a-other-u4): Taiwan, the first country counted over
 * calendar years instead of a rolling 12 months. What fails here:
 *   - Taiwan's rule is not the Ministry of Finance's NT$600,000 a year (decree of 07/04/2025, no. 11404515420), or its
 *     boundary is read the lenient way: the decree says "exceeds", and the coordinator's decision takes the stricter
 *     reading, so a count of exactly NT$600,000 already requires treatment;
 *   - its window is not the previous AND the current calendar year (FAQ FOUR, Q1, 14/05/2025: the previous year or the
 *     current year), counted together from 1 January of the previous year, which reaches the threshold sooner, never
 *     later, than either year alone;
 *   - a count that does not reach back to that 1 January is assessed;
 *   - Taiwan sells at or above 90% of the threshold, with the sale reserved, or without a reviewed rate and scope;
 *   - anything opens.
 * Synthetic only: the rates and reviews below are made up and are never the reviewed records.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TAX_THRESHOLD_RULES } from "@/lib/tax-threshold";
import { assessOtherCountry, otherCountryRule } from "@/lib/other-country-thresholds";
import {
  OTHER_COUNTRY_CALENDAR_YEARS, PLACE_COUNTED_COUNTRIES, assessPlaceCountedCountry, assessSnapshot, otherCountrySnapshotUnder,
  otherCountryWindowStart, type OtherCountryReviews,
} from "@/lib/other-country-snapshot";
import { thresholdCheckoutDecision, thresholdCheckoutDecisionUnder, type PlaceSalesCounter } from "@/lib/other-country-checkout";
import { REFUSAL_WORDS } from "@/lib/jurisdiction-refusal-rules";
import { DEEMED_SUPPLIER_RECORDS, type DeemedSupplierRecord } from "@/lib/deemed-supplier";
import { PLANS_ON_SALE } from "@/lib/opening";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = "2026-11-19";
const TW = "tw-cross-border-e-services" as const;
// Synthetic: 1 USD at most 33 TWD.
const REVIEWS: OtherCountryReviews = {
  fx: [{ from: "USD", to: "TWD", numerator: 33, denominator: 1, source: "https://example.test/synthetic-rate", checkedOn: "2026-11-01", validThrough: "2026-11-30" }],
  scopes: [{ ruleId: TW, evidence: "synthetic review", reviewedOn: "2026-11-01", validThrough: "2026-12-31" }],
};
const totals = (settledMinor: number, reservedMinor = 0, currency = "TWD", fromMonth = "2025-01") => ({
  place: { country: "TW", state: null }, fromMonth, toMonth: "2026-11", countingSince: "2024-06", complete: true,
  currencies: { [currency]: { settledMinor, reservedMinor } },
});

test("Taiwan's rule: NT$600,000 a year, reached at exactly 600,000 (the stricter reading), counted in Taiwan", () => {
  assert.deepEqual({ ...TAX_THRESHOLD_RULES[TW] }, {
    currency: "TWD", thresholdMinor: 60_000_000, comparison: "gte", scope: "country",
    source: "https://law-out.mof.gov.tw/EngLawContent.aspx?KW=Business+Tax&id=20732&lan=E", checkedOn: "2026-11-19",
  });
  assert.ok(Object.isFrozen(TAX_THRESHOLD_RULES[TW]));
  assert.deepEqual(otherCountryRule("TW"), { ruleId: TW });
  assert.deepEqual([...PLACE_COUNTED_COUNTRIES].sort(), ["CA", "NO", "TW"]);
});

test("the window is the previous and the current calendar year, from 1 January of the previous year", () => {
  assert.equal(OTHER_COUNTRY_CALENDAR_YEARS[TW], 2);
  assert.ok(Object.isFrozen(OTHER_COUNTRY_CALENDAR_YEARS));
  assert.equal(new Date(otherCountryWindowStart(TW, NOW)).toISOString(), "2025-01-01T00:00:00.000Z");
  assert.equal(new Date(otherCountryWindowStart(TW, Date.parse("2026-01-01T00:00:00Z"))).toISOString(), "2025-01-01T00:00:00.000Z");
  assert.equal(new Date(otherCountryWindowStart(TW, Date.parse("2025-12-31T23:59:59Z"))).toISOString(), "2024-01-01T00:00:00.000Z");
  // A count that starts after that 1 January does not cover the window: unknown, which refuses.
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "TW", totals(1, 0, "TWD", "2025-02"), { currency: "TWD", amountMinor: 1 }, NOW), { status: "unknown" });
  assert.equal("status" in otherCountrySnapshotUnder(REVIEWS, "TW", totals(1, 0, "TWD", "2025-01"), { currency: "TWD", amountMinor: 1 }, NOW), false);
});

test("the boundary: one minor unit under NT$600,000 is below; exactly NT$600,000 requires treatment", () => {
  const at = (settled: number, proposed: number) =>
    assessSnapshot("TW", otherCountrySnapshotUnder(REVIEWS, "TW", totals(settled), { currency: "TWD", amountMinor: proposed }, NOW), NOW);
  assert.deepEqual(at(59_999_900, 99), { status: "below-threshold", projectedApplicableMinor: 59_999_999 });
  assert.deepEqual(at(59_999_900, 100), { status: "treatment-required", projectedApplicableMinor: 60_000_000 });
  // USD at the synthetic ceiling of 33 TWD, rounded up.
  assert.deepEqual(at(0, 0).status, "below-threshold");
  const usd = assessSnapshot("TW", otherCountrySnapshotUnder(REVIEWS, "TW", totals(1_818_182, 0, "USD"), { currency: "USD", amountMinor: 0 }, NOW), NOW);
  assert.deepEqual(usd, { status: "treatment-required", projectedApplicableMinor: 60_000_006 });
});

test("Taiwan's own ledger is assessed under its rule, and never another country's", () => {
  const ledger = (country: string, amountMinor: number) => ({
    ruleId: TW, completeRollingCoverage: true, applicableScopeReviewed: true,
    ledger: {
      place: { country, state: null }, currency: "TWD",
      periodStart: "2025-01-01", periodEnd: DAY, coverageFrom: "2025-01-01", coverageThrough: DAY, complete: true,
      entries: [{ id: "one", country, state: null, currency: "TWD", supplyOn: DAY, position: "settled", amountMinor, applicable: true }],
    },
  });
  assert.equal(assessOtherCountry("TW", ledger("TW", 59_999_999), NOW).status, "below-threshold");
  assert.equal(assessOtherCountry("TW", ledger("TW", 60_000_000), NOW).status, "treatment-required");
  assert.equal(assessOtherCountry("TW", ledger("CA", 1), NOW).status, "unknown");
  assert.equal(assessOtherCountry("CA", ledger("TW", 1), NOW).status, "unknown");
});

const record = (jurisdiction: DeemedSupplierRecord["jurisdiction"], treatment: DeemedSupplierRecord["treatment"]): DeemedSupplierRecord => ({
  jurisdiction, treatment, implementedIn: "lib/other-country-checkout.ts", recordedOn: "2026-11-19",
  registration: treatment === "collect" ? "synthetic registration, never real" : "", evidence: "tests/other-country-taiwan.test.ts",
});
const RECORDS = [record("EU", "collect"), record("UK", "collect"), record("US", "collect"), record("other", "threshold")];
function counter(answer: unknown) {
  const calls: unknown[][] = [];
  const port: PlaceSalesCounter = {
    async reserve(sale) { calls.push(["reserve", sale]); return "reserved"; },
    async totals(ledger, place, since, now) { calls.push(["totals", ledger, place, since, now]); return answer; },
    async release(ledger, ref) { calls.push(["release", ledger, ref]); return true; },
  };
  return { port, calls };
}
const SALE = { currency: "TWD", amountMinor: 100, ref: "cs_synthetic_tw" };
const refused = { allowed: false, reason: "refused-jurisdiction", jurisdictions: ["other"], buyerMessage: REFUSAL_WORDS["refused-jurisdiction"] };

test("at checkout, Taiwan sells below 90% of the threshold with the sale reserved, and refuses and releases at 90%", async () => {
  // 90% of NT$600,000 = 54,000,000 minor.
  const below = counter(totals(53_999_899, 100));
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, { ipCountry: "TW", billingCountry: "TW" }, SALE, below.port, RECORDS, NOW), {
    allowed: true, jurisdictions: ["other"], reservation: { ledger: "store-sales", ref: "cs_synthetic_tw" },
  });
  assert.deepEqual(below.calls[1], ["totals", "store-sales", { country: "TW", state: null }, Date.parse("2025-01-01T00:00:00Z"), NOW]);
  const at90 = counter(totals(53_999_900, 100));
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, { ipCountry: "TW", billingCountry: "TW" }, SALE, at90.port, RECORDS, NOW), refused);
  assert.deepEqual(at90.calls.map((call) => call[0]), ["reserve", "totals", "release"]);
});

test("production: no reviewed rate or scope, no record, nothing counted, nothing sold, nothing opens", async () => {
  assert.equal(assessPlaceCountedCountry("TW", totals(0), { currency: "TWD", amountMinor: 1 }, NOW).status, "unknown");
  const idle = counter(totals(0));
  assert.deepEqual(await thresholdCheckoutDecision({ ipCountry: "TW", billingCountry: "TW" }, SALE, idle.port, NOW), {
    allowed: false, reason: "not-recorded", jurisdictions: [], buyerMessage: REFUSAL_WORDS["not-recorded"],
  });
  assert.deepEqual(await thresholdCheckoutDecisionUnder({ fx: [], scopes: [] }, { ipCountry: "TW", billingCountry: "TW" }, SALE, idle.port, RECORDS, NOW), refused);
  assert.deepEqual(idle.calls, []);
  assert.deepEqual(DEEMED_SUPPLIER_RECORDS, []);
  assert.equal(PLANS_ON_SALE, false);
});
