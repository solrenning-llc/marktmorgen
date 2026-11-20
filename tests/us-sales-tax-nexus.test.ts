/**
 * 9 [C-US] unit 2 (lib/us-sales-tax-nexus.ts): whether a state's sales tax must be collected on facilitated sales,
 * from complete synthetic ledgers and the per-state rules read on official pages (lib/us-sales-tax-rules.ts). It holds
 * that the three windows each count; that dollars, transactions and "and"/"or" follow the rule as read; that the
 * margin switches treatment on early; that every unknown refuses; that a state with no state sales tax adds no duty;
 * and that nothing reads the module yet. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TaxSalesLedger } from "@/lib/tax-sales-counter";
import { assessUsSalesTaxNexus, usSalesTaxSaleDecision, usSalesTaxWindows } from "@/lib/us-sales-tax-nexus";

const NOW = Date.parse("2026-11-20T15:00:00Z");
const W = usSalesTaxWindows(NOW);
type Window = keyof typeof W;

/** A complete USD ledger for one window of one state: `sales` entries of `cents` each, settled, applicable. */
function ledger(state: string, window: Window, sales: number, cents: number): TaxSalesLedger {
  const { start, end } = W[window];
  return {
    place: { country: "US", state },
    currency: "USD",
    periodStart: start,
    periodEnd: end,
    coverageFrom: start,
    coverageThrough: end,
    complete: true,
    entries: Array.from({ length: sales }, (_, i) => ({
      id: `${state}-${window}-${i}`,
      country: "US",
      state,
      currency: "USD",
      supplyOn: start,
      position: "settled" as const,
      amountMinor: cents,
      applicable: true,
    })),
  };
}
type Sales = Partial<Record<Window, [number, number]>>;
const evidence = (state: string, sales: Sales = {}, reviewed = true) => ({
  state,
  currentYear: ledger(state, "currentYear", ...(sales.currentYear ?? [0, 0])),
  previousYear: ledger(state, "previousYear", ...(sales.previousYear ?? [0, 0])),
  trailingTwelveMonths: ledger(state, "trailingTwelveMonths", ...(sales.trailingTwelveMonths ?? [0, 0])),
  applicableScopeReviewed: reviewed,
});
const status = (state: string, sales: Sales = {}, reviewed = true) => assessUsSalesTaxNexus(evidence(state, sales, reviewed), NOW).status;

test("the three windows are the current year to today, the whole previous year and the trailing twelve months", () => {
  assert.deepEqual(W, {
    currentYear: { start: "2026-01-01", end: "2026-11-20" },
    previousYear: { start: "2025-01-01", end: "2025-12-31" },
    trailingTwelveMonths: { start: "2025-11-21", end: "2026-11-20" },
  });
  // A leap day: a year earlier there is no 29 February, so the window starts the day after the 28th, the longer one.
  assert.equal(usSalesTaxWindows(Date.parse("2028-02-29T12:00:00Z")).trailingTwelveMonths.start, "2027-03-01");
  assert.equal(usSalesTaxWindows(Date.parse("2027-03-01T12:00:00Z")).trailingTwelveMonths.start, "2026-03-02");
  assert.equal(usSalesTaxWindows(Date.parse("2027-01-01T00:00:00Z")).trailingTwelveMonths.start, "2026-01-02");
});

test("dollars only (Texas, $500,000): met at the figure, near within the margin, in any window", () => {
  assert.equal(status("TX"), "below-threshold");
  assert.equal(status("TX", { currentYear: [1, 44_999_999] }), "below-threshold");
  assert.equal(status("TX", { currentYear: [1, 45_000_000] }), "approaching");
  assert.equal(status("TX", { currentYear: [1, 50_000_000] }), "treatment-required");
  // A busy previous year, or trailing months across the new year, require it too.
  assert.equal(status("TX", { previousYear: [2, 25_000_000] }), "treatment-required");
  assert.equal(status("TX", { trailingTwelveMonths: [5, 10_000_000] }), "treatment-required");
  // Thousands of small sales never meet a dollars-only rule by count.
  assert.equal(status("TX", { currentYear: [5_000, 100] }), "below-threshold");
});

test("dollars or transactions (Arkansas, $100,000 or 200): either one is enough", () => {
  assert.equal(status("AR", { currentYear: [200, 100] }), "treatment-required");
  assert.equal(status("AR", { currentYear: [1, 10_000_000] }), "treatment-required");
  assert.equal(status("AR", { currentYear: [180, 100] }), "approaching");
  assert.equal(status("AR", { currentYear: [10, 100] }), "below-threshold");
});

