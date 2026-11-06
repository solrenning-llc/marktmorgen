import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS, FIXED_COST_SOURCE_OBSERVATIONS } from "../lib/llc-fixed-costs";

const path = "docs/tx4-delaware-evidence.md";
const document = existsSync(path) ? readFileSync(path, "utf8") : "";

test("TX4 dates the LLC tax and reconciles the official legacy FAQ against enacted law", () => {
  for (const fact of [
    "Read on 5 November 2026",
    "https://corp.delaware.gov/alt-entitytaxinstructions/",
    "https://delcode.delaware.gov/title6/c018/sc11/index.html",
    "https://legis.delaware.gov/SessionLaws/Chapter?id=42436",
    "85 Del. Laws, chapter 273",
    "sections 23 and 45",
    "approved 21 May 2026",
    "effective 1 January 2026",
    "USD 400",
    "USD 300",
    "https://corp.delaware.gov/taxfaq/",
    "does not determine any historical assessment for this LLC",
  ]) assert.ok(document.includes(fact), fact);
  assert.equal(FIXED_COST_SOURCE_OBSERVATIONS.delaware.annualMinor, 40000);
});

test("TX4 distinguishes the LLC's annual tax from a corporation's annual report and funded monthly accrual", () => {
  for (const fact of [
    "domestic LLCs and foreign LLCs registered in Delaware",
    "no Annual Report",
    "1 June following the close of the calendar year",
    "no proration",
    "active at any time from 1 January through 31 December",
    "before the cancellation filing",
    "registered series",
    "USD 100",
    "not an approved monthly expense or a funded reserve",
    "does not establish formation, registration, good standing or payment",
  ]) assert.ok(document.includes(fact), fact);
});

test("TX4 preserves late-payment exposure and keeps the complete Delaware compliance budget unknown", () => {
  for (const fact of [
    "USD 200",
    "1.5%",
    "tax and penalty",
    "each month or portion",
    "preparation and review",
    "registered-agent work",
    "recordkeeping",
    "currency conversion and reserve timing",
    "complete monetary ceiling remains unknown and unreserved",
    "does not establish a zero compliance cost",
    "No payment or account access",
    "TX4 remains incomplete",
  ]) assert.ok(document.includes(fact), fact);
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(line => line.id === "delaware");
  assert.ok(line);
  assert.equal(line.fullMonthlyUsdCents, null);
  assert.equal(line.fullAnnualUsdCents, null);
  assert.equal(line.reserveReviewed, false);
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
