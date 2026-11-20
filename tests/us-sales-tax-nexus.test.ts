/**
 * 9 [C-US] unit 2 (lib/us-sales-tax-nexus.ts): whether a state's sales tax must be collected on facilitated sales,
 * from one complete synthetic ledger and the per-state rules read on official pages (lib/us-sales-tax-rules.ts). It
 * holds that every period a state may name counts (the current and previous years, the trailing twelve months and the
 * twelve months ending at each recent month end, Connecticut's, New York's and Missouri's quarter-end periods
 * included); that dollars, transactions and "and"/"or" follow the rule as read; that the margin switches treatment on
 * early; that every unknown refuses; that a state with no state sales tax adds no duty; and that nothing reads the
 * module yet. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TaxSalesLedger } from "@/lib/tax-sales-counter";
import { assessUsSalesTaxNexus, usSalesTaxLookback, usSalesTaxSaleDecision, usSalesTaxWindows } from "@/lib/us-sales-tax-nexus";

const NOW = Date.parse("2026-11-20T15:00:00Z");
const LOOKBACK = usSalesTaxLookback(NOW);

/** A sale: its date, cents, how many identical sales, and its position (settled unless said). */
type Sale = { on: string; cents: number; count?: number; position?: "settled" | "reserved" | "proposed" };

/** One complete USD ledger over the whole lookback for one state. */
function ledger(state: string, sales: Sale[] = [], over = LOOKBACK): TaxSalesLedger {
  let id = 0;
  return {
    place: { country: "US", state },
    currency: "USD",
    periodStart: over.start,
    periodEnd: over.end,
    coverageFrom: over.start,
    coverageThrough: over.end,
    complete: true,
    entries: sales.flatMap((sale) =>
      Array.from({ length: sale.count ?? 1 }, () => ({
        id: `${state}-${(id += 1)}`,
        country: "US",
        state,
        currency: "USD",
        supplyOn: sale.on,
        position: sale.position ?? ("settled" as const),
        amountMinor: sale.cents,
        applicable: true,
      })),
    ),
  };
}
const evidence = (state: string, sales: Sale[] = [], reviewed = true) => ({ state, ledger: ledger(state, sales), applicableScopeReviewed: reviewed });
const status = (state: string, sales: Sale[] = [], reviewed = true) => assessUsSalesTaxNexus(evidence(state, sales, reviewed), NOW).status;

test("every window a state may name, and the one ledger interval that holds them", () => {
  const windows = usSalesTaxWindows(NOW);
  const byName = Object.fromEntries(windows.map((w) => [w.name, [w.start, w.end]]));
  assert.deepEqual(byName["current-year"], ["2026-01-01", "2026-11-20"]);
  assert.deepEqual(byName["previous-year"], ["2025-01-01", "2025-12-31"]);
  assert.deepEqual(byName["trailing-twelve-months"], ["2025-11-21", "2026-11-20"]);
  // Twelve months ending at each of the last twelve month ends: Connecticut's September 30, New York's quarters
  // (ending February, May, August, November) and every calendar quarter end are among them.
  assert.deepEqual(byName["twelve-months-to-2026-10-31"], ["2025-11-01", "2026-10-31"]);
  assert.deepEqual(byName["twelve-months-to-2026-09-30"], ["2025-10-01", "2026-09-30"]);
  assert.deepEqual(byName["twelve-months-to-2026-08-31"], ["2025-09-01", "2026-08-31"]);
  assert.deepEqual(byName["twelve-months-to-2025-11-30"], ["2024-12-01", "2025-11-30"]);
  assert.equal(windows.length, 15);
  assert.deepEqual(LOOKBACK, { start: "2024-12-01", end: "2026-11-20" });
  // A leap day: a year earlier there is no 29 February, so the trailing window starts the day after the 28th.
  const leap = usSalesTaxWindows(Date.parse("2028-02-29T12:00:00Z")).find((w) => w.name === "trailing-twelve-months")!;
  assert.equal(leap.start, "2027-03-01");
  // At a year's start, the month-end windows reach back into the year before last.
  // On 1 January 2027 the oldest is the twelve months to 31 January 2026, from 1 February 2025.
  assert.deepEqual(usSalesTaxLookback(Date.parse("2027-01-01T00:00:00Z")), { start: "2025-02-01", end: "2027-01-01" });
});

