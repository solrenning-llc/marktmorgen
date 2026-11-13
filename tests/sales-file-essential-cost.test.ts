/**
 * #4256: the studio line of the plan cost registry prices each essential
 * request as one heavy request (request("heavy", 40, 200_000)), but an
 * essential request can be the sales file, which reads up to EXPORT_PAGES
 * pages of each Stripe list and up to EXPORT_PAGES × 100 PayPal sales of
 * MAX_PAID_BYTES each. The studio line's worst month must carry that reading
 * at its worst for every essential request of the month. The CSV's own
 * outgoing bytes are left out, so this is a floor, not the whole cost.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { EXPORT_PAGES } from "@/lib/stats";
import { MAX_PAID_BYTES } from "@/lib/paypal-sales";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { COST_LINES, DAY_WINDOWS, PAUSED_PER_DAY, figureCost, readShapeCost, request } from "./plan-cost-registry";

test("the studio line's essential share covers a sales file at its worst", () => {
  const studio = COST_LINES.find((line) => line.id === "studio");
  assert.ok(studio, "the studio line");
  const salesFile = readShapeCost({ seconds: 2, cpu: 0.5, commands: 42, dbBytes: EXPORT_PAGES * 100 * MAX_PAID_BYTES, outBytes: 0, stripePages: EXPORT_PAGES });
  for (const tier of ["creator", "pro", "scale"] as const) {
    const floor = figureCost(STORE_ALLOWANCES[tier], "studio") + ESSENTIAL_PER_DAY * DAY_WINDOWS * salesFile + PAUSED_PER_DAY * DAY_WINDOWS * request("light", 8);
    assert.ok(studio.monthlyUsd(tier) >= floor, `${tier}: ${studio.monthlyUsd(tier)} < ${floor}`);
  }
});
