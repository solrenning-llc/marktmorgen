/**
 * Where a usage pack's price comes from (docs/pack-cost-decomposition-2026-10-18.md):
 * an ANALYSIS, no price, limit, gate or tax assumption in code changes. The
 * document must be what tests/pack-cost-decomposition-table.ts renders today
 * (regenerate it with `node scripts/pack-cost-decomposition.mjs`), its
 * decomposition must add back to each pack's price, and every option it
 * prices must keep 60% at full use under the sizing reading and fail the
 * most-tax gate, under the repository's own margin code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_PRICES } from "@/lib/plan";
import { ADD_ON_ROOM_CENTS } from "@/lib/store-assistant-rules";
import { MOST_TAX_READING, SIZING_READING, STRESS_PROFIT_TAX_BPS, STRIPE_TOTAL_BPS, unitUnder } from "./historical-margin-model";
import { PER_EMAIL, STORAGE_PER_GB } from "./plan-cost-registry";
import { PACKS, packPriceCents } from "./pricing-usage-proposal-table";
import {
  CREDIT_AMOUNTS, SIZES, SUPPLIER_RATES, centsUp, creditOption, decompose, ladder, lineOption, renderPackCostDecomposition, sizeOption, supplierVariant,
} from "./pack-cost-decomposition-table";

const DOC = "docs/pack-cost-decomposition-2026-10-18.md";
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("the document is what the numbers render today (run node scripts/pack-cost-decomposition.mjs)", () => {
  assert.equal(read(DOC), renderPackCostDecomposition(), `${DOC} is stale: run node scripts/pack-cost-decomposition.mjs`);
  assert.match(read(DOC), /\*\*An analysis for the owner, not a change\.\*\*/);
});

test("it changes nothing in force: the price list, the receiving model, the tax floor and the unit costs are as the analysis read them", () => {
  assert.deepEqual(PLAN_PRICES, { creator: { month: 6900, year: 69000 }, pro: { month: 44900, year: 449000 }, scale: { month: 99900, year: 999000 } });
  assert.equal(PLANS_ON_SALE, false);
  assert.equal(STRIPE_TOTAL_BPS, 660);
  assert.equal(STRESS_PROFIT_TAX_BPS, 2_750);
  assert.equal(SIZING_READING.salesTaxOnTopBps, 2_700);
  assert.equal(PER_EMAIL, 0.0009);
  assert.equal(STORAGE_PER_GB, 0.041);
});

test("each pack's lines add back to its price, and the four factors multiply back to price over cost", () => {
  for (const pack of PACKS) {
    const d = decompose(pack);
    assert.equal(d.priceCents, packPriceCents(pack));
    const u = d.unit;
    const sum = u.usageCents + d.feePctCents + d.feeFixedCents + u.remittanceCents + u.refundReserveCents + d.disputePctCents + d.disputeFixedCents + d.freeShareCents + u.taxCents + u.netCents;
    assert.equal(sum, u.revenueCents, `${pack.id} adds up`);
    assert.equal(u.revenueCents, d.priceCents, "no tax inside the price under the sizing reading");
    assert.equal(d.feeFixedCents + d.disputeFixedCents, 60, `${pack.id}: 30¢ of fee and 30¢ of dispute reserve`);
    assert.ok(d.unusedCents >= ADD_ON_ROOM_CENTS && d.unusedCents === u.usageRoomCents - u.usageCents);
    const l = ladder(d);
    assert.ok(Math.abs(l.floorAndTax * l.percentages * l.fixed * l.rounding - l.total) < 1e-9, `${pack.id} ladder`);
    assert.ok(l.floorAndTax > 5.7 && l.floorAndTax < 5.9, "the floor and the tax alone: about 5.8");
    assert.ok(l.floorAndTax * l.percentages > 19 && l.floorAndTax * l.percentages < 21, "about twenty before any fixed cent");
  }
});

const keeps = (u: ReturnType<typeof unitUnder>) => u.meetsFloor && u.netBps >= 6_000 && u.usageRoomCents - u.usageCents >= ADD_ON_ROOM_CENTS;

test("every option keeps 60% at full use with the add-on's room, and fails the most-tax gate", () => {
  for (const pack of PACKS) {
    const l = lineOption(pack);
    assert.ok(keeps(l.unit), `${pack.id} line`);
    assert.ok(l.priceCents < packPriceCents(pack), `${pack.id}: a line is cheaper than its own payment`);
    assert.equal(l.unpaidLossCents, centsUp(pack.costUsd));
    assert.equal(unitUnder(l.priceCents, l.unit.usageCents, MOST_TAX_READING, false).meetsFloor, false);
    let previous = Infinity;
    for (const t of SIZES) {
      const s = sizeOption(pack, t);
      assert.ok(keeps(s.unit), `${pack.id} ×${t}`);
      assert.equal(unitUnder(s.priceCents, s.unit.usageCents, MOST_TAX_READING, true).meetsFloor, false);
      const perUnit = s.priceCents / s.pack.units;
      assert.ok(perUnit < previous, `${pack.id}: a larger pack is cheaper a unit`);
      previous = perUnit;
    }
  }
  for (const via of ["resend", "ses-only"] as const) {
    for (const amount of CREDIT_AMOUNTS) {
      const c = creditOption(amount, via);
      assert.ok(keeps(c.worst), `$${amount / 100} credit (${via}) spent on its dearest-to-serve resource`);
      assert.equal(unitUnder(amount, c.worst.usageCents, MOST_TAX_READING, true).meetsFloor, false);
      for (const r of c.rates) assert.ok(r.costCents <= c.worst.usageCents);
    }
  }
  for (const id of ["list-email", "storage"] as const) for (const t of SIZES) {
    const v = supplierVariant(id, t);
    assert.ok(keeps(v.unit), `${id} ×${t} at the cheaper supplier`);
  }
});

test("larger credits are cheaper a unit, and never under the floor of factors 1 and 2", () => {
  const email = PACKS.find((p) => p.id === "list-email")!;
  const floor = ladder(decompose(email));
  let previous = Infinity;
  for (const amount of CREDIT_AMOUNTS) {
    const c = creditOption(amount);
    assert.ok(c.multiplier < previous);
    assert.ok(c.multiplier > floor.floorAndTax * floor.percentages * 0.99);
    previous = c.multiplier;
  }
});

test("every supplier rate has its page and the day it was read, or says it was not re-read", () => {
  for (const s of SUPPLIER_RATES) {
    assert.match(s.url, /^https:\/\//);
    assert.ok(/^18 October 2026/.test(s.read) || /^not re-read/.test(s.read), s.line);
    assert.ok(read(DOC).includes(s.url));
  }
});
