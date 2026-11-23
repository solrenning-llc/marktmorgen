/**
 * What a buyer's stamped copy and a PDF's preview spend beyond the request that asked for them, counted as the
 * store's public requests before each spend (lib/traffic.ts holdPublicRequests), so every one stays inside the
 * window its plan already prices (line public-requests, tests/plan-cost-registry.ts; owner rule MR: a ceiling before
 * every spend). tests/plan-cost-registry.test.ts holds each figure here above what it pays for.
 *
 * 1. Measuring the store's storage before a new copy is kept in it (lib/pdf-stamp.ts writeWithinStorage): one full
 *    listing of both file stores, at most MEASURE_LIST_PAGES pages each (lib/file-store.ts filesHeld, lib/vault.ts
 *    vaultHeld), the video service's size of the store, the storage reservation taken and let go
 *    (lib/storage-reservations.ts), and the copy's own path asked about once (lib/file-store.ts headFile), so a copy
 *    already in place is written over without being reserved again as new storage. STORAGE_MEASURE_UNITS are taken before it lists; refused, nothing is listed and
 *    nothing is kept. A buyer's copy is also noted under the buyer before it is written, and the note read again after
 *    (lib/pdf-stamp.ts noteCopy, stillNoted; board #5427, row #3312), its copy deleted again when the buyer's deletion
 *    passed in between: inside the same units (tests/plan-cost-registry.ts COPY_NOTE_COMMANDS).
 * 2. A store found without room is noted for NO_ROOM_NOTE_SECONDS, for every file of the store: during that time
 *    no copy and no preview measures the store again.
 * 3. A copy stamped on the fly (lib/pdf-stamp.ts stampedDelivery), made for a buyer of a store without room and
 *    sent without being kept: the function held for the whole download (FLY_HOLD_SECONDS, the route's
 *    maxDuration), the CPU of the stamping, the original read from the file store and the stamped bytes sent on.
 *    flyUnits(...) at its worst is held before the original is read, and what the measured work did not need is
 *    given back once it is done.
 */
import { MAX_STAMP_BYTES } from "@/lib/product-file";

/** Pages each file store's listing reads at the most when a store's storage is measured. */
export const MEASURE_LIST_PAGES = 20;
/** Public requests one measurement of a store's storage is counted as, taken before it lists. */
export const STORAGE_MEASURE_UNITS = 16;
/** How long a store found without room for a new copy is taken to be still without it, in seconds. */
export const NO_ROOM_NOTE_SECONDS = 60 * 60;

/** How long a download that stamps on the fly may hold its function, in seconds (app/api/store/download, maxDuration). */
export const FLY_HOLD_SECONDS = 60;
/** Public requests the held function, its commands and the note it reads are counted as on every copy made on the fly. */
export const FLY_BASE_UNITS = 7;
/**
 * Redis commands a copy made on the fly sends on its connection's share of copies (lib/traffic.ts), each counted at its
 * most as if all ran: the share read before the hold; the hold's script (FLY_SHARE_HOLD), one command and its three
 * calls; the settling of a reply lost or in another shape (FLY_SHARE_SETTLE), one and its three at the most; and the
 * give-back of what was not used, the share read again with its HINCRBY and EXPIRE. Upstash bills a script as one
 * command plus every redis.call it runs. Counted in the held function's part (FLY_BASE, tests/plan-cost-registry.ts).
 */
export const FLY_SHARE_COMMANDS = 1 + (1 + 3) + (1 + 3) + 3;
/** Milliseconds of CPU one public request pays for on a copy made on the fly. */
export const FLY_CPU_MS_PER_UNIT = 1_500;
/**
 * CPU counted for each millisecond a copy made on the fly is worked on: a review ceiling of two busy processors for
 * the wall time measured, since the CPU itself cannot be read before the bill.
 */
export const FLY_CPU_PER_WALL_MS = 2;
/** Bytes, read from the file store or sent on to the buyer, one public request pays for on a copy made on the fly. */
export const FLY_BYTES_PER_UNIT = 600_000;
/** The most a copy made on the fly may send: a stamped copy past it is not sent, and the buyer is asked to try again. */
export const FLY_MAX_BYTES = 2 * MAX_STAMP_BYTES;

/**
 * Public requests a copy made on the fly is counted as: its held function, `wallMs` of work at FLY_CPU_PER_WALL_MS,
 * and `bytes` read and sent. NaN for figures that are not whole and not negative, which no hold accepts.
 */
export function flyUnits(wallMs: number, bytes: number): number {
  if (!Number.isSafeInteger(wallMs) || wallMs < 0 || !Number.isSafeInteger(bytes) || bytes < 0) return Number.NaN;
  return FLY_BASE_UNITS + Math.ceil((wallMs * FLY_CPU_PER_WALL_MS) / FLY_CPU_MS_PER_UNIT) + Math.ceil(bytes / FLY_BYTES_PER_UNIT);
}

/** What a copy made on the fly is held at before its original is read: the whole hold's work and `readBytes` read and sent twice over. */
export function flyHoldUnits(readBytes: number): number {
  return flyUnits(FLY_HOLD_SECONDS * 1000, readBytes * 3);
}

/** A store's public requests, taken before a spend and given back when not all of it was needed (lib/traffic.ts). */
export type CopyMeter = {
  /** Takes `units`; false when the store has not that many left (nothing is then spent). */
  take(units: number): Promise<boolean>;
  /** Gives back `units` taken and not needed. Best effort. */
  give(units: number): Promise<void>;
};

/**
 * The stamped copies kept for one person in one store are noted under them (lib/pdf-stamp.ts stampedCopiesKey;
 * board #5427, row #3312), so deleting the person finds and deletes each one: a copy carries their address on its
 * pages. COPIES_PER_PERSON bounds the note: past it a copy is stamped on the fly for that download and not kept, as for
 * a store without room. A copy whose path is longer than COPY_PATH_MOST bytes is not noted, and so not kept, either.
 */
export const COPIES_PER_PERSON = 50;
export const COPY_PATH_MOST = 300;
/**
 * What one noted copy takes of the store's data room for as long as it is noted (a slot of its own, never expiring):
 * its member in the buyer's note, the copy's record key (54 bytes), a space and a path of at most COPY_PATH_MOST
 * bytes, and the same member again on its file's list (lib/pdf-stamp.ts stampedFileKey) after the buyer's one-way key
 * (32 bytes) and a space, each with its set's own overhead, rounded up.
 */
export const COPY_NOTE_BYTES = 1_024;
/**
 * Removing a file takes its copies out of their buyers' notes (lib/pdf-stamp.ts dropStamped; Claude 5 iYwjc's MÉDIO on
 * #5475): UNNOTE_PAGE notes at a time, at most UNNOTE_PAGES_PER_CALL pages a call, the rest left on a list for the
 * next kept copy, which takes UNNOTE_PAGES_PER_CALL pages of it.
 */
export const UNNOTE_PAGE = 250;
export const UNNOTE_PAGES_PER_CALL = 4;
