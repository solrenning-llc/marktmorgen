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

test("it changes nothing in force: today's prices, and nothing on sale", () => {
  assert.deepEqual(PLAN_PRICES, { creator: { month: 6900, year: 69000 }, pro: { month: 44900, year: 449000 }, scale: { month: 99900, year: 999000 } });
  assert.equal(PLANS_ON_SALE, false);
});

test("the program's input is what the repository's margin code gives today (run node scripts/pricing-optimization.mjs)", () => {
  // Numbers are compared to a part in a billion: floating-point functions may differ in their last bit between Node versions.
  const close = (a: unknown, b: unknown, path: string): void => {
    if (typeof a === "number" && typeof b === "number") { assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)), `${INPUT_FILE} is stale at ${path}: ${a} against ${b}`); return; }
    if (a && b && typeof a === "object" && typeof b === "object") {
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${INPUT_FILE} is stale at ${path}`);
      for (const k of Object.keys(a)) close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      return;
    }
    assert.equal(a, b, `${INPUT_FILE} is stale at ${path}`);
  };
  close(JSON.parse(read(INPUT_FILE)), JSON.parse(JSON.stringify(milpInput())), "input");
  assert.ok(SAFETY_CENTS >= 5, "the actual solver deducts at least five cents on both intervals");
  assert.ok(linearityGap() < SAFETY_CENTS, "the linear usage stays strictly inside the deducted safety reserve");
});

test("every solution keeps 60% at full use on both intervals, fails the most-tax gate, respects the plan order, and equals the exhaustive search", () => {
  const out = milpOutput();
  assert.equal(out.solutions.length, ELASTICITIES.length * 2);
  for (const sol of out.solutions) {
    assert.match(sol.status, /optimal/i, `${sol.scenario} ${sol.alternative}`);
    const v = verified(sol);
    for (const x of v) {
      assert.ok(x.keeps && x.month.netBps >= 6_000 && x.year.netBps >= 6_000, `${sol.scenario} ${sol.alternative} ${x.tier}`);
      assert.equal(unitAt(x.tier, "month", x.monthCents, x.shares, 0, MOST_TAX_READING).meetsFloor, false);
      if (sol.alternative === "A") assert.deepEqual(x.shares, ones(), "A cuts nothing");
      const ex = exhaustive(x.tier, sol.alternative, Number(sol.scenario))!;
      assert.equal(x.monthCents, ex.monthCents, `${sol.scenario} ${sol.alternative} ${x.tier} matches the exhaustive search`);
    }
    assert.ok(v[0].monthCents < v[1].monthCents && v[1].monthCents < v[2].monthCents, "prices rise from plan to plan");
  }
});

test("the recommendation keeps every #553 figure and 60% on both intervals", () => {
  for (const tier of TIERS) {
    const r = minimaxRegret(tier);
    assert.ok(keeps(tier, r.monthCents, ones()));
    assert.ok(r.regret >= 0 && r.regret < 1);
  }
});

test("every competitor figure has its page and its day, and the regression reports its size", () => {
  const d = dataset();
  for (const p of d.plans) for (const id of p.sources) assert.ok(d.sources.some((s) => s.id === id && /^https:\/\//.test(s.url) && /2026/.test(s.read)), `${p.vendor} ${p.plan}: ${id}`);
  for (const b of d.brand) if (b.source) assert.ok(d.sources.some((s) => s.id === b.source));
  const main = hedonic("monthly");
  assert.ok(main.n >= 20 && main.n > main.k);
  assert.ok(main.r2 > 0 && main.r2 < 1);
});

test("the document is what the numbers render today", () => {
  assert.equal(read(DOC_FILE), renderPricingOptimization(), `${DOC_FILE} is stale: run node scripts/pricing-optimization.mjs`);
  assert.match(read(DOC_FILE), /\*\*An analysis for the owner, not a change\.\*\*/);
});

test('the exhaustive C oracle keeps the solver raw share floor and the same five-cent linear budgets',()=>{
 const input=milpInput();
 for(const tier of TIERS){
  const choice=exhaustive(tier,'C',-1.5)!;
  const plan=input.plans[tier],option=plan.options.find(o=>o.monthCents===choice.monthCents)!;
  for(const name of input.printed)assert.equal(choice.shares[name],plan.figures[name]>0?input.alternatives.C:1);
  for(const cycle of ['Month','Year'] as const){
   const base=cycle==='Month'?plan.baseMonth:plan.baseYear;
   const coef=cycle==='Month'?plan.coefMonth:plan.coefYear;
   const used=base+input.printed.reduce((sum,name)=>sum+coef[name]*choice.shares[name],0);
   assert.ok(used<=option[`room${cycle}`],`${tier} ${cycle} includes the solver safety reserve`);
  }
 }
});
