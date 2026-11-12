import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-ireland-vat-evidence.md", "utf8");

test("TX4 Irish ordinary VAT evidence dates official sources and reuses the separate OSS study", () => {
  const text = read();
  for (const source of [
    "https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/when-vat-becomes-payable.aspx",
    "https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/completing-vat3-return.aspx",
    "https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part09-obligations-accountable-persons/Return/VAT-RTD-S76.pdf",
    "https://www.revenue.ie/en/vat/vat-records-invoices-credit-notes/vat-records-to-be-kept/index.aspx",
    "https://www.revenue.ie/en/vat/vat-records-invoices-credit-notes/vat-records-to-be-kept/how-long-keep-records.aspx",
  ]) assert.ok(text.includes(source), source);
  for (const fact of ["05/11/2026", "28 July 2026", "February 2026", "27 April 2026", "tx4-oss-evidence.md"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not determine the LLC's registration/);
  assert.match(text, /Non-Union OSS.*does not by itself establish.*VAT3 or RTD/);
});

test("TX4 Irish filing evidence keeps zero-tax returns and conditional deadlines distinct", () => {
  const text = read();
  for (const fact of ["two-month", "19th", "23rd", "Collector-General", "four-monthly", "six-monthly", "monthly", "T1, T2, T3 and T4", "literal word", "nil", "annual", "VAT year end may differ", "financial year end", "19 days", "23 September", "No Trade Details to Declare"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /OSS-accounted.*excluded from the RTD/);
  assert.match(text, /not a calendar assigned to the LLC/);
  assert.doesNotMatch(text, /(?:LLC|Marktmorgen)\s+(?:must|will)\s+(?:file|register|pay)/i);
});

test("TX4 Irish record evidence preserves exception-specific clocks without choosing deletion or hosting", () => {
  const text = read();
  for (const fact of ["six years or until", "claim, appeal or inquiry", "written permission", "paper", "electronic invoicing rules", "not a universal six-year deletion rule", "ten-year", "after closure"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not change retention, storage location or deletion code/);
});

test("TX4 Irish local compliance leaves the existing complete cost unknown and entirely company-funded", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of ["vat-oss-and-local-compliance", "unknown, never zero", "100% Marktmorgen", "currency", "storage", "reserve", "Owner-dependent", "No registration, submission, payment, account or external contact"]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|EUR|US\$|€)\s*0(?:[.,]0+)?\b/i);
});
