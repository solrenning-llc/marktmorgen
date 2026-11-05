import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { COMMUNITY_PICTURES, PICTURE_BYTES } from "@/lib/community-picture-rules";
import { UPSTASH_MICRO_USD_PER_GB_MONTH } from "@/lib/spend-cost-table";

/** Company work limits, never a customer's plan allowance or retention deadline. */
export const HELD_RECHECKS_PER_DAY = 50;
export const HELD_RECHECK_READS = 2;
export const HELD_RETRY_COUNTER_SECONDS = 2 * 86400;
export const HELD_MONTH_COUNT_SECONDS = 400 * 86400;
/** Existing dearest file-storage model; unknown live supplier coverage still needs review. */
export const HELD_FILE_MICRO_USD_PER_GB_MONTH = 23_000;
export const HELD_MEMORY_MICRO_USD_PER_GB_HOUR = 18_300;
export const HELD_RECHECK_GB = 2;
export function heldRecheckMemoryUsd(): number {
  return HELD_RECHECK_READS * STRIPE_TIMEOUT_MS / 1000 * HELD_RECHECK_GB * HELD_MEMORY_MICRO_USD_PER_GB_HOUR / 1e6 / 3600;
}
/** A funding FLOOR, not a complete supplier quote: every full review must also
 * cover out-of-room keys, other post-cancellation work, taxes and unknown tariffs. */
export function heldStoreFundingFloorCents(): number {
  const tiers = ["creator", "pro", "scale"] as const;
  const kept = Math.max(...tiers.map(tier =>
    (PAID_STORAGE_BYTES[tier] + TASK_ROOM_BYTES[tier] + COMMUNITY_PICTURES[tier] * PICTURE_BYTES) / (1024 ** 3) * HELD_FILE_MICRO_USD_PER_GB_MONTH / 1e6 +
    DATA_ROOM_BYTES[tier] / 1e9 * UPSTASH_MICRO_USD_PER_GB_MONTH / 1e6));
  return Math.ceil((kept + 31 * heldRecheckMemoryUsd()) * 100);
}
