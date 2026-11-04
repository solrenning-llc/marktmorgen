import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const document = readFileSync("docs/llc-fixed-costs-2026-10-22.md", "utf8");
const heading = "## TX4 — official U.S. federal filing evidence (4 November 2026)";

function evidenceSection(): string {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, "the dated TX4 evidence section is missing");
  const next = document.indexOf("\n\n> **TX vigente", start + heading.length);
  assert.notEqual(next, -1, "the TX4 evidence section has no closing boundary");
  return document.slice(start, next);
}

test("TX4 records the conditional Form 5472 and pro forma Form 1120 filing rules from official sources", () => {
  const section = evidenceSection();
  for (const fact of [
    "https://www.irs.gov/instructions/i5472",
    "Instructions for Form 5472 (Rev. December 2024)",
    "foreign-owned U.S. disregarded entity",
    "reportable transaction",
    "formation, dissolution, acquisition and disposition",
    "contributions and distributions",
    "pro forma Form 1120",
    "name and address and items B and E",
    "same tax year as its owner for U.S. filing purposes or, if none, the calendar year",
  ]) assert.ok(section.includes(fact), fact);
  assert.match(section, /does not determine whether Marktmorgen LLC meets those conditions/i);
});

test("TX4 records the official due-date, extension and foreign-owned-DE delivery rules", () => {
  const section = evidenceSection();
  for (const fact of [
    "https://www.irs.gov/instructions/i1120",
    "15th day of the 4th month after the end of the tax year",
    "Saturday, Sunday or legal holiday",
    "next business day",
    "Form 7004",
    "regular due date",
    "cannot file Form 5472 electronically",
    "Fax at 300 DPI or higher to 855-887-7737",
    "1973 Rulon White Blvd, M/S 6112 Attn: PIN Unit, Ogden, UT 84201",
  ]) assert.ok(section.includes(fact), fact);
});

test("TX4 keeps the penalty exposure and every unpriced compliance component explicit", () => {
  const section = evidenceSection();
  for (const fact of [
    "https://www.irs.gov/payments/international-information-reporting-penalties",
    "$25,000",
    "substantially incomplete",
    "90 days",
    "each 30-day period or part",
    "no maximum penalty amount",
    "required records",
    "preparation and review",
    "recordkeeping",
    "fax or postage",
    "software or professional help",
    "taxes, currency conversion and reserve timing",
    "complete monetary ceiling remains unknown and unreserved",
  ]) assert.ok(section.includes(fact), fact);
  assert.doesNotMatch(section, /(?:\$|US\$|USD\s*)0\b|\b(?:free|no-cost|gratuit[oa])\b/i);
  assert.match(section, /does not establish that any filing, government, preparation or delivery cost is zero/i);
});
