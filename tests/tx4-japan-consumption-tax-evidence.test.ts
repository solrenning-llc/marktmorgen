import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-japan-consumption-tax-evidence.md", "utf8");

test("TX4 Japan evidence dates official sources and preserves classification boundaries", () => {
  const text = read();
  for (const source of [
    "https://www.nta.go.jp/english/taxes/consumption_tax/0024006-219.pdf",
    "https://www.nta.go.jp/english/taxes/consumption_tax/05.htm",
    "https://www.nta.go.jp/english/taxes/consumption_tax/PFQA_en_foreign.pdf",
    "https://www.nta.go.jp/english/taxes/consumption_tax/01.htm",
    "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6601.htm",
    "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6621.htm",
  ]) assert.ok(text.includes(source), source);
  for (const fact of ["05/11/2026", "July 2024", "B2B", "B2C", "objective and reasonable", "April 1, 2025", "specified platform", "does not determine the LLC"]) assert.ok(text.includes(fact), fact);
});

test("TX4 Japan evidence keeps provider, platform and filing duties conditional", () => {
  const text = read();
  for (const fact of ["10 million yen", "base period", "tax agent", "business year", "two months", "payment", "same", "actual account calendar", "direct", "reverse charge", "qualified invoice"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not classify Marktmorgen's supplies or customers/);
  assert.match(text, /does not appoint a tax agent or select a filing route/);
});

test("TX4 Japan evidence records qualified record work without inventing a deletion schedule", () => {
  const text = read();
  for (const fact of ["April 1, 2026", "seven years", "two months", "three months", "transaction date", "counterparty", "rate", "not a deletion schedule", "after closure"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not change retention, storage location or deletion code/);
  assert.match(text, /no-sales and no-tax-due condition/);
});

test("TX4 Japan work never funds an unknown compliance ceiling or reallocates it", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of ["vat-oss-and-local-compliance", "unknown", "not zero", "100% Marktmorgen", "currency", "reserve", "professional review", "Owner-dependent", "No registration, submission, payment, account or external contact"]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|JPY|US\$|¥)\s*0(?:[.,]0+)?\b/i);
});
