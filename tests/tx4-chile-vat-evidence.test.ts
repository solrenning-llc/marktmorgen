import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS } from "../lib/llc-fixed-costs";

const path = "docs/tx4-chile-vat-evidence.md";
test("Chile evidence dates original Spanish rules and separates the platform transition", () => {
  const doc = readFileSync(path, "utf8");
  for (const text of ["Read on November 5, 2026", "reso107.pdf", "reso84.pdf", "reso93.pdf", "November 14, 2024", "July 10, 2025", "July 30, 2025", "October 25, 2025", "non-authoritative free translations", "own services versus intermediation", "classification remains unverified"]) assert.ok(doc.includes(text), text);
});
test("Chile evidence preserves return periods, currency, no-activity limits and payment uncertainty", () => {
  const doc = readFileSync(path, "utf8");
  for (const text of ["F129", "one or three consecutive months", "1st through the 20th", "US dollars, euros or Chilean pesos", "January 21-31", "no taxable operations", "not a blanket exemption", "filing is not confirmed payment", "records and retention remain unverified"]) assert.ok(doc.includes(text), text);
});
test("Chile public evidence cannot fill or fund the complete compliance ceiling", () => {
  const doc = readFileSync(path, "utf8");
  for (const text of ["unknown and unreserved", "100% Marktmorgen", "No account, registration, filing, payment or external contact", "TX4 remains incomplete"]) assert.ok(doc.includes(text), text);
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.equal(line.fullMonthlyUsdCents, null);
  assert.equal(line.fullAnnualUsdCents, null);
  assert.equal(line.reserveReviewed, false);
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
test("Chile evidence says no registration threshold was found and the statute was not read", () => {
  const doc = readFileSync(path, "utf8");
  for (const text of ["No monetary registration threshold was identified in the sources read", "must not be gated on a sales counter", "Statute not read"]) assert.ok(doc.includes(text), text);
});
// Board #5285, row #2633 (Claude 5's LOWs #3 and #4 on #2633): phrases being present never proved the note free of
// an added conclusion or a zero cost, and the note had no owner-dependent list, unlike the other TX4 notes.
test("Chile evidence adds no zero cost and no conclusion about the LLC, and lists what depends on the owner", () => {
  const doc = readFileSync(path, "utf8");
  assert.doesNotMatch(doc, /(?:USD|EUR|CLP|US\$|€|\$)\s*0(?:[.,]0+)?\b/i);
  assert.doesNotMatch(doc, /(?:LLC|Marktmorgen)\s+(?:is|are)\s+(?:not\s+(?:a|the)\s+(?:digital\s+intermediation\s+)?platform|exempt|below)/i);
  assert.doesNotMatch(doc, /(?:LLC|Marktmorgen)\s+(?:must|will|need(?:s)? to)\s+(?:file|register|appoint|pay)/i);
  for (const text of ["Owner-dependent", "reviewed legal facts", "complete funded cost evidence", "not compliance, profitability, deployment or customer-availability certification"]) assert.ok(doc.includes(text), text);
});
