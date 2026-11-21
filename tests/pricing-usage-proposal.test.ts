import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * The pricing and usage proposal of 18 October 2026
 * (docs/pricing-usage-proposal-2026-10-18.md): a PROPOSAL, no price, limit or
 * gate in code changes. The document must be what
 * tests/pricing-usage-proposal-table.ts renders today (regenerate it with
 * `node scripts/pricing-usage-proposal.mjs`), and every figure it proposes
 * must do what it says, under the repository's own margin code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onDemandReport, onDemandText } from "./generated-on-demand";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { LEGACY_PLAN_PRICES, PLAN_PRICES, TIERS } from "@/lib/plan";
import { ADD_ON_ROOM_CENTS } from "@/lib/store-assistant-rules";
import { MOST_TAX_READING } from "./historical-margin-model";
import { ORDER, figures } from "./limits-proposal-table";
import {
  COMPETITORS, KEPT_IN_FULL, MIN_INCLUDED_SHARE, PACKS, PRICES_BEFORE_553, RAISED_BY_553, figuresBefore553, grid, packUnit, planAt,
  recommended, renderPricingUsageProposal, wholeCustomer, yearOf,
} from "./pricing-usage-proposal-table";

const DOC = "docs/pricing-usage-proposal-2026-10-18.md";
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
// The report, computed on demand from today's code: DOC holds only its fixed text (owner, 20/11/2026).
let generated: string | undefined;
const doc = () => (generated ??= renderPricingUsageProposal());

test("the document is what the numbers render today (run node scripts/pricing-usage-proposal.mjs)", () => {
  assert.equal(read(DOC), onDemandText(onDemandReport(DOC)), `${DOC} holds only its fixed text: the report is generated on demand`);
  assert.ok(doc().startsWith(HISTORICAL_MARGIN_NOTICE));
  assert.match(doc().slice(HISTORICAL_MARGIN_NOTICE.length), /^# Entry prices with usage packs: a proposal, 18 October 2026/);
  assert.match(doc(), /\*\*A proposal for the owner, not a change\.\*\*/);
});

test("it is a proposal: the price list in force is still #553's, and nothing is on sale", () => {
  assert.deepEqual(PLAN_PRICES, { creator: { month: 6900, year: 69000 }, pro: { month: 44900, year: 449000 }, scale: { month: 99900, year: 999000 } });
  assert.equal(PLANS_ON_SALE, false);
});

test("the figures before #553 are today's except the three #553 raised, and its prices are the first legacy list", () => {
  assert.deepEqual(PRICES_BEFORE_553, LEGACY_PLAN_PRICES[0]);
  for (const tier of TIERS) {
    const raised = RAISED_BY_553[tier] ?? {};
    for (const id of ORDER) {
      if (id in raised) assert.ok(figures(tier)[id].every((n, i) => n > raised[id]![i]), `${tier} ${id}: #553 raised it`);
      else assert.deepEqual(figuresBefore553(tier)[id], figures(tier)[id]);
    }
  }
});

test("every recommended plan keeps 60% at full included use on both intervals, with the spend floor's room, and fails the most-tax gate", () => {
  for (const tier of TIERS) {
    const point = recommended(tier);
    assert.ok(point.share !== null && point.share >= MIN_INCLUDED_SHARE);
    // The lowest point on the list with that share.
    const first = grid(tier).find((p) => p.share !== null && p.share >= MIN_INCLUDED_SHARE)!;
    assert.equal(first.monthCents, point.monthCents);
    for (const [cycle, room] of [["month", 25], ["year", 100]] as const) {
      const u = planAt(tier, cycle, point.monthCents, point.included!);
      assert.ok(u.meetsFloor && u.netBps >= 6_000, `${tier} ${cycle} keeps ${u.netBps}`);
      assert.ok(u.usageRoomCents - u.usageCents >= room, `${tier} ${cycle} keeps its room`);
      assert.equal(u.revenueCents, cycle === "year" ? yearOf(point.monthCents) : point.monthCents);
      assert.equal(planAt(tier, cycle, point.monthCents, point.included!, MOST_TAX_READING).meetsFloor, false);
    }
    for (const id of ORDER) {
      point.included![id].forEach((n, i) => {
        assert.ok(n <= figures(tier)[id][i], `${tier} ${id}: included ${n} above #553's`);
        if (KEPT_IN_FULL.includes(id)) assert.equal(n, figures(tier)[id][i]);
      });
    }
  }
});

test("every pack keeps 60% on its own payment, used in full, with the add-on's room, and fails the most-tax gate", () => {
  for (const pack of PACKS) {
    const u = packUnit(pack);
    assert.ok(u.meetsFloor && u.netBps >= 6_000, `${pack.id} keeps ${u.netBps}`);
    assert.ok(u.usageRoomCents - u.usageCents >= ADD_ON_ROOM_CENTS);
    assert.ok(u.usageCents > 0, `${pack.id} costs something`);
    assert.equal(packUnit(pack, MOST_TAX_READING).meetsFloor, false);
  }
});

test("one customer, alone, at full use of the plan and of one of every pack, keeps 60%", () => {
  for (const tier of TIERS) for (const cycle of ["month", "year"] as const) assert.ok(wholeCustomer(tier, cycle).netBps >= 6_000, `${tier} ${cycle}`);
});

test("every competitor figure has its page and the day it was read", () => {
  for (const c of COMPETITORS) {
    assert.match(c.url, /^https:\/\//);
    assert.match(c.read, /^\d{1,2} [A-Z][a-z]+ 2026/);
    assert.ok(c.figures.length > 20);
    assert.ok(doc().includes(c.url));
  }
});
