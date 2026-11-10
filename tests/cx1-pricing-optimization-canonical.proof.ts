/**
 * The pricing optimization of 18 October 2026 (docs/pricing-optimization-2026-10-18.md):
 * an ANALYSIS, no price, limit, gate or tax assumption in code changes. The
 * program's input must be what the repository's margin code gives today, every
 * solution in its output must keep 60% under that code and equal the
 * exhaustive search, and the document must be what renders today. Regenerate
 * all three with `node scripts/pricing-optimization.mjs` (needs python3 with
 * scipy). This test needs no Python: it checks the solver's output, it does
 * not run the solver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_PRICES, TIERS } from "@/lib/plan";
import { MOST_TAX_READING } from "./historical-margin-model";
import {
  DOC_FILE, ELASTICITIES, INPUT_FILE, SAFETY_CENTS, dataset, exhaustive, hedonic, keeps, linearityGap, milpInput, milpOutput, minimaxRegret, ones,
  renderPricingOptimization, unitAt, verified,
} from "./pricing-optimization-table";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("the document is what the numbers render today", () => {
  assert.equal(read(DOC_FILE), renderPricingOptimization(), `${DOC_FILE} is stale: run node scripts/pricing-optimization.mjs`);
  assert.match(read(DOC_FILE), /\*\*An analysis for the owner, not a change\.\*\*/);
});

