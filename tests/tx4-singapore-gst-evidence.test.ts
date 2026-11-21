import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-singapore-gst-evidence.md", "utf8");

test("TX4 Singapore evidence dates official sources and preserves OVR classification boundaries", () => {
  const text = read();
  for (const source of [
    "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/gst-and-digital-economy/overseas-businesses",
    "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/completing-gst-returns",
    "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/gst-filing-due-dates-and-requests-for-extension",
    "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/basics-of-gst/invoicing-price-display-and-record-keeping/keeping-records",
    "https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/charging-gst-%28output-tax%29/foreign-currency-transactions",
  ]) assert.ok(text.includes(source), source);
  for (const fact of ["05/11/2026", "S$1 million", "S$100,000", "B2C", "B2B", "remote services", "low-value goods", "does not determine the LLC"]) assert.ok(text.includes(fact), fact);
});

test("TX4 Singapore evidence keeps supplier, marketplace and customer status conditional", () => {
  const text = read();
  for (const fact of ["non-GST registered", "GST registration number", "two pieces", "non-conflicting evidence", "billing address", "IP address", "credit card", "electronic marketplace operator", "Box 15", "direct"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not classify Marktmorgen's supplies, customers or marketplace role/);
  assert.match(text, /does not register, charge, collect, file or pay GST/);
});

test("TX4 Singapore evidence records recurring filing and record work without inventing a deletion schedule", () => {
  const text = read();
  for (const fact of ["one month", "Nil", "five years", "Singapore dollars", "approved exchange rate", "once every three months", "consistently", "not a deletion schedule", "after closure"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /actual accounting periods and due dates remain unverified/);
  assert.match(text, /does not change retention, storage location or deletion code/);
});

test("TX4 Singapore work never funds an unknown compliance ceiling or reallocates it", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of ["vat-oss-and-local-compliance", "unknown", "not zero", "100% Marktmorgen", "currency", "reserve", "professional review", "Owner-dependent", "No registration, submission, payment, account or external contact"]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|SGD|US\$|S\$)\s*0(?:[.,]0+)?\b/i);
});
