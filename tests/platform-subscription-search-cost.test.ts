import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ADDRESSES } from "@/lib/store-field-rules";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { COMMAND, COST_LINES, PLATFORM_SUBSCRIPTION_SEARCH as profile, PLATFORM_SUBSCRIPTION_SEARCH_EVENT_USD as event } from "./plan-cost-registry";

test("CX-61 prices two full timeout waits using the highest published regional memory rate", () => {
  assert.equal(MAX_ADDRESSES, 10);
  assert.equal(profile.maxGets, 2);
  assert.equal(profile.waitSeconds, STRIPE_TIMEOUT_MS / 1000);
  assert.equal(profile.memoryUsdPerGbHour, 0.0183);
  assert.equal(event, 2 * (STRIPE_TIMEOUT_MS / 1000) * profile.memoryGb * profile.memoryUsdPerGbHour / 3600);
  assert.ok(event > 0);
  assert.equal(profile.stripeGetFeeUsd, null, "an unconfirmed endpoint tariff is not zero");
});

test("only shared essential checkout/deletion events and daily closing receive the two-read cost", () => {
  const line = COST_LINES.find(row => row.id === "platform-subscription-search")!;
  assert.ok(line);
  assert.equal(profile.essentialEventsPerWindow, 320);
  assert.equal(profile.closingEventsPerWindow, 32);
  for (const tier of ["creator", "pro", "scale"] as const) {
    // Regra 23 (pre-review M-b): was event * (320 + 32). Each closing event may also take room in the weekly brake on
    // plans missing, at most six Redis commands.
    assert.equal(profile.missingBrakeCommands, 6);
    assert.equal(line.monthlyUsd(tier), event * (320 + 32) + 32 * 6 * COMMAND);
  }
  assert.equal(line.sources.some(source => source.file === "lib/traffic.ts"), false);
});

test("CX-67 holds the full retained store and global retries as company exposure with unknown totals", async () => {
  const { HELD_EXPOSURE: held, heldStoreMonthlyExposure, heldCompanyMonthlyExposure, DB_BYTE_MONTH, STORAGE_PER_GB, GB } = await import("./plan-cost-registry");
  const { DATA_ROOM_BYTES } = await import("@/lib/store-data-rules");
  const { reservePeakBytes } = await import("./store-data-registry");
  const { heldRecheckMemoryUsd, heldStoreFundingFloorCents } = await import("@/lib/held-store-rules");
  assert.equal(held.dailyAttempts, 50); assert.equal(held.monthlyAttempts, 1550);
  assert.equal(heldRecheckMemoryUsd(), event);
  assert.equal(held.completeMonthlyCostUsd, null); assert.equal(held.reviewedGlobalCaseCeiling, null);
  assert.equal(held.stripeEndpointTariffUsd, null);
  for (const tier of ["creator", "pro", "scale"] as const) {
    const cost = heldStoreMonthlyExposure(tier);
    assert.ok(cost.fileBytes > 0);
    assert.equal(cost.databaseBytes, DATA_ROOM_BYTES[tier] + reservePeakBytes(tier) + 4096);
    assert.equal(cost.retentionUsd, cost.fileBytes / GB * STORAGE_PER_GB * 31 / 30 + cost.databaseBytes * DB_BYTE_MONTH * 31 / 30);
    assert.ok(cost.retryUsd > event); assert.ok(cost.modeledMonthlyUsd > 0);
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