test("dollars and transactions (New York, $500,000 and 100): both are needed to meet, either one to be near", () => {
  assert.equal(status("NY", { currentYear: [101, 500_000] }), "treatment-required");
  assert.equal(status("NY", { currentYear: [1, 60_000_000] }), "approaching");
  assert.equal(status("NY", { currentYear: [150, 100] }), "approaching");
  assert.equal(status("NY", { currentYear: [10, 100] }), "below-threshold");
});

test("a facilitator's own threshold where it differs (Oklahoma, $10,000)", () => {
  assert.equal(status("OK", { currentYear: [1, 1_000_000] }), "treatment-required");
  assert.equal(status("OK", { currentYear: [1, 800_000] }), "below-threshold");
});

test("a state with no state sales tax adds no duty; Alaska's local regime still counts", () => {
  for (const state of ["DE", "MT", "OR"]) {
    const assessment = assessUsSalesTaxNexus(evidence(state, { currentYear: [500, 100_000_000] }), NOW);
    assert.equal(assessment.status, "no-state-sales-tax", state);
    assert.equal(usSalesTaxSaleDecision(assessment, false), "continue-untreated", state);
  }
  assert.equal(status("AK", { currentYear: [1, 10_000_000] }), "treatment-required");
});

test("every unknown refuses: unread state, unconfirmed duty or threshold, unreviewed scope, a ledger that is not the window", () => {
  for (const state of ["CO", "MA", "NH", "RI", "WY", "MD"]) assert.equal(status(state, { currentYear: [1, 100] }), "unknown", state);
  // Mississippi's facilitator duty was not confirmed on the pages read, though its threshold was.
  assert.equal(status("MS"), "unknown");
  // Arizona's facilitator duty was confirmed, its threshold was not.
  assert.equal(status("AZ"), "unknown");
  assert.equal(status("PR"), "unknown");
  assert.equal(status("TX", {}, false), "unknown");
  const wrongPeriod = { ...evidence("TX"), currentYear: ledger("TX", "previousYear", 0, 0) };
  assert.equal(assessUsSalesTaxNexus(wrongPeriod, NOW).status, "unknown");
  const wrongPlace = { ...evidence("TX"), previousYear: ledger("CA", "previousYear", 0, 0) };
  assert.equal(assessUsSalesTaxNexus(wrongPlace, NOW).status, "unknown");
  const incomplete = { ...evidence("TX"), trailingTwelveMonths: { ...ledger("TX", "trailingTwelveMonths", 1, 100), complete: false } };
  assert.equal(assessUsSalesTaxNexus(incomplete, NOW).status, "unknown");
  const euros = { ...evidence("TX"), currentYear: { ...ledger("TX", "currentYear", 0, 0), currency: "EUR" } };
  assert.equal(assessUsSalesTaxNexus(euros, NOW).status, "unknown");
  assert.equal(assessUsSalesTaxNexus({ ...evidence("TX"), extra: 1 }, NOW).status, "unknown");
  assert.equal(assessUsSalesTaxNexus(null, NOW).status, "unknown");
  assert.equal(assessUsSalesTaxNexus(evidence("TX"), Number.NaN).status, "invalid");
});

test("the sale decision: below goes on; near or over only with collection on; unknown refuses", () => {
  const at = (state: string, sales: Sales) => assessUsSalesTaxNexus(evidence(state, sales), NOW);
  assert.equal(usSalesTaxSaleDecision(at("TX", {}), false), "continue-untreated");
  assert.equal(usSalesTaxSaleDecision(at("TX", { currentYear: [1, 45_000_000] }), false), "refuse");
  assert.equal(usSalesTaxSaleDecision(at("TX", { currentYear: [1, 50_000_000] }), true), "treatment-on");
  assert.equal(usSalesTaxSaleDecision(at("TX", { currentYear: [1, 50_000_000] }), "yes"), "refuse");
  assert.equal(usSalesTaxSaleDecision(at("CO", {}), true), "refuse");
});

test("nothing reads the module yet: no checkout, counter store or flag", () => {
  const readers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && readFileSync(path, "utf8").includes("us-sales-tax-nexus")) readers.push(path);
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(dir);
  assert.deepEqual(readers.filter((path) => path !== join("lib", "us-sales-tax-nexus.ts")), []);
});
