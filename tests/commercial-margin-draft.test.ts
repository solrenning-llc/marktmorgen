/** The two-bundle JSON handoff must not turn unknown costs into a positive profit. Synthetic only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COST_LINES } from "./plan-cost-registry";
import { commercialMarginUsage, renderCommercialMarginDraft, SES_PER_EMAIL_USD } from "./commercial-margin-draft";
import { CURRENT_COMMERCIAL_MARGIN_REVIEW, commercialPlansMayOpen } from "@/lib/commercial-margin";

const wireUsage = () => JSON.parse(JSON.stringify({ ...commercialMarginUsage(), perEmailUsd: SES_PER_EMAIL_USD }));

test("known usage still renders, with unknown fixed costs failing and no approval", () => {
  const reviewBefore = JSON.stringify(CURRENT_COMMERCIAL_MARGIN_REVIEW);
  const gateBefore = commercialPlansMayOpen(true);
  const document = renderCommercialMarginDraft({ lcUsage: wireUsage() });
  assert.match(document, /\| Store monthly \|/);
  assert.match(document, /Nothing here is approved or opened/);
  assert.equal(JSON.stringify(CURRENT_COMMERCIAL_MARGIN_REVIEW), reviewBefore);
  assert.equal(commercialPlansMayOpen(true), gateBefore);
});

test("a nonfinite cost cannot cross the first bundle's JSON handoff as null and produce a positive unit", () => {
  const line = COST_LINES.find((entry) => entry.id === "calendar-feed")!;
  assert.ok(line);
  const original = line.monthlyUsd;
  line.monthlyUsd = () => Number.POSITIVE_INFINITY;
  try {
    assert.throws(() => {
      const lcUsage = wireUsage();
      const document = renderCommercialMarginDraft({ lcUsage });
      const row = document.split("\n").find((text) => text.startsWith("| Store monthly |"));
      console.log("synthetic unknown-cost row:", row);
    }, /Unknown commercial margin usage/);
  } finally {
    line.monthlyUsd = original;
  }
});

for (const field of ["plan-usage", "per-payment", "cost-line"] as const) {
  test(`the second bundle refuses a null ${field} instead of treating it as zero`, () => {
    const lcUsage = wireUsage();
    if (field === "plan-usage") lcUsage.planUsageCents["creator-month-list"] = null;
    if (field === "per-payment") lcUsage.perPaymentUsd.creator = null;
    if (field === "cost-line") lcUsage.lines[0].usd.creator = null;
    assert.throws(() => renderCommercialMarginDraft({ lcUsage }), /Unknown commercial margin usage/);
  });
}

test("the draft never says an overage scenario is still required, generated or stored (Claude 2's LEVE on #5017)", () => {
  // REQUIRED_MARGIN_SCENARIOS holds only the 6 plan scenarios since the owner's decision 3 (b) of 20 November 2026.
  const stale = /including the overage ones|_overage(, \w+_overage)* are still required|\s+are still required/;
  assert.doesNotMatch(renderCommercialMarginDraft({ lcUsage: wireUsage() }), stale);
  assert.doesNotMatch(readFileSync("docs/opening-readiness/commercial-margin-figures.md", "utf8"), stale);
});
