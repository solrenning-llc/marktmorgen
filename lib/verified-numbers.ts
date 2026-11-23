/**
 * Numbers counted by the platform, for others to read (added 13 October
 * 2026): what the media kit can show a brand beside the follower counts the
 * creator types, and what a read-only link shows a partner
 * (lib/numbers-links.ts).
 *
 * Read before it was built: Plausible's, Fathom's, Simple Analytics' and
 * Pirsch's shared dashboards (a link, optionally with a password),
 * Baremetrics' Open Startups, DataFast's public dashboard and widgets, and
 * TrustMRR, which lists revenue read from the payment account rather than
 * typed. What they share is that the number comes from the system that
 * counted it, with the day it was read.
 *
 * Worked out once a day for the stores that use it (sendVerified, from the
 * daily job) and kept; the media kit and the link read only that record, so
 * opening them asks nothing of Stripe. Each record says the day it was read
 * and where each number comes from: visits counted on this store's pages,
 * payments on the creator's own Stripe account. Nobody is in it: no
 * address, no name, countries only as shares.
 *
 *   nl:verified:<statsId>   the record, three days
 *   nl:verified:cursor      where the last daily pass stopped
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { types } from "node:util";
import { readFullNumbers } from "@/lib/mcp-tools";
import { readTitles } from "@/lib/catalog";
import { type Store, storesAfter } from "@/lib/store";
import type { StatsData } from "@/lib/stats";
import { paidFiguresComplete } from "@/lib/paid-coverage";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";

export type VerifiedWindow = { visitors: number; views: number; checkouts: number; sales: number | null; cents: number | null };

export type Verified = {
  /** Identifies snapshots whose producer checked paid-reading completeness. */
  coverageVersion: 1;
  /** The day it was read (UTC), and when. */
  day: string;
  at: number;
  currency: string;
  /** Whether the sales were read from Stripe; false leaves them out. */
  salesRead: boolean;
  windows: { d7: VerifiedWindow; d30: VerifiedWindow; d90: VerifiedWindow };
  /** The last 30 days by channel, the biggest first. */
  channels: { source: string; visits: number; sales: number | null; cents: number | null }[];
  /** The last 30 days by product, the biggest first. */
  products: { title: string; sales: number; cents: number }[];
  /** Buyers' countries over the 90 days, as shares of the sales with one, the biggest first. */
  countries: { country: string; share: number }[];
};

const KEEP_SECONDS = 3 * 86_400;
const CURSOR_KEY = "nl:verified:cursor";
const key = (statsId: string) => `nl:verified:${statsId}`;

/** The record from the studio's own numbers. Pure. */
export function verifiedFrom(data: StatsData, titles: Map<string, string>, now: number): Verified {
  const known = paidFiguresComplete(data);
  const window = (w: "d7" | "d30" | "d90"): VerifiedWindow => {
    const t = data.totals[w];
    return { visitors: t.visitors, views: t.views, checkouts: t.checkouts, sales: known ? t.sales : null, cents: known ? t.cents : null };
  };
  const countries = data.salesCountries?.d90 ?? [];
  const withCountry = countries.reduce((sum, c) => sum + c.sales, 0);
  return {
    coverageVersion: 1,
    day: new Date(now).toISOString().slice(0, 10),
    at: Math.floor(now / 1000),
    currency: data.currency,
    salesRead: known,
    windows: { d7: window("d7"), d30: window("d30"), d90: window("d90") },
    channels: (data.channels?.d30 ?? []).slice(0, 8).map((c) => ({ source: c.source, visits: c.visits, sales: known ? c.sales : null, cents: known ? c.cents : null })),
    products: known
      ? data.products
          .filter((p) => p.d30.sales > 0)
          .sort((a, b) => b.d30.cents - a.d30.cents)
          .slice(0, 8)
          .map((p) => ({ title: titles.get(p.id) ?? (p.title || "A product no longer listed"), sales: p.d30.sales, cents: p.d30.cents }))
      : [],
    countries: known && withCountry > 0 ? countries.slice(0, 6).map((c) => ({ country: c.country, share: Math.round((c.sales / withCountry) * 1000) / 1000 })) : [],
  };
}

