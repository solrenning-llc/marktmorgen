import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS } from "../lib/llc-fixed-costs";

const path = "docs/tx4-canada-gst-hst-evidence.md";
const document = existsSync(path) ? readFileSync(path, "utf8") : "";

test("TX4 dates primary Canadian sources without selecting a registration regime", () => {
  for (const fact of [
    "Read on 5 November 2026",
    "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/find-out-need-register.html",
    "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/file-return.html",
    "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/remit-gst-hst.html",
    "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/keeping-records/where-keep-your-records-long-request-permission-destroy-them-early.html",
    "simplified and normal GST/HST",
    "not a conclusion about this LLC",
    "provincial obligations remain unverified",
  ]) assert.ok(document.includes(fact), fact);
});

test("TX4 separates quarterly filing, payment, retention and designated currency evidence", () => {
  for (const fact of [
    "calendar quarter",
    "within one month",
    "April 30", "July 31", "October 31", "January 31",
    "GST/HST NETFILE",
    "return's due date",
    "confirmation number",
    "filing confirmation is not proof of payment",
    "six years from the end of the last year",
    "longer retention can apply",
    "Canadian dollars unless a qualifying foreign currency designation is approved",
    "USD and EUR",
    "does not presume that designation was requested or granted",
  ]) assert.ok(document.includes(fact), fact);
});

test("TX4 leaves complete local compliance costs unknown and unreserved", () => {
  for (const fact of [
    "preparation and review", "recordkeeping", "corrections",
    "currency conversion and payment processing", "reserve timing",
    "complete monetary ceiling remains unknown and unreserved",
    "does not establish a zero compliance cost",
    "No account, registration, submission, payment or external contact",
    "100% Marktmorgen", "TX4 remains incomplete",
  ]) assert.ok(document.includes(fact), fact);
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(line => line.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.equal(line.fullMonthlyUsdCents, null);
  assert.equal(line.fullAnnualUsdCents, null);
  assert.equal(line.reserveReviewed, false);
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
