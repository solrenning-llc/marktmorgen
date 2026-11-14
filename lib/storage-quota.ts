/** Exact storage measurement and admission. Paid tiers use explicit finite
 * limits; unavailable or incomplete measurements never authorize new storage.
 * An upload threshold does not delete existing customer content or prove
 * a supplier-dollar ceiling, retention funding or the all-tax margin.
 */
import { filesHeld } from "@/lib/file-store";
import { streamHeld } from "@/lib/stream";
import { STORAGE_BRAKE_BYTES } from "@/lib/storage-rules";
export { STORAGE_BRAKE_BYTES, storageBrakeFor } from "@/lib/storage-rules";

const GB = 1024 * 1024 * 1024;

export type StorageUse = { bytes: number; brake: number; left: number; full: boolean; available: boolean };

/**
 * What a store is holding, read from storage itself.
 *
 * Not kept as a counter. A counter has to be incremented everywhere a file
 * is attached and decremented everywhere one is dropped, and the day someone
 * adds a seventh such place without knowing, the counter is wrong in the
 * direction that costs money and nothing ever says so. The provider listings are read completely. Pagination, malformed
 * responses and provider failures are handled by the strict measurement
 * adapters; their request costs still need a funded bound.
 *
 * A missing, invalid or incomplete measurement cannot authorize more storage.
 * Existing downloads and content are unaffected; upload doors return a temporary failure.
 */
export async function storageUsed(folder: string, brake: number = STORAGE_BRAKE_BYTES, pictures?: string): Promise<StorageUse> {
  const unavailable: StorageUse = { bytes: 0, brake, left: 0, full: false, available: false };
  if (!folder || !Number.isSafeInteger(brake) || brake <= 0 || pictures === "") return unavailable;
  try {
    const files = await filesHeld(folder, pictures);
    const videos = await streamHeld(folder);
    if (videos === null || !Number.isSafeInteger(files) || files < 0 ||
        !Number.isSafeInteger(videos) || videos < 0) return unavailable;
    const bytes = files + videos;
    if (!Number.isSafeInteger(bytes)) return unavailable;
    return { bytes, brake, left: Math.max(0, brake - bytes), full: bytes >= brake, available: true };
  } catch (error) {
    console.error("could not read what a store is storing", error);
    return unavailable;
  }
}

/**
 * Maximum bytes one upload may authorize against a confirmed measurement.
 * The signature and its URL options must use this same ceiling.
 * This does not reserve capacity against simultaneous or in-flight uploads.
 */
export function maximumUploadBytes(held: StorageUse, perFileMaximum: number): number {
  if (held.available !== true || held.full ||
      !Number.isSafeInteger(perFileMaximum) || perFileMaximum <= 0 ||
      !Number.isSafeInteger(held.bytes) || held.bytes < 0 ||
      !Number.isSafeInteger(held.brake) || held.brake <= 0 ||
      !Number.isSafeInteger(held.left) || held.left < 0 ||
      held.left !== Math.max(0, held.brake - held.bytes)) return 0;
  return Math.min(perFileMaximum, held.left);
}

/** A new file must fit entirely, including on a paid plan. Existing files are untouched. */
export function fits(held: StorageUse, bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0 && maximumUploadBytes(held, bytes) === bytes;
}

/** "480 GB", "1.4 TB", "5 GB", "900 MB". */
export function storageWords(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  // "5 GB", not "5.0 GB": a round figure is written as one.
  if (gb >= 1) return `${Number(gb.toFixed(1))} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}
