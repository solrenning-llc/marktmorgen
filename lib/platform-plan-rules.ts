import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";

/** Bounded recovery work, never a paid customer's visible allowance. */
export const PLATFORM_PLAN_PAGE_SIZE = 100;
export const PLATFORM_PLAN_MAX_PAGES = 10;
export const PLATFORM_PLAN_RECOVERY_GETS = 2 * PLATFORM_PLAN_MAX_PAGES;
/** Closing also reads the subscription already written on the store. */
export const PLATFORM_PLAN_CLOSING_GETS = PLATFORM_PLAN_RECOVERY_GETS + 1;
export const PLATFORM_PLAN_MEMORY_GB = 2;
/** Highest published regional memory rate, checked 2026-11-04; not a complete supplier quote. */
export const PLATFORM_PLAN_MEMORY_USD_PER_GB_HOUR = 0.0183;
export function platformPlanReadMemoryUsd(reads: number): number {
  return reads * (STRIPE_TIMEOUT_MS / 1000) * PLATFORM_PLAN_MEMORY_GB * PLATFORM_PLAN_MEMORY_USD_PER_GB_HOUR / 3600;
}
