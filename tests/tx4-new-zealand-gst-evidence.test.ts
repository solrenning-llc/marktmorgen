import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-new-zealand-gst-evidence.md", "utf8");

test("TX4 New Zealand evidence dates primary guidance and preserves conditional applicability", () => {
  const text = read();
  for (const source of [
    "https://www.ird.govt.nz/gst-on-remote-services",
    "https://www.ird.govt.nz/gst/changing-your-filing-frequency-or-accounting-basis/changing-your-gst-filing-frequency",
    "https://www.ird.govt.nz/gst/filing-and-paying-gst-and-refunds/filing-gst",
    "https://www.ird.govt.nz/managing-my-tax/record-keeping",
    "https://www.legislation.govt.nz/act/public/1985/141/en/latest/sections/DLM85281/",
  ]) assert.ok(text.includes(source), source);
  for (const fact of ["05/11/2026", "12 September 2026", "31 March 2025", "23 June 2021", "14 May 2026", "GST-registered", "business use", "marketplace", "does not determine the LLC"]) assert.ok(text.includes(fact), fact);
});

test("TX4 New Zealand evidence retains nil returns and qualified filing dates without an account calendar", () => {
  const text = read();
  for (const fact of ["quarterly", "nil return", "28th", "31 March", "7 May", "30 November", "15 January", "same day", "no extension", "actual account", "calendar", "receipt"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /not a universal monthly, two-monthly or six-monthly choice/);
  assert.match(text, /not a verified working-day adjustment/);
});

test("TX4 New Zealand evidence discloses incomplete statutory access and preserves long-tail record work", () => {
  const text = read();
  for (const fact of ["seven tax years", "general guidance", "75(3F)", "403", "full current statutory wording remains unverified", "offshore", "language", "extensions", "not a deletion schedule", "after closure"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not impose a universal language or offshore-approval rule/);
  assert.match(text, /does not change retention, storage location or deletion code/);
});

test("TX4 New Zealand work never funds an unknown compliance ceiling or allocates it to another product", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of ["vat-oss-and-local-compliance", "unknown", "not zero", "100% Marktmorgen", "currency", "reserve", "storage", "Owner-dependent", "No registration, submission, payment, account or external contact"]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|NZD|US\$|NZ\$)\s*0(?:[.,]0+)?\b/i);
});
