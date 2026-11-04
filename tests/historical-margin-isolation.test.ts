import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { unitUnder as currentUnitUnder, SIZING_READING, FLOOR_BPS as currentFloor } from "./historical-receiving-model";
import { unitUnder as archivedUnitUnder, FLOOR_BPS as archivedFloor, HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";

test("the superseded target reproduces history without changing the single receiving or tax model", () => {
  const current = currentUnitUnder(10000, 4000, SIZING_READING, true);
  const archived = archivedUnitUnder(10000, 4000, SIZING_READING, true);
  assert.equal(currentFloor, 0); assert.equal(archivedFloor, 6000);
  assert.equal(current.meetsFloor, true); assert.equal(archived.meetsFloor, false);
  for (const key of ["revenueCents", "chargedCents", "feeCents", "remittanceCents", "refundReserveCents",
    "disputeReserveCents", "totalCents", "usageCents", "costCents", "pretaxCents", "taxCents", "netCents", "netBps"] as const) {
    assert.equal(archived[key], current[key], key);
  }
});
test("production code cannot import the archived target or its price proposals", () => {
  const failures: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
        const source = readFileSync(path, "utf8");
        if (/from\s*["'][^"']*(?:historical-(?:(?:margin|receiving)-model|worst-case-policy)|tests\/(?:pricing-usage-proposal|pack-cost-decomposition|limits-proposal|per-use-resale|pricing-optimization))/.test(source)) failures.push(path);
      }
    }
  };
  for (const dir of ["lib", "app", "components"]) visit(join(process.cwd(), dir));
  assert.deepEqual(failures, []);
});
test("each dated analysis is labeled historical and never becomes a new price proposal", () => {
  for (const name of ["limits-proposal", "pricing-usage-proposal", "pack-cost-decomposition", "per-use-resale", "pricing-optimization"]) {
    const doc = readFileSync(join(process.cwd(), "docs", name + "-2026-10-18.md"), "utf8");
    assert.ok(doc.startsWith(HISTORICAL_MARGIN_NOTICE), name);
  }
  assert.match(HISTORICAL_MARGIN_NOTICE, /not a new price or limit proposal/i);
});