test("Claude 3's MEDIUM on #4961: a period ending at a quarter's end counts, though no year or trailing window holds it", () => {
  // Connecticut ($250,000): $130,000 on 15 Oct 2025 and $130,000 on 15 Jun 2026. Each calendar year and the trailing
  // twelve months hold $130,000, but Connecticut's own 1 Oct 2025 – 30 Sep 2026 holds $260,000.
  const split: Sale[] = [{ on: "2025-10-15", cents: 13_000_000 }, { on: "2026-06-15", cents: 13_000_000 }];
  const assessment = assessUsSalesTaxNexus(evidence("CT", split), NOW);
  assert.equal(assessment.status, "treatment-required");
  assert.ok(assessment.reasons.includes("twelve-months-to-2026-09-30-threshold-met"));
  assert.equal(usSalesTaxSaleDecision(assessment, false), "refuse");
  // New York ($500,000 and 100): 101 sales of $5,000 between 1 Sep 2025 and 31 Aug 2026, its four quarters ending in
  // August. The previous year holds 60 ($300,000); the current year and the trailing twelve months hold 41 ($205,000).
  const quarters: Sale[] = [{ on: "2025-09-10", cents: 500_000, count: 60 }, { on: "2026-08-20", cents: 500_000, count: 41 }];
  const ny = assessUsSalesTaxNexus(evidence("NY", quarters), NOW);
  assert.equal(ny.status, "treatment-required");
  assert.ok(ny.reasons.includes("twelve-months-to-2026-08-31-threshold-met"));
});

test("dollars only (Texas, $500,000): met at the figure, near within the margin, in any window", () => {
  assert.equal(status("TX"), "below-threshold");
  assert.equal(status("TX", [{ on: "2026-03-01", cents: 44_999_999 }]), "below-threshold");
  assert.equal(status("TX", [{ on: "2026-03-01", cents: 45_000_000 }]), "approaching");
  assert.equal(status("TX", [{ on: "2026-03-01", cents: 50_000_000 }]), "treatment-required");
  // A busy previous year, or a twelve-month stretch across the new year, require it too.
  assert.equal(status("TX", [{ on: "2025-02-01", cents: 25_000_000, count: 2 }]), "treatment-required");
  assert.equal(status("TX", [{ on: "2025-12-01", cents: 25_000_000 }, { on: "2026-02-01", cents: 25_000_000 }]), "treatment-required");
  // Sales older than any window never count.
  assert.equal(status("TX", [{ on: "2024-12-02", cents: 1_000 }]), "below-threshold");
  // Thousands of small sales never meet a dollars-only rule by count.
  assert.equal(status("TX", [{ on: "2026-03-01", cents: 100, count: 5_000 }]), "below-threshold");
});

test("a pending supply counts in the windows that end today", () => {
  assert.equal(status("TX", [{ on: "2026-11-20", cents: 50_000_000, position: "reserved" }]), "treatment-required");
  assert.equal(status("TX", [{ on: "2026-11-20", cents: 45_000_000, position: "proposed" }]), "approaching");
});

test("Claude 2's MEDIUM on #4961: a December supply still pending in January is counted, not unknown", () => {
  const jan2 = Date.parse("2027-01-02T12:00:00Z");
  const over = usSalesTaxLookback(jan2);
  const at = (sales: Sale[]) => assessUsSalesTaxNexus({ state: "TX", ledger: ledger("TX", sales, over), applicableScopeReviewed: true }, jan2);
  // The probe from the review: one reserved $10 on 31 December was "current-year-unknown"; it is below the limit, as settled.
  assert.equal(at([{ on: "2026-12-31", cents: 1_000, position: "reserved" }]).status, "below-threshold");
  assert.equal(at([{ on: "2026-12-31", cents: 1_000 }]).status, "below-threshold");
  // Still counted where it falls: a pending December supply alone at Texas's $500,000 switches treatment on.
  assert.equal(at([{ on: "2026-12-31", cents: 50_000_000, position: "reserved" }]).status, "treatment-required");
  assert.equal(at([{ on: "2026-12-15", cents: 45_000_000, position: "proposed" }]).status, "approaching");
  // A pending supply dated before the trailing twelve months is counted nowhere: unknown, never zero.
  const early = at([{ on: "2025-12-01", cents: 100, position: "reserved" }]);
  assert.deepEqual([early.status, early.reasons], ["unknown", ["pending-before-trailing-twelve-months"]]);
});

test("dollars or transactions (Arkansas, $100,000 or 200): either one is enough", () => {
  assert.equal(status("AR", [{ on: "2026-05-01", cents: 100, count: 200 }]), "treatment-required");
  assert.equal(status("AR", [{ on: "2026-05-01", cents: 10_000_000 }]), "treatment-required");
  assert.equal(status("AR", [{ on: "2026-05-01", cents: 100, count: 180 }]), "approaching");
  assert.equal(status("AR", [{ on: "2026-05-01", cents: 100, count: 10 }]), "below-threshold");
});

