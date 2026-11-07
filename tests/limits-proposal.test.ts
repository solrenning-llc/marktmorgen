import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * The limits proposal of 18 October 2026 (docs/limits-proposal-2026-10-18.md):
 * a PROPOSAL, no limit in code changes. The document must be what
 * tests/limits-proposal-table.ts renders today (regenerate it with
 * `node scripts/limits-proposal.mjs`), and every figure it proposes must
 * do what it says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { receivingOf } from "@/lib/receiving-costs";
import { reviewedUnitUnder } from "@/lib/reviewed-receiving";
import { txCustomerFixture } from "./customer-tax-review-fixture";
import { ASSISTANT_INPUT_BYTES } from "@/lib/store-assistant-rules";
import { CENTS_PER_MINUTE, MIN_CENTS } from "@/lib/auto-captions-rules";
import { ORDER, assistantAt, assistantInputCap, captionsMinimumFor, captionsOptions, captionsPrice, captionsTodayAnyMinimum, captionsWorstBps, figures, perMinuteHolds, proposals, renderLimitsProposal } from "./limits-proposal-table";

const DOC = "docs/limits-proposal-2026-10-18.md";
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("the document is what the numbers render today (run node scripts/limits-proposal.mjs)", () => {
  assert.equal(read(DOC), renderLimitsProposal(PLANS_ON_SALE, PLANS_ON_SALE), `${DOC} is stale: run node scripts/limits-proposal.mjs`);
  assert.ok(read(DOC).startsWith(HISTORICAL_MARGIN_NOTICE));
  assert.match(read(DOC).slice(HISTORICAL_MARGIN_NOTICE.length), /^# Limits proposal, 18 October 2026 — a PROPOSAL, nothing here is in force/);
});

test("archived proposals never raise a figure and viable proposals meet their historical 60% target", () => {
  for (const p of proposals()) {
    const today = figures(p.tier);
    for (const id of ORDER) p.proposed[id].forEach((n, i) => assert.ok(n <= today[id][i], `${p.tier} ${p.cycle} ${id}: ${n} above today's ${today[id][i]}`));
    // This archived solver retains its historical target. Updated measured
    // costs may produce a historical proposal; it never changes live rights.
    assert.equal(p.feasible, p.netBps >= 6_000, `${p.tier} ${p.cycle}: feasibility must agree with the archived result`);
    if (p.feasible) assert.ok(p.netBps >= 6_000, `${p.tier} ${p.cycle}: a viable archived proposal must reach 60%`);
    if (p.todayNetBps >= 6_000) {
      assert.equal(p.feasible, true);
      assert.deepEqual(p.cut, [], `${p.tier} ${p.cycle}: no cut is needed when today already meets the archived target`);
    }
  }
});

test("the current MR unit floor is positive profit, while a loss fails and sales stay closed", () => {
  // Synthetic unit arithmetic, not a real cost review or a launch approval.
  const evaluate = (usageCents: number) => {
    const row = txCustomerFixture(10_000, receivingOf(10_000).totalCents + usageCents);
    return reviewedUnitUnder(10_000, usageCents, { taxReview: row.taxReview!, taxContext: row.taxContext! });
  };
  const positive = evaluate(6_000);
  assert.ok(positive, "complete synthetic TX evidence is still required for current MR arithmetic");
  assert.ok(positive.netCents > 0 && positive.netBps < 6_000);
  assert.equal(positive.meetsFloor, true);
  const loss = evaluate(10_000);
  assert.ok(loss);
  assert.ok(loss.netCents < 0);
  assert.equal(loss.meetsFloor, false);
  assert.equal(reviewedUnitUnder(10_000, 6_000, null), null, "missing tax evidence never becomes a sizing assumption");
  assert.equal(PLANS_ON_SALE, false);
});

test("the Store assistant's input cap: today's keeps 60% with its room at $69, and the largest cap is where one byte more misses", () => {
  const cap = assistantInputCap(false), room = assistantInputCap(true);
  assert.ok(room <= cap && ASSISTANT_INPUT_BYTES <= room);
  assert.equal(assistantAt(cap).meets, true);
  assert.equal(assistantAt(cap + 1).meets, false);
  assert.equal(assistantAt(room).withRoom, true);
  assert.equal(assistantAt(room + 1).withRoom, false);
  assert.equal(assistantAt(ASSISTANT_INPUT_BYTES).withRoom, true, "today's cap keeps 60% with its room at the price set on 18 October 2026");
});

test("AI captions: today's price keeps 60% at every length, the lowest that would is listed, and captions are not on sale", () => {
  assert.equal(captionsTodayAnyMinimum(), true);
  assert.ok(captionsWorstBps(CENTS_PER_MINUTE, MIN_CENTS) >= 6_000);
  const lowest = captionsPrice();
  assert.ok(captionsWorstBps(lowest.perMinute, lowest.minimum) >= 6_000);
  assert.ok(lowest.perMinute <= CENTS_PER_MINUTE);
  assert.deepEqual([perMinuteHolds(lowest.perMinute), perMinuteHolds(lowest.perMinute - 1)], [true, false]);
  for (const o of captionsOptions()) {
    assert.ok(captionsWorstBps(o.perMinute, o.minimum) >= 6_000);
    assert.ok(o.minimum === 25 || captionsWorstBps(o.perMinute, o.minimum - 25) < 6_000);
    assert.equal(captionsMinimumFor(o.perMinute), o.minimum);
  }
  assert.ok(MIN_CENTS >= captionsMinimumFor(CENTS_PER_MINUTE), "today's minimum is at or above the lowest that keeps every length");
  // Not on sale: charged only to a store with an active subscription, and none can be started while the plans are closed.
  assert.equal(PLANS_ON_SALE, false);
  assert.match(read("lib/auto-captions.ts"), /if \(!store\.subscriptionActive \|\| !store\.subscriptionId \|\| !store\.stripeCustomerId\) return \{ ok: false, reason: "plan" \};/);
  assert.match(read("app/api/billing/checkout/route.ts"), /if \(!PLANS_ON_SALE\) return away/);
});
