/**
 * Art. 9a lock 3, jurisdiction "other", unit 2 (C5-20261119-1625-9a-other): a country's threshold snapshot from the
 * per-place counter's totals and the proposed sale. What fails here:
 *   - any country is assessed as anything but "unknown" while the reviewed rate and scope lists are empty;
 *   - a sale is converted without a reviewed ceiling rate valid that day, or at the cheaper of two, or rounded down;
 *   - the counter's "could not say" (null), a mixed currency or a malformed figure becomes a number;
 *   - Switzerland's worldwide rule is fed from one place's totals;
 *   - the window starts later than the rule's 12 months back.
 * Synthetic only: the rates and reviews below are made up for the arithmetic and are never the reviewed records.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OTHER_COUNTRY_WINDOW_MONTHS, PLACE_COUNTED_COUNTRIES, REVIEWED_COUNTRY_SCOPES, REVIEWED_FX_CEILINGS,
  assessPlaceCountedCountry, assessSnapshot as assessOtherCountry, otherCountrySnapshot, otherCountrySnapshotUnder, otherCountryWindowStart,
  type OtherCountryReviews,
} from "@/lib/other-country-snapshot";
import { DEEMED_SUPPLIER_RECORDS, deemedSupplierReady } from "@/lib/deemed-supplier";
import { PLANS_ON_SALE } from "@/lib/opening";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = "2026-11-19";
const SOURCE = "https://example.test/synthetic-rate";
// Synthetic: 1 USD at most 1.5 CAD and 12 NOK.
const REVIEWS: OtherCountryReviews = {
  fx: [
    { from: "USD", to: "CAD", numerator: 3, denominator: 2, source: SOURCE, checkedOn: "2026-11-01", validThrough: "2026-11-30" },
    { from: "USD", to: "NOK", numerator: 12, denominator: 1, source: SOURCE, checkedOn: "2026-11-01", validThrough: "2026-11-30" },
  ],
  scopes: [
    { ruleId: "ca-specified-supplies", evidence: "synthetic review", reviewedOn: "2026-11-01" },
    { ruleId: "no-remote-services", evidence: "synthetic review", reviewedOn: "2026-11-01" },
  ],
};
const totals = (settledMinor: number, reservedMinor = 0, currency = "USD") => ({ currency, settledMinor, reservedMinor });
const sale = (amountMinor: number, currency = "USD") => ({ currency, amountMinor });

test("while the reviewed lists are empty, every country is unknown, which refuses", () => {
  assert.deepEqual(REVIEWED_FX_CEILINGS, []);
  assert.deepEqual(REVIEWED_COUNTRY_SCOPES, []);
  assert.ok(Object.isFrozen(REVIEWED_FX_CEILINGS) && Object.isFrozen(REVIEWED_COUNTRY_SCOPES));
  for (const country of ["CA", "NO", "CH", "LI", "AU"]) {
    const snapshot = otherCountrySnapshot(country, totals(1), sale(1), NOW);
    assert.equal(assessOtherCountry(country, snapshot, NOW).status, "unknown", country);
    assert.equal(assessPlaceCountedCountry(country, totals(1), sale(1), NOW).status, "unknown", country);
  }
  // Even with the counter in the threshold's own currency (no rate needed), the scope is not reviewed.
  const cad = otherCountrySnapshot("CA", totals(1, 0, "CAD"), sale(1, "CAD"), NOW);
  assert.equal(assessOtherCountry("CA", cad, NOW).status, "unknown");
});

test("USD is converted at the reviewed ceiling, rounded up, and assessed at the country's own boundary", () => {
  // CAD 30,000 is exceeded only above it: USD 20,000 × 1.5 = CAD 30,000.00, still below.
  const at = otherCountrySnapshotUnder(REVIEWS, "CA", totals(1_999_900), sale(100), NOW);
  assert.deepEqual(at, {
    ruleId: "ca-specified-supplies", currency: "CAD", recordedOn: DAY, completeRollingCoverage: true, applicableScopeReviewed: true,
    settledApplicableMinor: 2_999_850, reservedApplicableMinor: 0, proposedApplicableMinor: 150,
  });
  assert.equal(assessOtherCountry("CA", at, NOW).status, "below-threshold");
  // One more cent, 1.5 CAD cents, rounded up to 2: above it.
  assert.equal(assessOtherCountry("CA", otherCountrySnapshotUnder(REVIEWS, "CA", totals(1_999_900), sale(101), NOW), NOW).status, "treatment-required");
  // Norway is reached AT NOK 50,000: USD 4,166.67 × 12 = NOK 50,000.04.
  assert.equal(assessOtherCountry("NO", otherCountrySnapshotUnder(REVIEWS, "NO", totals(416_666), sale(0), NOW), NOW).status, "below-threshold");
  assert.equal(assessOtherCountry("NO", otherCountrySnapshotUnder(REVIEWS, "NO", totals(416_666, 1), sale(0), NOW), NOW).status, "treatment-required");
});

test("an odd cent is rounded up, never down", () => {
  const snapshot = otherCountrySnapshotUnder(REVIEWS, "CA", totals(1), sale(1), NOW);
  assert.equal("settledApplicableMinor" in snapshot && snapshot.settledApplicableMinor, 2);
});

test("no rate valid today, a cheaper rate, or another currency is unknown, or the dearer rate wins", () => {
  for (const fx of [
    [],
    [{ ...REVIEWS.fx[0], validThrough: "2026-11-18" }],
    [{ ...REVIEWS.fx[0], checkedOn: "2026-11-20" }],
    [{ ...REVIEWS.fx[0], source: "http://insecure.test" }],
    [{ ...REVIEWS.fx[0], numerator: 0 }],
    [{ ...REVIEWS.fx[0], denominator: 1.5 }],
    [{ ...REVIEWS.fx[0], from: "EUR" }],
  ]) {
    assert.deepEqual(otherCountrySnapshotUnder({ ...REVIEWS, fx }, "CA", totals(1), sale(1), NOW), { status: "unknown" });
  }
  // Two valid ceilings for the same day: the dearer (1.6) is used.
  const two = { ...REVIEWS, fx: [REVIEWS.fx[0], { ...REVIEWS.fx[0], numerator: 8, denominator: 5 }] };
  const snapshot = otherCountrySnapshotUnder(two, "CA", totals(100), sale(0), NOW);
  assert.equal("settledApplicableMinor" in snapshot && snapshot.settledApplicableMinor, 160);
  // A currency outside the converted ones is unknown even with a rate for it.
  const jpy = { ...REVIEWS, fx: [{ ...REVIEWS.fx[0], from: "JPY" }] };
  assert.deepEqual(otherCountrySnapshotUnder(jpy, "CA", totals(1, 0, "JPY"), sale(1, "JPY"), NOW), { status: "unknown" });
});

test("the counter's 'could not say', mixed currencies and malformed figures never become a number", () => {
  const unknown = { status: "unknown" };
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", null, sale(1), NOW), unknown);
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", totals(1, 0, "CAD"), sale(1, "USD"), NOW), unknown);
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", { ...totals(1), extra: 1 }, sale(1), NOW), unknown);
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", totals(1), { ...sale(1), extra: 1 }, NOW), unknown);
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", Object.create(totals(1)), sale(1), NOW), unknown);
  let ran = false;
  const accessor = { currency: "USD", reservedMinor: 0, get settledMinor() { ran = true; return 1; } };
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", accessor, sale(1), NOW), unknown);
  assert.equal(ran, false);
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", totals(bad as number), sale(1), NOW), { status: "invalid" }, String(bad));
  }
  assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, "CA", totals(1), sale(1), Number.NaN), { status: "invalid" });
});

test("without a reviewed scope the snapshot says so, and the assessment refuses", () => {
  const snapshot = otherCountrySnapshotUnder({ ...REVIEWS, scopes: [] }, "CA", totals(1), sale(1), NOW);
  assert.ok("ruleId" in snapshot && !snapshot.completeRollingCoverage && !snapshot.applicableScopeReviewed);
  assert.equal(assessOtherCountry("CA", snapshot, NOW).status, "unknown");
  const future = otherCountrySnapshotUnder({ ...REVIEWS, scopes: [{ ...REVIEWS.scopes[0], reviewedOn: "2026-11-20" }] }, "CA", totals(1), sale(1), NOW);
  assert.equal(assessOtherCountry("CA", future, NOW).status, "unknown");
});

test("a snapshot made for one country is never assessed for another", () => {
  const canada = otherCountrySnapshotUnder(REVIEWS, "CA", totals(1), sale(1), NOW);
  assert.equal(assessOtherCountry("CA", canada, NOW).status, "below-threshold");
  assert.equal(assessOtherCountry("NO", canada, NOW).status, "unknown");
  assert.equal(assessOtherCountry("CH", canada, NOW).status, "unknown");
});

test("Switzerland's worldwide rule and countries without a rule are never fed from one place", () => {
  for (const country of ["CH", "LI", "US", "GB", "XK", "__proto__", null]) {
    assert.deepEqual(otherCountrySnapshotUnder(REVIEWS, country, totals(1), sale(1), NOW), { status: "unknown" }, String(country));
  }
  assert.deepEqual([...PLACE_COUNTED_COUNTRIES].sort(), ["CA", "NO"]);
});

test("the window reaches at least 12 calendar months back, one day more at a month's end", () => {
  assert.equal(OTHER_COUNTRY_WINDOW_MONTHS["ca-specified-supplies"], 12);
  assert.equal(OTHER_COUNTRY_WINDOW_MONTHS["no-remote-services"], 12);
  assert.equal(new Date(otherCountryWindowStart("ca-specified-supplies", NOW)).toISOString(), "2025-11-18T00:00:00.000Z");
  // 29 February: 12 months back is 1 March 2023 by Date.UTC rollover, one day more is 28 February.
  assert.equal(new Date(otherCountryWindowStart("no-remote-services", Date.parse("2024-02-29T23:00:00Z"))).toISOString(), "2023-02-28T00:00:00.000Z");
  assert.ok(Object.isFrozen(OTHER_COUNTRY_WINDOW_MONTHS));
});

test("nothing here records a treatment or opens a sale", () => {
  assert.deepEqual(DEEMED_SUPPLIER_RECORDS, []);
  assert.equal(deemedSupplierReady(), false);
  assert.equal(PLANS_ON_SALE, false);
});
