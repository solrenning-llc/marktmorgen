/**
 * A store's Vercel Blob bytes, listed at most once a UTC day (owner's decision, 16 November 2026: "Medir só 1x por
 * dia"; #2848, MR audit item 5).
 *
 * A listing of the store's Blob folder (lib/file-store.ts, blobHeld) is up to twenty Advanced Operations, each tried
 * again by the SDK, so a vault open no longer lists it every time. The first open of a UTC day lists it and keeps the
 * total with the moment the listing began; every later open that day reads that total plus every byte a write into the
 * folder may have added since, from a tally taken BEFORE the write is sent (lib/blob.ts: a put by its body's bytes, a
 * put token at its maximum size, whether or not the browser then sends anything). The tally is kept in hourly buckets,
 * and the buckets are read from BLOB_TALLY_WINDOW_MS before the listing began, so a write tallied before the listing
 * and landing after it is still counted (a write that landed before it is counted twice: more, never less). A file
 * deleted from the Blob folder is taken off at the next day's listing, not before.
 *
 * Unknown is never zero: a tally or a kept total that does not read in its exact shape, or a store that cannot be
 * reached, refuses the open (a kept total that does not read is listed again, inside the day's one listing), and a day
 * whose one listing is spent with no total kept refuses until the next UTC day ("storage_daily"), never listing again.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Listings of a store's Blob folder a UTC day: one (the owner, 16 November 2026). */
export const BLOB_MEASURES_PER_DAY = 1;
/** The longest a put token for a path in a store's folder may live (lib/blob.ts refuses a longer one); the doors sign five or ten minutes. */
export const BLOB_PUT_TOKEN_MAX_MS = 15 * 60_000;
/**
 * How far before a listing the tally is read: a token's whole life and the upload it let start, and a server's put,
 * which lib/blob.ts gives up after BLOB_WRITE_TIMEOUT_MS (45 seconds).
 */
export const BLOB_TALLY_WINDOW_MS = HOUR_MS;
/** How long the kept total, the day's mark and each bucket are kept: longer than a day and the window. */
export const BLOB_TALLY_KEEP_SECONDS = 3 * 86_400;

const FOLDER = /^[a-f0-9]{32}$/;
const IN_FOLDER = /^stores\/([a-f0-9]{32})\//;

/** The keys, one family (nl:storage:blob:): the kept total, the day's one listing, and each hour's tally. */
export const blobTallyKeys = {
  kept: (folder: string) => `nl:storage:blob:${folder}`,
  day: (folder: string, day: number) => `nl:storage:blob:${folder}:day:${day}`,
  added: (folder: string, hour: number) => `nl:storage:blob:${folder}:add:${hour}`,
};

/** The store folder a Blob path is measured with, or null when no store's listing includes it. */
export function talliedFolder(pathname: unknown): string | null {
  if (typeof pathname !== "string") return null;
  return IN_FOLDER.exec(pathname)?.[1] ?? null;
}

/**
 * Tallies `bytes` a write into a store's Blob folder may add, before it is sent. Throws when the bytes are not known
 * or the tally could not be written, and then the write must not be sent. Nothing for a path no store's listing holds.
 * With no Redis at all nothing can keep or read a total either (a vault open refuses), so there is nothing to tally.
 */
export async function tallyBlobWrite(pathname: string, bytes: number): Promise<void> {
  const folder = talliedFolder(pathname);
  if (folder === null) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("blob_tally_unknown");
  if (!isRedisConfigured()) return;
  const key = blobTallyKeys.added(folder, Math.floor(Date.now() / HOUR_MS));
  const [added, kept] = await redisPipeline([["INCRBY", key, bytes], ["EXPIRE", key, BLOB_TALLY_KEEP_SECONDS]]);
  if (typeof added !== "number" || !Number.isSafeInteger(added) || added < bytes || kept !== 1) throw new Error("blob_tally_unknown");
}

type Kept = { day: number; at: number; bytes: number };

function readKept(raw: unknown, day: number, now: number): Kept | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { day: d, at, bytes } = value as Record<string, unknown>;
  if (d !== day || !Number.isSafeInteger(at) || !Number.isSafeInteger(bytes) || (bytes as number) < 0 ||
      Math.floor((at as number) / DAY_MS) !== day || (at as number) > now) return null;
  return { day, at: at as number, bytes: bytes as number };
}

/** Every byte tallied from the hour of `from` to the hour of `to`. Throws on a bucket that does not read. */
async function addedSince(folder: string, from: number, to: number): Promise<number> {
  const first = Math.floor(from / HOUR_MS), last = Math.floor(to / HOUR_MS);
  if (last < first || last - first > 48) throw new Error("storage_unknown");
  const keys: string[] = [];
  for (let hour = first; hour <= last; hour += 1) keys.push(blobTallyKeys.added(folder, hour));
  const [values] = await redisPipeline([["MGET", ...keys]]);
  if (!Array.isArray(values) || values.length !== keys.length) throw new Error("storage_unknown");
  let sum = 0;
  for (const value of values) {
    if (value === null) continue;
    const bytes = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("storage_unknown");
    sum += bytes;
    if (!Number.isSafeInteger(sum)) throw new Error("storage_unknown");
  }
  return sum;
}

/**
 * What a store keeps in its Blob folder, never less than what is there: `list` (the full listing) runs at most once a
 * UTC day for the folder; otherwise the day's kept total and the tally since. Callers measure under the store's
 * storage lease (lib/storage-reservations.ts), and the day's mark is taken with SET NX besides, so two opens never
 * both list.
 */
export async function blobHeldToday(folder: string, list: (folder: string) => Promise<number>): Promise<number> {
  if (!FOLDER.test(folder) || !isRedisConfigured()) throw new Error("storage_unknown");
  // Twice at most: a day's mark whose OK came back after midnight is yesterday's, so it never starts a listing (Codex N1
  // on #2848, MEDIUM: that listing and the new day's would be two); the new day is claimed instead. A second midnight
  // in one call is refused as the day's listing spent, never a listing on a guess.
  for (let rollover = 0; rollover < 2; rollover += 1) {
    const day = Math.floor(Date.now() / DAY_MS);
    const read = async () => readKept((await redisPipeline([["GET", blobTallyKeys.kept(folder)]]))[0], day, Date.now());
    let kept = await read();
    if (kept === null) {
      const [claimed] = await redisPipeline([["SET", blobTallyKeys.day(folder, day), "1", "NX", "EX", BLOB_TALLY_KEEP_SECONDS]]);
      if (claimed === "OK") {
        if (Math.floor(Date.now() / DAY_MS) !== day) continue;
        const at = Date.now();
        const bytes = await list(folder);
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("storage_unknown");
        const [written] = await redisPipeline([["SET", blobTallyKeys.kept(folder), JSON.stringify({ day, at, bytes }), "EX", BLOB_TALLY_KEEP_SECONDS]]);
        if (written !== "OK") throw new Error("storage_unknown");
        kept = { day, at, bytes };
      } else if (claimed === null) {
        kept = await read();
        if (kept === null) throw new Error("storage_daily");
      } else {
        throw new Error("storage_unknown");
      }
    }
    const total = kept.bytes + (await addedSince(folder, kept.at - BLOB_TALLY_WINDOW_MS, Date.now()));
    if (!Number.isSafeInteger(total)) throw new Error("storage_unknown");
    return total;
  }
  throw new Error("storage_daily");
}
