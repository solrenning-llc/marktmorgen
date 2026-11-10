/** Client-safe provisional storage ceilings, in exact bytes.
 * Lower exposure is not proof of the funded all-tax net-margin floor.
 * At public R2 Standard rates, rounded storage-only monthly costs are
 * $0.135 / $1.035 / $2.070 before requests, other providers and all other costs.
 * Source: https://developers.cloudflare.com/r2/pricing/ (checked 2026-10-16).
 */
import type { Tier } from '@/lib/plan';
import { SETUP_STORAGE_BYTES, TRIAL_STORAGE_BYTES, type Standing } from '@/lib/plan-standing';
const GiB=1024*1024*1024;
/** 8, 64 and 128 GB until 18 October 2026, lowered (never the prices) so every plan keeps the owner's 60%
 * with what a store keeps after its plan ends, until its closing day, priced (tests/plan-cost-registry.ts). */
export const PAID_STORAGE_BYTES = Object.freeze({ creator:5*GiB, pro:40*GiB, scale:80*GiB }) satisfies Record<Tier,number>;
/**
 * How many pages of a store's listing in the host's own file store a
 * measurement of what it keeps reads at most (lib/file-store.ts, filesHeld),
 * a thousand names to a page. Each page is one Vercel Blob list, an Advanced
 * Operation; the cost table prices an upload start from this
 * (lib/spend-cost-table.ts, UPLOAD_OPEN_BLOB_ADVANCED_OPS).
 */
export const BLOB_LIST_PAGES = 20;
/** Conservative default when a caller has not supplied a paid tier. */
export const STORAGE_BRAKE_BYTES=PAID_STORAGE_BYTES.creator;
export function paidStorageBytes(tier: Tier='creator'):number {
 return Object.hasOwn(PAID_STORAGE_BYTES,tier)?PAID_STORAGE_BYTES[tier]:PAID_STORAGE_BYTES.creator;
}

/** A trial never authorizes more stored bytes than the chosen paid tier. */
export function storageBrakeFor(standing: Standing, tier: Tier='creator'):number {
 const paid=paidStorageBytes(tier);
 return standing==='paid'?paid:standing==='trial'?Math.min(TRIAL_STORAGE_BYTES,paid):SETUP_STORAGE_BYTES;
}
