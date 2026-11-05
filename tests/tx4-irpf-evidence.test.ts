import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS } from "../lib/llc-fixed-costs";

const path = "docs/tx4-irpf-evidence.md";
const document = existsSync(path) ? readFileSync(path, "utf8") : "";

test("TX4 distinguishes the verified IRPF exercise from the LLC's current calendar year", () => {
  for (const fact of [
    "Read on 5 November 2026",
    "IN RFB 2.312/2026",
    "exercise 2026, calendar year 2025",
    "arts. 1, 2, 7 and 11",
    "23 March through 29 May 2026",
    "2027 deadline remains unverified",
    "transparency election",
    "foreign profits or dividends",
    "CBE thresholds do not establish an IRPF exemption",
  ]) assert.ok(document.includes(fact), fact);
  assert.match(document, /does not establish the owner's residence, ownership, acquisition date or filing obligation/);
});

test("TX4 preserves official ownership reporting, record and currency evidence without choosing a form code", () => {
  for (const fact of [
    "p-r-irpf-2026-v1-00-2026-04-23.pdf",
    "question 475",
    "Grupo 03",
    "Titular or Dependente",
    "country, legal name, ownership percentage, direct or indirect control and acquisition date",
    "31 December 2024 and 31 December 2025",
    "capital contributions, capital reductions and distributions",
    "BCB selling exchange rate at the taxable event",
    "does not select the LLC's specific code",
    "profit balances and comprehensive-income records",
  ]) assert.ok(document.includes(fact), fact);
});

test("Brazilian transparency is an explicit enduring election, never inferred from U.S. disregarded status", () => {
  for (const fact of [
    "Lei 14.754/2023, art. 8",
    "lei-14754-12-dezembro-2023-795058-normaatualizada-pl.pdf",
    "irrevocable and irreversible",
    "all Brazilian-resident individual co-owners",
    "first DAA after acquisition",
    "underlying assets, rights and obligations",
    "does not infer a Brazilian transparency election from U.S. disregarded-entity treatment",
    "No election or filing is made",
  ]) assert.ok(document.includes(fact), fact);
});

test("Documentary evidence cannot approve the unpriced IRPF cost or a complete LLC budget", () => {
  for (const fact of [
    "br-irpf",
    "preparation and review",
    "bookkeeping and foreign-exchange reconciliation",
    "software or professional help",
    "recordkeeping and corrections",
    "taxes, currency conversion and reserve timing",
    "complete monetary ceiling remains unknown and unreserved",
    "CBE and U.S. federal returns remain separate obligations",
    "does not establish any government, preparation or delivery cost as zero",
    "TX4 remains incomplete",
  ]) assert.ok(document.includes(fact), fact);
  const current = CURRENT_LLC_FIXED_COST_CEILINGS.find(line => line.id === "br-irpf");
  assert.ok(current);
  assert.equal(current.fullMonthlyUsdCents, null);
  assert.equal(current.fullAnnualUsdCents, null);
  assert.equal(current.reserveReviewed, false);
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
