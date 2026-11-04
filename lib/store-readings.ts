/**
 * A store's readings of its own numbers from its Stripe account and its
 * counts (C4-4; the owner's decision of 4 November 2026, inbox C4-18): its
 * days of visits (lib/stats.ts, readStats), its sales, renewals, refunds and
 * disputes (readSales), its memberships (lib/membership-numbers.ts), and a
 * product update's search for its buyers (lib/product-updates.ts).
 *
 * The page that shows them still costs what the Terms say a studio page
 * costs, STUDIO_PAGE_UNITS of the studio's requests, and nothing more of that
 * figure: what a reading costs past it comes from a budget of the store's own,
 * STORE_READINGS_PER_DAY a UTC day, counted before Stripe or the counts are
 * read, priced in its own line (tests/plan-cost-registry.ts, store-readings).
 * What was read is kept READING_FRESH_SECONDS for every page that shows it
 * (the studio's home, the totals of every store), so looking again does not
 * read again; and kept READING_KEEP_SECONDS more, so that when the day's
 * readings are used the last one is shown rather than nothing: sales so kept
 * are marked as not read in full, so the pages say what they already say of
 * such a reading (that the sales may be lower than they are); visits so kept
 * are at most a day old. A reading larger than READING_COPY_MAX_BYTES is not
 * kept.
 *
 *   nl:reading:<kind>:<statsId>       { at, value }, a day
 *   nl:reading:day:<statsId>:<day>    the day's readings, two days
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { type SalesStats, type Stats, type StatsData, readSales, readStats, readsSales, studioStats } from "@/lib/stats";
import { type Numbers, membershipNumbers } from "@/lib/membership-numbers";

/** Readings a store may take in a UTC day, every page and kind together. */
export const STORE_READINGS_PER_DAY = 8;
/**
 * Of them, the heavy ones: its sales (every PayPal sale and refund record read,
 * lib/read-ceilings.ts SALES_READ_SHAPE) and a product update's search for its
 * buyers (UPDATE_READ_SHAPE). The rest of the day's readings are light, so the
 * day's worst stays inside the first-payment refund the owner funds
 * (tests/plan-margin.test.ts, US$ 65; inbox C4-18).
 */
export const HEAVY_READINGS_PER_DAY = 3;
/** How long a reading is shown as it is before it is read again. */
export const READING_FRESH_SECONDS = 600;
/** How long the last reading is kept to show when the day's readings are used. */
export const READING_KEEP_SECONDS = 86_400;
/** The largest reading kept, in bytes; one larger is read each time, from the budget. */
export const READING_COPY_MAX_BYTES = 131_072;

export type ReadingKind = "stats" | "sales" | "members";
export const READING_KINDS: readonly ReadingKind[] = ["stats", "sales", "members"];

const copyKey = (kind: ReadingKind, statsId: string) => `nl:reading:${kind}:${statsId}`;
const dayKey = (statsId: string, day: string) => `nl:reading:day:${statsId}:${day}`;

/**
 * One of the store's readings of the day, taken whole or not at all: SET NX
 * with its expiry, INCRBY, EXPIRE NX, and DECRBY when past the day's figure.
 * A count that cannot be made is a refusal.
 */
export async function takeStoreReading(store: Pick<Store, "statsId">, now = Date.now(), heavy = false): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const key = dayKey(store.statsId, new Date(now).toISOString().slice(0, 10));
  const heavyKey = `${key}:heavy`;
  try {
    const [, raw, , , rawHeavy] = await redisPipeline([
      ["SET", key, "0", "NX", "EX", 2 * 86_400],
      ["INCRBY", key, 1],
      ["EXPIRE", key, 2 * 86_400, "NX"],
      ...(heavy ? [["SET", heavyKey, "0", "NX", "EX", 2 * 86_400], ["INCRBY", heavyKey, 1]] : []),
    ]);
    const n = Number(raw);
    const h = heavy ? Number(rawHeavy) : 0;
    if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(h) || (heavy && h < 1)) return false;
    if (n <= STORE_READINGS_PER_DAY && h <= HEAVY_READINGS_PER_DAY) return true;
    await redisPipeline([["DECRBY", key, 1], ...(heavy ? [["DECRBY", heavyKey, 1]] : [])]).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

export type Kept<T> = { value: T; at: number; stale: boolean };

/**
 * A reading of `kind`, kept: the one kept when it is fresh; otherwise, when
 * the day's budget allows, `read` again and kept; otherwise the last one kept,
 * `stale`; null when there is none and none may be read. A reading that
 * fails leaves the last one kept, stale, or throws when there is none.
 */
export async function keptReading<T>(store: Pick<Store, "statsId">, kind: ReadingKind, read: () => Promise<T>, now = Date.now()): Promise<Kept<T> | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const key = copyKey(kind, store.statsId);
  let kept: Kept<T> | null = null;
  try {
    const [raw] = await redisPipeline([["GET", key]]);
    if (typeof raw === "string" && raw) {
      const parsed = JSON.parse(raw) as { at?: unknown; value?: unknown };
      if (typeof parsed.at === "number" && parsed.value !== undefined) kept = { value: parsed.value as T, at: parsed.at, stale: false };
    }
  } catch {
    kept = null;
  }
  if (kept && now - kept.at < READING_FRESH_SECONDS * 1000) return kept;
  if (!(await takeStoreReading(store, now, kind === "sales"))) return kept ? { ...kept, stale: true } : null;
  let value: T;
  try {
    value = await read();
  } catch (error) {
    if (kept) return { ...kept, stale: true };
    throw error;
  }
  const text = JSON.stringify({ at: now, value });
  if (value !== null && value !== undefined && Buffer.byteLength(text, "utf8") <= READING_COPY_MAX_BYTES) {
    await redisPipeline([["SET", key, text, "EX", READING_KEEP_SECONDS]]).catch(() => {});
  }
  return { value, at: now, stale: false };
}

/** The store's visits, kept (lib/stats.ts, readStats). */
export async function keptStats(store: Store, now = Date.now()): Promise<Kept<Stats | null> | null> {
  return keptReading(store, "stats", () => readStats(store, now), now);
}

/** The store's sales, kept (lib/stats.ts, readSales); a reading kept from earlier than fresh is marked not read in full. */
export async function keptSales(store: Store, now = Date.now()): Promise<SalesStats | null> {
  const kept = await keptReading(store, "sales", () => readSales(store, now), now);
  // None kept and none may be read today: said as a reading that failed, never as no sales.
  if (!kept) throw new Error("the store's readings of its sales are used for today");
  if (!kept.value) return null;
  return kept.stale ? { ...kept.value, partial: true } : kept.value;
}

/** The store's memberships, kept (lib/membership-numbers.ts). */
export async function keptMembers(store: Store, now = Date.now()): Promise<Numbers | null> {
  return (await keptReading(store, "members", () => membershipNumbers(store, false, now), now))?.value ?? null;
}

/**
 * The store's numbers as lib/stats-report.ts, readNumbers, puts them
 * together, from its kept readings: for the totals of every store.
 */
export async function keptNumbers(store: Store, now = Date.now()): Promise<StatsData | null> {
  const stats = (await keptStats(store, now))?.value ?? null;
  if (!stats) return null;
  if (!readsSales(store)) return studioStats(store, stats, null, "none", []);
  try {
    const sales = await keptSales(store, now);
    return studioStats(store, stats, sales, sales ? "ok" : "error", []);
  } catch (error) {
    console.error("reading sales for a summary failed", error);
    return studioStats(store, stats, null, "error", []);
  }
}
