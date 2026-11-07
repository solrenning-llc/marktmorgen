/**
 * The pricing optimization of 18 October 2026 (docs/pricing-optimization-2026-10-18.md):
 * an ANALYSIS, no price, limit, gate or tax assumption in code changes. The
 * program's input must be what the repository's margin code gives today, every
 * solution in its output must make a net profit with the spend floor's room
 * under that code (the MR rule, AGENTS.md, since 7 November 2026 here; until
 * then 60%) and equal the exhaustive search, and the document must be what
 * renders today. Regenerate
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

test("every solution makes net profit > 0 with the spend floor's room at full use on both intervals, respects the plan order, and equals the exhaustive search, while nothing is on sale", () => {
  // Until 7 November 2026 each solution had to keep 60% on both intervals and
  // fail the most-tax gate. The MR rule (owner, 27 October 2026; AGENTS.md,
  // "MR — Regra de margem vigente"): per unit, net profit > 0 with the spend
  // floor's existing room; "qualquer instrução de60% como piso obrigatório
  // remete a esta seção" (owner's decision C2-68: "pricing-optimization nºs 4
  // e 6 ... trocar pela regra MR (lucro > 0 com a folga em toda unidade)").
  // With that floor the most-tax reading makes a profit at the top of the
  // grid, so it no longer fails every solution by itself; the document prints
  // what it gives, and sales stay closed by the gates in code, which this
  // analysis does not touch.
  assert.equal(PLANS_ON_SALE, false);
  const out = milpOutput();
  assert.equal(out.solutions.length, ELASTICITIES.length * 2);
  for (const sol of out.solutions) {
    assert.match(sol.status, /optimal/i, `${sol.scenario} ${sol.alternative}`);
    const v = verified(sol);
    for (const x of v) {
      assert.ok(x.keeps && x.month.netCents > 0 && x.year.netCents > 0, `${sol.scenario} ${sol.alternative} ${x.tier}`);
      if (sol.alternative === "A") assert.deepEqual(x.shares, ones(), "A cuts nothing");
      const ex = exhaustive(x.tier, sol.alternative, Number(sol.scenario))!;
      assert.equal(x.monthCents, ex.monthCents, `${sol.scenario} ${sol.alternative} ${x.tier} matches the exhaustive search`);
    }
    assert.ok(v[0].monthCents < v[1].monthCents && v[1].monthCents < v[2].monthCents, "prices rise from plan to plan");
  }
});

test("the recommendation keeps every #553 figure and makes net profit > 0 with the spend floor's room on both intervals", () => {
  // Until 7 November 2026: "and 60% on both intervals". The MR rule replaces it (see above).
  for (const tier of TIERS) {
    const r = minimaxRegret(tier);
    assert.ok(keeps(tier, r.monthCents, ones()));
    for (const cycle of ["month", "year"] as const) assert.ok(unitAt(tier, cycle, r.monthCents, ones()).netCents > 0, `${tier} ${cycle}`);
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
  // Since the MR rule it says which floor it holds every plan to, and that nothing in it is in force.
  assert.match(read(DOC_FILE), /\*\*The floor, since the MR rule\.\*\*[^\n]*net profit greater than zero[^\n]*spend floor's existing room; 60% is the goal of the company's real monthly report[^\n]*\*\*Nothing here is in force\*\*/);
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
