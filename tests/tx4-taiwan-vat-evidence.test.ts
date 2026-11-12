import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS } from "../lib/llc-fixed-costs";

const path = "docs/tx4-taiwan-vat-evidence.md";
test("Taiwan evidence preserves dated threshold transition and conditional classification", () => {
  const doc = readFileSync(path, "utf8");
  for (const fact of ["Read on November 5, 2026", "NT$600,000", "April 7, 2025", "NT$480,000", "previous or current year", "domestic individuals", "classification remains unverified", "cloud invoices", "Chinese translation"]) assert.ok(doc.includes(fact), fact);
});
test("Taiwan evidence separates return, currency, historical exemption and actual liability", () => {
  const doc = readFileSync(path, "utf8");
  for (const fact of ["bimonthly", "even without sales", "March 1-15", "New Taiwan dollars", "Bank of Taiwan", "spot buying", "cash buying", "holiday", "corrections", "2017-2018", "not a current exemption", "retention remains unverified"]) assert.ok(doc.includes(fact), fact);
  for (const url of ["wzr6kJ6", "OgevYEJ", "Gz6MjlP", "80053e677d59432e90afbcee3d2bed3c"]) assert.ok(doc.includes(url), url);
});
test("Taiwan documentary evidence cannot fund unknown complete compliance costs", () => {
  const doc = readFileSync(path, "utf8");
  for (const fact of ["unknown and unreserved", "100% Marktmorgen", "No account, registration, filing, payment or external contact", "TX4 remains incomplete"]) assert.ok(doc.includes(fact), fact);
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.equal(line.fullMonthlyUsdCents, null);
  assert.equal(line.fullAnnualUsdCents, null);
  assert.equal(line.reserveReviewed, false);
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
