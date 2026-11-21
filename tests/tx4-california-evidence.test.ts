import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  allocateEntireLlcFixedCosts,
  CURRENT_LLC_FIXED_COST_CEILINGS,
  FIXED_COST_SOURCE_OBSERVATIONS,
} from "../lib/llc-fixed-costs";

const path = "docs/tx4-california-evidence.md";
const document = existsSync(path) ? readFileSync(path, "utf8") : "";

test("TX4 dates California primary evidence and keeps applicability conditional", () => {
  for (const fact of [
    "Read on 5 November 2026",
    "https://www.ftb.ca.gov/file/business/types/limited-liability-company/index.html",
    "https://www.ftb.ca.gov/forms/2025/2025-568-booklet.html",
    "https://www.ftb.ca.gov/forms/whats-new.html",
    "doing business in California or organized or registered there",
    "not a conclusion that this Delaware LLC is doing business in California",
    "California-source income remains unverified",
    "USD 800",
    "15th day of the 4th month",
    "FTB 3522",
  ]) assert.ok(document.includes(fact), fact);
  assert.equal(FIXED_COST_SOURCE_OBSERVATIONS.californiaTax.annualMinor, 80000);
});

test("TX4 distinguishes effective years, exceptions and the graduated LLC fee", () => {
  for (const fact of [
    "2021 through 2023",
    "2027 through 2029",
    "USD 400",
    "prospective first-taxable-year reduction",
    "15-day exception",
    "USD 250,000 through USD 499,999", "USD 900",
    "USD 500,000 through USD 999,999", "USD 2,500",
    "USD 1,000,000 through USD 4,999,999", "USD 6,000",
    "USD 5,000,000 or more", "USD 11,790",
    "gross income plus cost of goods sold",
    "derived from or attributable to California",
    "15th day of the 6th month",
    "FTB 3536",
    "10% of the underpayment",
    "prior taxable year",
  ]) assert.ok(document.includes(fact), fact);
  assert.equal(FIXED_COST_SOURCE_OBSERVATIONS.californiaFee.maximumAnnualMinor, 1179000);
});

test("TX4 leaves California applicability, complete cost and funding unknown", () => {
  for (const fact of [
    "registration and nexus analysis",
    "income sourcing",
    "preparation and review",
    "recordkeeping",
    "penalties and interest",
    "currency conversion and reserve timing",
    "complete monetary ceiling remains unknown and unreserved",
    "does not establish a zero compliance cost",
    "No registration, return, payment, account access or external contact",
    "100% Marktmorgen",
    "TX4 remains incomplete",
  ]) assert.ok(document.includes(fact), fact);
  for (const id of ["california-tax", "california-fee"] as const) {
    const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(entry => entry.id === id);
    assert.ok(line);
    assert.equal(line.fullMonthlyUsdCents, null);
    assert.equal(line.fullAnnualUsdCents, null);
    assert.equal(line.reserveReviewed, false);
  }
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
