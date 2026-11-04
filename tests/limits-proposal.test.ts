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
import { ASSISTANT_ON_SALE, PLANS_ON_SALE } from "@/lib/opening";
import { allUnits, evaluate, roomKept } from "./margin-alignment-table";
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

test("every proposed figure is a cut, never a raise, and at today's figures every plan makes net profit > 0 with the spend floor's room, monthly and yearly", () => {
  // Until 4 November 2026 this asked every plan to keep 60% at today's
  // figures, the floor of 18 October 2026. Under the MR rule (owner, 27
  // October 2026) 60% is the monthly company report's goal, not a per-unit
  // gate: each plan, alone at full use, makes a profit with the spend floor's
  // room (owner's decision C2-68, 4 November 2026; 465 [MR2]). The cuts this
  // document lists are what 60% would take, shown, never applied.
  const units = allUnits(PLANS_ON_SALE, ASSISTANT_ON_SALE);
  for (const p of proposals()) {
    const today = figures(p.tier);
    for (const id of ORDER) p.proposed[id].forEach((n, i) => assert.ok(n <= today[id][i], `${p.tier} ${p.cycle} ${id}: ${n} above today's ${today[id][i]}`));
    const unit = units.find((u) => u.id.startsWith(`${p.tier}-${p.cycle}-`));
    assert.ok(unit, `${p.tier} ${p.cycle} is a unit`);
    const withRoom = evaluate({ ...unit, usageCents: unit.usageCents + roomKept(unit) });
    assert.ok(withRoom.netCents > 0, `${p.tier} ${p.cycle}: ${withRoom.netCents} cents net with ${roomKept(unit)} cents of room`);
  }
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
