import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ADDRESSES } from "@/lib/store-field-rules";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { COST_LINES, PLATFORM_SUBSCRIPTION_SEARCH as profile, PLATFORM_SUBSCRIPTION_SEARCH_EVENT_USD as event, PLATFORM_SUBSCRIPTION_CLOSING_EVENT_USD as closingEvent } from "./plan-cost-registry";
import { PLATFORM_PLAN_MAX_PAGES, PLATFORM_PLAN_CLOSING_GETS, PLATFORM_PLAN_RECOVERY_GETS } from "@/lib/platform-plan-rules";

test("CX-86 prices the finite page ceiling with full timeout waits at the highest regional memory rate", () => {
  assert.equal(MAX_ADDRESSES, 10);
  assert.equal(profile.maxPages, PLATFORM_PLAN_MAX_PAGES);
  assert.equal(profile.maxGets, PLATFORM_PLAN_RECOVERY_GETS);
  assert.equal(profile.closingGets, PLATFORM_PLAN_CLOSING_GETS);
  assert.equal(profile.maxGets, 2 * PLATFORM_PLAN_MAX_PAGES);
  assert.equal(profile.closingGets, profile.maxGets + 1);
  assert.equal(profile.waitSeconds, STRIPE_TIMEOUT_MS / 1000);
  assert.equal(profile.memoryUsdPerGbHour, 0.0183);
  assert.equal(event, profile.maxGets * (STRIPE_TIMEOUT_MS / 1000) * profile.memoryGb * profile.memoryUsdPerGbHour / 3600);
  assert.equal(closingEvent, profile.closingGets * (STRIPE_TIMEOUT_MS / 1000) * profile.memoryGb * profile.memoryUsdPerGbHour / 3600);
  assert.ok(event > 0);
  assert.equal(profile.stripeGetFeeUsd, null, "an unconfirmed endpoint tariff is not zero");
});

test("only shared checkout/deletion and daily closing receive recovery cost, with closing's extra GET", () => {
  const line = COST_LINES.find(row => row.id === "platform-subscription-search")!;
  assert.ok(line);
  assert.equal(profile.essentialEventsPerWindow, 320);
  assert.equal(profile.closingEventsPerWindow, 32);
  for (const tier of ["creator", "pro", "scale"] as const) {
    assert.equal(line.monthlyUsd(tier), event * 320 + closingEvent * 32);
  }
  assert.equal(line.sources.some(source => source.file === "lib/traffic.ts"), false);
});

test("CX-67 holds the full retained store and global retries as company exposure with unknown totals", async () => {
  const { HELD_EXPOSURE: held, heldStoreMonthlyExposure, heldCompanyMonthlyExposure, DB_BYTE_MONTH, STORAGE_PER_GB, GB } = await import("./plan-cost-registry");
  const { DATA_ROOM_BYTES } = await import("@/lib/store-data-rules");
  const { reservePeakBytes } = await import("./store-data-registry");
  const { heldRecheckMemoryUsd, heldStoreFundingFloorCents } = await import("@/lib/held-store-rules");
  assert.equal(held.dailyAttempts, 50); assert.equal(held.monthlyAttempts, 1550);
  assert.equal(heldRecheckMemoryUsd(), closingEvent);
  assert.equal(held.completeMonthlyCostUsd, null); assert.equal(held.reviewedGlobalCaseCeiling, null);
  assert.equal(held.stripeEndpointTariffUsd, null);
  for (const tier of ["creator", "pro", "scale"] as const) {
    const cost = heldStoreMonthlyExposure(tier);
    assert.ok(cost.fileBytes > 0);
    assert.equal(cost.databaseBytes, DATA_ROOM_BYTES[tier] + reservePeakBytes(tier) + 4096);
    assert.equal(cost.retentionUsd, cost.fileBytes / GB * STORAGE_PER_GB * 31 / 30 + cost.databaseBytes * DB_BYTE_MONTH * 31 / 30);
    assert.ok(cost.retryUsd > closingEvent); assert.ok(cost.modeledMonthlyUsd > 0);
    assert.equal(cost.completeMonthlyUsd, null);
  }
  assert.ok(heldStoreFundingFloorCents() > 0);
  assert.equal(heldCompanyMonthlyExposure(null, 0).modeledUsd, null);
  assert.equal(heldCompanyMonthlyExposure(1, 2).modeledUsd, null);
  assert.equal(heldCompanyMonthlyExposure(1, null).modeledUsd, null);
  assert.ok(heldCompanyMonthlyExposure(1, 1).modeledUsd! > heldStoreMonthlyExposure("scale").retentionUsd);
  assert.equal(heldCompanyMonthlyExposure(1, 1).completeUsd, null);
  assert.equal(COST_LINES.some(row => row.id === "held-stores"), false);
});