test("dollars and transactions (New York, $500,000 and 100): both are needed to meet, either one to be near", () => {
  assert.equal(status("NY", [{ on: "2026-05-01", cents: 500_000, count: 101 }]), "treatment-required");
  assert.equal(status("NY", [{ on: "2026-05-01", cents: 60_000_000 }]), "approaching");
  assert.equal(status("NY", [{ on: "2026-05-01", cents: 100, count: 150 }]), "approaching");
  assert.equal(status("NY", [{ on: "2026-05-01", cents: 100, count: 10 }]), "below-threshold");
});

test("a facilitator's own threshold where it differs (Oklahoma, $10,000)", () => {
  assert.equal(status("OK", [{ on: "2026-05-01", cents: 1_000_000 }]), "treatment-required");
  assert.equal(status("OK", [{ on: "2026-05-01", cents: 800_000 }]), "below-threshold");
});

test("a state with no state sales tax adds no duty; Alaska's local regime still counts", () => {
  for (const state of ["DE", "MT", "OR"]) {
    const assessment = assessUsSalesTaxNexus(evidence(state, [{ on: "2026-05-01", cents: 100_000_000, count: 500 }]), NOW);
    assert.equal(assessment.status, "no-state-sales-tax", state);
    assert.equal(usSalesTaxSaleDecision(assessment, false), "continue-untreated", state);
  }
  assert.equal(status("AK", [{ on: "2026-05-01", cents: 10_000_000 }]), "treatment-required");
});

test("every unknown refuses: unread state, unconfirmed duty or threshold, unreviewed scope, a ledger that is not the lookback", () => {
  for (const state of ["CO", "MA", "NH", "RI", "WY", "MD"]) assert.equal(status(state, [{ on: "2026-05-01", cents: 100 }]), "unknown", state);
  // Mississippi's facilitator duty was not confirmed on the pages read, though its threshold was.
  assert.equal(status("MS"), "unknown");
  // Arizona's facilitator duty was confirmed, its threshold was not.
  assert.equal(status("AZ"), "unknown");
  assert.equal(status("PR"), "unknown");
  assert.equal(status("TX", [], false), "unknown");
  const shorter = { ...evidence("TX"), ledger: ledger("TX", [], { start: "2025-01-01", end: LOOKBACK.end }) };
  assert.equal(assessUsSalesTaxNexus(shorter, NOW).status, "unknown");
  const wrongPlace = { ...evidence("TX"), ledger: ledger("CA") };
  assert.equal(assessUsSalesTaxNexus(wrongPlace, NOW).status, "unknown");
  const incomplete = { ...evidence("TX"), ledger: { ...ledger("TX"), complete: false } };
  assert.equal(assessUsSalesTaxNexus(incomplete, NOW).status, "unknown");
  const euros = { ...evidence("TX"), ledger: { ...ledger("TX"), currency: "EUR" } };
  assert.equal(assessUsSalesTaxNexus(euros, NOW).status, "unknown");
  // A pending supply dated before the trailing twelve months cannot belong to a window ending today: refused.
  assert.equal(status("TX", [{ on: "2025-06-01", cents: 100, position: "reserved" }]), "unknown");
  assert.equal(assessUsSalesTaxNexus({ ...evidence("TX"), extra: 1 }, NOW).status, "unknown");
  assert.equal(assessUsSalesTaxNexus(null, NOW).status, "unknown");
  assert.equal(assessUsSalesTaxNexus(evidence("TX"), Number.NaN).status, "invalid");
});

test("the sale decision: below goes on; near or over only with collection on; unknown refuses", () => {
  const at = (state: string, sales: Sale[]) => assessUsSalesTaxNexus(evidence(state, sales), NOW);
  assert.equal(usSalesTaxSaleDecision(at("TX", []), false), "continue-untreated");
  assert.equal(usSalesTaxSaleDecision(at("TX", [{ on: "2026-05-01", cents: 45_000_000 }]), false), "refuse");
  assert.equal(usSalesTaxSaleDecision(at("TX", [{ on: "2026-05-01", cents: 50_000_000 }]), true), "treatment-on");
  assert.equal(usSalesTaxSaleDecision(at("TX", [{ on: "2026-05-01", cents: 50_000_000 }]), "yes"), "refuse");
  assert.equal(usSalesTaxSaleDecision(at("CO", []), true), "refuse");
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