function recordWith(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)));
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parse(raw: unknown): Verified | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    // Legacy snapshots could certify a partial purchase reading. They have no
    // coverage provenance, so leave them unavailable until normal refresh.
    if (!recordWith(value, ["coverageVersion", "day", "at", "currency", "salesRead", "windows", "channels", "products", "countries"]) || value.coverageVersion !== 1) return null;
    if (typeof value.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !count(value.at) || !Number.isSafeInteger(value.at * 1000) || new Date(value.at * 1000).toISOString().slice(0, 10) !== value.day) return null;
    if (typeof value.currency !== "string" || !/^[a-zA-Z]{3}$/.test(value.currency) || typeof value.salesRead !== "boolean") return null;
    const money = (v: unknown) => value.salesRead ? count(v) : v === null;
    if (!recordWith(value.windows, ["d7", "d30", "d90"]) || !Object.values(value.windows).every(w => recordWith(w, ["visitors", "views", "checkouts", "sales", "cents"]) && count(w.visitors) && count(w.views) && count(w.checkouts) && money(w.sales) && money(w.cents))) return null;
    // These are the existing writer's list ceilings, not a new display limit.
    if (!Array.isArray(value.channels) || value.channels.length > 8 || !value.channels.every(c => recordWith(c, ["source", "visits", "sales", "cents"]) && typeof c.source === "string" && count(c.visits) && money(c.sales) && money(c.cents))) return null;
    if (!Array.isArray(value.products) || value.products.length > 8 || !value.products.every(p => recordWith(p, ["title", "sales", "cents"]) && typeof p.title === "string" && count(p.sales) && count(p.cents))) return null;
    if (!Array.isArray(value.countries) || value.countries.length > 6 || !value.countries.every(c => recordWith(c, ["country", "share"]) && typeof c.country === "string" && typeof c.share === "number" && Number.isFinite(c.share) && c.share >= 0 && c.share <= 1)) return null;
    if (!value.salesRead && (value.products.length || value.countries.length)) return null;
    // The writer uses JSON.stringify. A duplicate member must not silently
    // select which saved count or availability flag is presented as known.
    if (JSON.stringify(value) !== raw) return null;
    return value as Verified;
  } catch {
    return null;
  }
}

/** The record kept for a store, or null before the first one. */
export async function readVerified(store: Pick<Store, "statsId">): Promise<Verified | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const reply = await redisPipeline([["GET", key(store.statsId)]]);
  if (types.isProxy(reply) || !Array.isArray(reply) || reply.length !== 1) return null;
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  return slot && Object.hasOwn(slot, "value") ? parse(slot.value) : null;
}

/** Reads the numbers again and keeps them: from the daily job, and when the creator first turns one on. */
export async function refreshVerified(store: Store, now = Date.now()): Promise<Verified | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  // The studio's numbers with the products in them, read as the studio reads them.
  const data = await readFullNumbers(store, now);
  if (!data) return null;
  const titles = await readTitles(store).catch(() => new Map<string, string>());
  const record = verifiedFrom(data, titles, now);
  // Kept only when Redis said OK: another reply leaves the record unknown, never counted as kept (CX-123 rule 24).
  const kept = repliesFor(await redisPipeline([["SET", key(store.statsId), JSON.stringify(record), "EX", KEEP_SECONDS]]), 1);
  if (kept?.[0] !== "OK") throw new UnknownReplyError("keeping the shared numbers");
  return record;
}

/** Whether a store shows these numbers anywhere: in its media kit, or through a link that still works. */
export function usesVerified(store: Store, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const counted = store.kit.counted;
  const kit = store.kit.on && Boolean(counted && (counted.visitors || counted.sales || counted.countries));
  return kit || (store.numbersLinks ?? []).some((l) => l.expires > nowSeconds);
}

/** A Redis SCAN cursor: an unsigned 64-bit decimal, kept as a string, with no leading zero. */
function scanCursor(value: string): boolean {
  return /^(0|[1-9]\d{0,19})$/.test(value) && (value.length < 20 || value <= "18446744073709551615");
}

/** The daily pass: every store that shows them, from where the last pass stopped. */
export async function sendVerified(deadline: number): Promise<{ stores: number }> {
  const counts = { stores: 0 };
  if (!isRedisConfigured()) return counts;
  // Where the last pass stopped: a string, or null before the first pass. Any other reply is unknown and the
  // pass stops here, so the kept position is not overwritten by one counted from the start (CX-123 rule 24).
  const read = repliesFor(await redisPipeline([["GET", CURSOR_KEY]]), 1);
  const saved = read?.[0];
  if (!read || (saved !== null && typeof saved !== "string")) throw new UnknownReplyError("where the shared numbers' last pass stopped");
  let cursor = "0";
  let skip = 0;
  if (saved !== null) {
    // Only the writer's complete cursor|offset format is a saved position.
    // Redis SCAN cursors are unsigned 64-bit decimals; keep them as strings.
    const position = /^(0|[1-9]\d{0,19})\|(0|[1-9]\d{0,15})$/.exec(saved);
    if (!position || position[0] !== saved || !scanCursor(position[1]) ||
      !Number.isSafeInteger(Number(position[2]))) {
      throw new UnknownReplyError("the shared numbers' saved position");
    }
    cursor = position[1];
    skip = Number(position[2]);
  }
  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      if (Date.now() >= deadline) break;
      if (usesVerified(store)) {
        try {
          await refreshVerified(store);
          counts.stores += 1;
        } catch (error) {
          console.error("reading the shared numbers failed", store.handle, error);
        }
      }
      done += 1;
    }
    if (done < stores.length) {
      await redisPipeline([["SET", CURSOR_KEY, `${cursor}|${done}`]]);
      return counts;
    }
    skip = 0;
    // storesAfter hands back the SCAN reply's cursor unchecked: an unreadable one is unknown, and saving it
    // would leave a position the reader above refuses on every later run. Stop without writing instead.
    if (!scanCursor(next)) throw new UnknownReplyError("where the shared numbers' store scan goes next");
    cursor = next;
    if (next === "0") break;
  }
  await redisPipeline([["SET", CURSOR_KEY, `${cursor}|0`]]);
  return counts;
}
