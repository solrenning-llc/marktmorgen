import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-south-africa-vat-evidence.md", "utf8");

test("TX4 South Africa evidence dates official sources and reconciles the current threshold", () => {
  const text = read();
  for (const source of [
    "https://www.sars.gov.za/types-of-tax/value-added-tax/register-for-vat/",
    "https://www.sars.gov.za/businesses-and-employers/my-business-and-tax/vat-connect-issue-21-september-2026/",
    "https://www.sars.gov.za/wp-content/uploads/Ops/Guides/Legal-Pub-FAQs-VAT02-FAQs-VAT-on-Supplies-of-Electronic-Services.pdf",
    "https://www.sars.gov.za/businesses-and-employers/my-business-and-tax/vat-connect-issue-19-june-2025/",
    "https://www.sars.gov.za/types-of-tax/value-added-tax/obligations-of-a-vat-vendor/",
    "https://www.sars.gov.za/client-segments/record-keeping/",
    "https://www.sars.gov.za/wp-content/uploads/Legal/Rulings/BGR/Legal-R-BGR-28-Electronic-services-Requirements-relating-to-credit-and-debit-notes-exchange-rates-and-advertised-or-quoted-prices.pdf",
  ]) assert.ok(text.includes(source), source);
  for (const fact of ["05/11/2026", "R2.3 million", "R1 million", "1 April 2026", "outdated", "two out of three", "does not determine the LLC"]) assert.ok(text.includes(fact), fact);
});

test("TX4 South Africa evidence keeps location, B2B and intermediary treatment conditional", () => {
  const text = read();
  for (const fact of ["resident of South Africa", "registered bank", "business, residential or postal address", "1 April 2025", "VAT-registered vendors", "imported services", "intermediary", "written agreement", "jointly and severally liable", "direct"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not classify Marktmorgen's supplies, recipients or intermediary role/);
  assert.match(text, /does not register, charge, collect, file or pay VAT/);
});

test("TX4 South Africa evidence records recurring return, record and currency work without inventing a schedule", () => {
  const text = read();
  for (const fact of ["VAT201", "every tax period", "25th day", "last business day", "five years", "outside South Africa", "South African rand", "exchange rate", "South African Reserve Bank", "Bloomberg", "European Central Bank", "not a deletion schedule", "after closure"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /actual tax periods and due dates remain unverified/);
  assert.match(text, /does not change retention, storage location or deletion code/);
});

test("TX4 South Africa work never funds an unknown compliance ceiling or reallocates it", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of ["vat-oss-and-local-compliance", "unknown", "not zero", "100% Marktmorgen", "currency", "reserve", "professional review", "Owner-dependent", "No registration, submission, payment, account or external contact"]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|ZAR|US\$|R)\s*0(?:[.,]0+)?\b/i);
});
