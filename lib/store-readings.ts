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
 *   nl:reading:day:<statsId>:<day>:heavy   of them, the heavy ones
 *   nl:reading:update:<statsId>:<day> a product update's searches, two days
 *
 * A reading kept is shown as it is, with the time it was read, never as an
 * incomplete one (inbox C4-33): the page says when it was read, offers to
 * read again while the day has a reading left, and once they are used says
 * when they come back, at 00:00 UTC.
 */
import { nextUtcMidnight } from "@/lib/local-clock";
import { HEAVY_READINGS_PER_DAY, READING_FRESH_SECONDS, STORE_READINGS_PER_DAY, UPDATE_SEARCHES_PER_DAY } from "@/lib/store-reading-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { type SalesStats, type Stats, type StatsData, readSales, readStats, readsSales, studioStats } from "@/lib/stats";
import { type Numbers, membershipNumbers } from "@/lib/membership-numbers";

// The day's figures live in lib/store-reading-rules.ts, which the help reads without the database.
export { HEAVY_READINGS_PER_DAY, READING_FRESH_SECONDS, STORE_READINGS_PER_DAY, UPDATE_SEARCHES_PER_DAY };

/** How long the last reading is kept to show when the day's readings are used. */
export const READING_KEEP_SECONDS = 86_400;
/** The largest reading kept, in bytes; one larger is read each time, from the budget. */
export const READING_COPY_MAX_BYTES = 131_072;

export type ReadingKind = "stats" | "sales" | "members";
export const READING_KINDS: readonly ReadingKind[] = ["stats", "sales", "members"];

const copyKey = (kind: ReadingKind, statsId: string) => `nl:reading:${kind}:${statsId}`;
const dayKey = (statsId: string, day: string) => `nl:reading:day:${statsId}:${day}`;
const updateKey = (statsId: string, day: string) => `nl:reading:update:${statsId}:${day}`;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** When the day's readings come back: the next 00:00 UTC, in milliseconds. */
export function readingsBackAt(now = Date.now()): number {
  return nextUtcMidnight(now);
}

/** Taken when none kept may be shown and none may be read today: said as such, never as no numbers. */
export class ReadingsUsed extends Error {
  constructor() {
    super("the store's readings are used for today");
    this.name = "ReadingsUsed";
  }
}

/**
 * Whether the day still has a reading, and a heavy one, left: two GET, for a
 * page that offers to read again. Unknown is none, so nothing is offered that
 * would be refused.
 */
export async function readingsLeft(store: Pick<Store, "statsId">, now = Date.now()): Promise<{ any: boolean; heavy: boolean }> {
  if (!store.statsId || !isRedisConfigured()) return { any: false, heavy: false };
  const key = dayKey(store.statsId, utcDay(now));
  try {
    const [raw, rawHeavy] = await redisPipeline([["GET", key], ["GET", `${key}:heavy`]]);
    const n = raw === null ? 0 : Number(raw);
    const h = rawHeavy === null ? 0 : Number(rawHeavy);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(h)) return { any: false, heavy: false };
    return { any: n < STORE_READINGS_PER_DAY, heavy: n < STORE_READINGS_PER_DAY && h < HEAVY_READINGS_PER_DAY };
  } catch {
    return { any: false, heavy: false };
  }
}

/**
 * One of a product update's searches of the day, from its own count (SET NX,
 * INCRBY, EXPIRE NX; DECRBY when past it). A count that cannot be made is a
 * refusal.
 */
export async function takeUpdateSearch(store: Pick<Store, "statsId">, now = Date.now()): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const key = updateKey(store.statsId, utcDay(now));
  try {
    const [, raw] = await redisPipeline([
      ["SET", key, "0", "NX", "EX", 2 * 86_400],
      ["INCRBY", key, 1],
      ["EXPIRE", key, 2 * 86_400, "NX"],
    ]);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) return false;
    if (n <= UPDATE_SEARCHES_PER_DAY) return true;
    await redisPipeline([["DECRBY", key, 1]]).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

/**
 * One of the store's readings of the day, taken whole or not at all: SET NX
 * with its expiry, INCRBY, EXPIRE NX, and DECRBY when past the day's figure.
 * A count that cannot be made is a refusal.
 */
export async function takeStoreReading(store: Pick<Store, "statsId">, now = Date.now(), heavy = false): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  const key = dayKey(store.statsId, utcDay(now));
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
 * A reading of `kind`, kept: the one kept when it is fresh (unless `fresh`
 * asks to read again); otherwise, when the day's budget allows, `read` again
 * and kept; otherwise the last one kept, `stale`. With none kept: null when
 * the store has no counts at all, ReadingsUsed when none may be read today.
 * A reading that fails leaves the last one kept, stale, or throws when there
 * is none.
 */
export async function keptReading<T>(store: Pick<Store, "statsId">, kind: ReadingKind, read: () => Promise<T>, now = Date.now(), fresh = false): Promise<Kept<T> | null> {
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
  if (kept && !fresh && now - kept.at < READING_FRESH_SECONDS * 1000) return kept;
  if (!(await takeStoreReading(store, now, kind === "sales"))) {
    if (kept) return { ...kept, stale: true };
    throw new ReadingsUsed();
  }
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
export async function keptStats(store: Store, now = Date.now(), fresh = false): Promise<Kept<Stats | null> | null> {
  return keptReading(store, "stats", () => readStats(store, now), now, fresh);
}

/**
 * The store's sales, kept (lib/stats.ts, readSales), as they were read: a
 * reading kept from earlier is shown whole with its time (`at`), never marked
 * incomplete for being kept (inbox C4-33 (2)).
 */
export async function keptSales(store: Store, now = Date.now(), fresh = false): Promise<Kept<SalesStats | null>> {
  const kept = await keptReading(store, "sales", () => readSales(store, now), now, fresh);
  if (!kept) throw new ReadingsUsed();
  return kept;
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
    const sales = (await keptSales(store, now)).value;
    return studioStats(store, stats, sales, sales ? "ok" : "error", []);
  } catch (error) {
    console.error("reading sales for a summary failed", error);
    return studioStats(store, stats, null, "error", []);
  }
}

/**
 * A store's kept readings, gone (inbox C4-33, light d): at its deletion, all
 * of them; at a person's erasure, its sales, which name its biggest buyers by
 * their address (lib/person-erasure.ts). Read again, the next one leaves the
 * person out. The day's counts name no one and stay.
 */
export async function forgetStoreReadings(statsId: string | null | undefined): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", ...READING_KINDS.map((kind) => copyKey(kind, statsId))]]);
}

/**
 * A person's erasure: the store's kept sales reading goes; returns how many
 * copies went. Not yet one of lib/person-erasure.ts's steps: each step needs
 * its line in lib/person-data.ts, another agent's file today (inbox C4-33,
 * light d); until then the copy names a buyer at most READING_KEEP_SECONDS.
 */
export async function forgetReadingsPerson(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", copyKey("sales", statsId)]]);
  return Number(gone) || 0;
}
