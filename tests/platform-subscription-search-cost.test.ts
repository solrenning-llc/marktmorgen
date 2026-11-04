import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ADDRESSES } from "@/lib/store-field-rules";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { COST_LINES, PLATFORM_SUBSCRIPTION_SEARCH as profile, PLATFORM_SUBSCRIPTION_SEARCH_EVENT_USD as event } from "./plan-cost-registry";

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
    assert.equal(line.monthlyUsd(tier), event * (320 + 32));
  }
  assert.equal(line.sources.some(source => source.file === "lib/traffic.ts"), false);
});
