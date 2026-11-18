/**
 * A held store (post-cancellation retention, CX-67) keeps its beside pool's records as well as its room:
 * the pool (C1-20261117) is outside the room, so the held exposure and its funding floor must count it.
 * Written by Claude 4 (cloud Z) on #4846 @02986136ca (6964792108); synthetic figures only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BESIDE_POOL_BYTES, DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { HELD_FILE_MICRO_USD_PER_GB_MONTH, heldRecheckMemoryUsd, heldStoreFundingFloorCents } from "@/lib/held-store-rules";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { COMMUNITY_PICTURES, PICTURE_BYTES } from "@/lib/community-picture-rules";
import { heldStoreMonthlyExposure } from "./plan-cost-registry";
import { reservePeakBytes } from "./store-data-registry";
import { UPSTASH_MICRO_USD_PER_GB_MONTH } from "@/lib/spend-cost-table";

test("the held store's database bytes include the beside pool", () => {
  for (const tier of ["creator", "pro", "scale"] as const) {
    assert.ok(heldStoreMonthlyExposure(tier).databaseBytes >= DATA_ROOM_BYTES[tier] + BESIDE_POOL_BYTES + reservePeakBytes(tier), tier);
  }
});

test("the held store's funding floor covers the beside pool", () => {
  // The floor's own formula (lib/held-store-rules.ts) with the pool added to the room it keeps.
  const tiers = ["creator", "pro", "scale"] as const;
  const kept = Math.max(...tiers.map((tier) =>
    (PAID_STORAGE_BYTES[tier] + TASK_ROOM_BYTES[tier] + COMMUNITY_PICTURES[tier] * PICTURE_BYTES) / (1024 ** 3) * HELD_FILE_MICRO_USD_PER_GB_MONTH / 1e6 +
    (DATA_ROOM_BYTES[tier] + BESIDE_POOL_BYTES) / 1e9 * UPSTASH_MICRO_USD_PER_GB_MONTH / 1e6));
  const needed = Math.ceil((kept + 31 * heldRecheckMemoryUsd()) * 100);
  assert.ok(heldStoreFundingFloorCents() >= needed, `floor ${heldStoreFundingFloorCents()} cents, needed ${needed}`);
});
