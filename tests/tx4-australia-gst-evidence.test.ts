import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-australia-gst-evidence.md", "utf8");

test("Australian GST evidence identifies dated primary sources without selecting the LLC's treatment", () => {
  const text = read();
  for (const source of [
    "https://softwaredevelopers.ato.gov.au/GSTintangibles",
    "https://business.gov.au/finance/tax/international-tax",
    "https://www.legislation.gov.au/C1953A00001/2026-08-27/2026-08-27/text/original/epub/OEBPS/document_3/document_3.html",
  ]) assert.ok(text.includes(source), source);
  for (const fact of ["05/11/2026", "17 April 2020", "27 August 2026", "electronic distribution platform", "applicability remains unknown"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not establish.*LLC.*registration/i);
});

test("Australian GST evidence separates established recurrence from unverified filing details", () => {
  const text = read();
  for (const fact of ["quarterly", "simplified", "standard", "403", "nil-return", "deadline", "not verified", "not a filing calendar"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /do not import.*standard BAS.*simplified/i);
  assert.doesNotMatch(text, /(?:due|deadline)\s+(?:is|on)\s+28\s+(?:January|February)/i);
});

test("Australian record evidence keeps the longer review period and qualified exceptions", () => {
  const text = read();
  for (const fact of ["382-5", "five years", "longest", "assessment", "amendment", "English", "finally dissolved", "closure is not proof of final dissolution"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not change.*retention.*code/i);
});

test("Australian GST work is not a zero cost, funded reserve or finite customer base", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find((row) => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of ["vat-oss-and-local-compliance", "unknown, never zero", "100% Marktmorgen", "FX", "storage", "owner decision", "No registration, submission, payment, account or external contact"]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|AUD|US\$|A\$)\s*0(?:[,.]0+)?\b/i);
});
