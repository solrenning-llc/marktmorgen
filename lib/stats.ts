import {measureSalesLevers,type LeverReading} from "@/lib/sales-levers";
import { rangeTrafficCoverage, statsTrafficCoverage } from "@/lib/range-traffic-coverage";
import { creativeRowsFrom } from "@/lib/creative-results";
/**
 * How many people visit a store, where they come from, and how many of them
 * start to pay.
 *
 * Counted without a cookie and without keeping anybody's address. A visitor
 * is told apart from another for one day only, by a one-way fingerprint of
 * the day, the store, their network address and their browser, and even that
 * fingerprint is not kept: it goes into Redis's HyperLogLog, which keeps an
 * estimate of how many different ones it has seen and nothing from which any
 * one of them could be read back.
 *
 * Every day has a record of its own, kept KEPT_DAYS days, and the studio
 * reads the last STATS_DAYS of them for its 7, 30 and 90 day views. "All
 * time" has a record of its own that never expires: the same counts, added
 * to as they happen, and filled once from whatever days are still kept the
 * first time it is read. So all time begins at the store's first counted
 * visit still on record, which the studio says.
 *
 * Where a visit came from is kept three ways: the source (the site, the app,
 * or the utm_source tag on the creator's link), and the utm_medium and
 * utm_campaign tags when the link carries them.
 *
 * Sales are not counted here. They are read from the creator's own Stripe
 * account, which is the only record of money that deserves the name.
 */
import { type Paid, paypalPaymentId, readPayPalRefundsWithCoverage, readPayPalSales, sellsThroughPayPal } from "@/lib/paypal-sales";
import { DISPUTE_TAKES, type Entry, type KeptWindow, keptByCurrency } from "@/lib/retained-revenue";
import { buyerChannelsFrom, type BuyerChannels } from "@/lib/buyer-channel-rules";
import { type DiscountRow, discountImpact } from "@/lib/discount-impact";
import { saleHandles } from "@/lib/store";
import { type Together, parseTogether, togetherFrom } from "@/lib/also-bought";
import { keepPaths, pathsFrom } from "@/lib/next-bought";
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { onAccount } from "@/lib/stripe-account";
import type { Listing, Store } from "@/lib/store";
import { listingFinder, productIds, recordListings } from "@/lib/catalog";
import { plainAmount } from "@/lib/money";
import { revenueBySource } from "@/lib/came-from";
import { type AttributionTable, attributionTable } from "@/lib/attribution-rules";
import { bumpsFromMeta } from "@/lib/bundle-rules";
import { reachRows } from "@/lib/page-read";
import { PAGE_PARTS } from "@/lib/store-order";
import { type TaxSummary, taxSummary } from "@/lib/tax-summary";
import { type CappedCount, cappedCount, cappedCountCommand } from "@/lib/capped-count";

/** Days kept, a little over a year, so a year-on-year look is possible. */
const TTL_SECONDS = 400 * 86400;

/** The longest window read day by day. "All time" is kept apart (below). */
export const STATS_DAYS = 90;

/** How many days of visits are kept, and so how far back an export of them goes. */
export const KEPT_DAYS = 400;

const MAX_SOURCES = 40;

/**
 * The most fields one day's record may have (since 18 October 2026): every
 * new source, country, term or block a request names was a field kept for
 * KEPT_DAYS, so what a store's numbers kept grew with its requests. Past
 * this a day's new names are counted together under "~" (lib/capped-count.ts),
 * and the day's totals stay right. A day of a busy store names some 60.
 */
export const DAY_FIELDS_MAX = 100;
/** The most fields the all-time record may have between the trims that read it (readLife): its own and LIFE_MAX_FIELDS of counts. */
export const LIFE_WRITE_MAX = 2_100;

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const countsKey = (statsId: string, day: string) => `nl:stats:${statsId}:${day}`;
const visitorsKey = (statsId: string, day: string) => `nl:stats:${statsId}:${day}:u`;
const lifeKey = (statsId: string) => `nl:stats:${statsId}:life`;
const lifeLockKey = (statsId: string) => `nl:stats:${statsId}:life:lock`;
/** Who is on the store now: one member per visitor and page, scored by when (readLive). */
const liveKey = (statsId: string) => `nl:stats:${statsId}:live`;
/** How long somebody counts as on the store after their last page. */
export const LIVE_MINUTES = 5;

import { isBot, classifySource, cleanTag } from "@/lib/source-rules";
export { isBot, classifySource, cleanTag };

export type HitKind = "view" | "checkout" | "link" | "product" | "signup";

/**
 * Counts one thing a visitor did.
 *
 * A view is counted once per page load, from the page itself; a checkout is
 * counted by the server when a buyer presses the button that takes them to
 * pay, or to get something free; a link is counted when one is opened. Each
 * is added to its day and to the store's all-time record together.
 */
export async function recordHit(
  store: Store,
  hit: {
    kind: HitKind;
    id?: string;
    source?: string;
    medium?: string;
    campaign?: string;
    ip: string;
    userAgent: string;
    /** A view's country, two letters, as the host read it (lib/visit.ts). */
    country?: string;
    /** A view's kind of device: "mobile", "tablet" or "desktop" (lib/source-rules.ts deviceOf). */
    device?: string;
    /** A checkout's channel (lib/visit-channel.ts), "" or "direct" when none. */
    channel?: string;
    /** A checkout that was a free product's address asked for. */
    free?: boolean;
  },
  now = Date.now(),
): Promise<number | null> {
  if (!store.statsId || !isRedisConfigured() || isBot(hit.userAgent)) return null;
  const day = dayKey(now);
  const counts = countsKey(store.statsId, day);
  const life = lifeKey(store.statsId);
  // The day's and all-time counts, each hash held to its most fields
  // (lib/capped-count.ts); the visitors and who is on now beside them.
  const tally: CappedCount[] = [];
  const inDay = (field: string) => tally.push({ hash: 0, field, by: 1 });
  const commands: (string | number)[][] = [];
  const both = (field: string) => {
    inDay(field);
    tally.push({ hash: 1, field, by: 1 });
  };
  let pfAt = -1;
  // The position of the day's own count for this kind of hit: when it comes
  // back as 1, this is the first such write of the day, and only then are
  // the day's expiry and the all-time record's start written (below).
  let firstAt = -1;
  if (hit.kind === "view") {
    const visitor = createHash("sha256")
      .update(`${day}|${store.statsId}|${hit.ip}|${hit.userAgent}`)
      .digest("hex")
      .slice(0, 24);
    const visitors = visitorsKey(store.statsId, day);
    firstAt = tally.length;
    // The day's views, and not the all-time record's: since 11 October 2026
    // all-time views are the sum of its sources, which every view adds one to
    // (readLife), so the command is saved on every view (tests/traffic-cost.ts).
    inDay("v");
    both(`r:${hit.source || "direct"}`);
    if (hit.medium) both(`m:${hit.medium}`);
    if (hit.campaign) both(`g:${hit.campaign}`);
    // Where in the world, and on what, added 11 October 2026. The day's
    // record only, like a product page's views: two commands, held in the
    // cost of a visit (tests/traffic-cost.ts), and no all-time figure rather
    // than one that starts on an arbitrary day.
    if (hit.country) inDay(`k:${hit.country}`);
    if (hit.device) inDay(`d:${hit.device}`);
    // Who is here now (readLive): one command, the visitor's day-fingerprint
    // cut short, the page and where they came from. Its expiry is set with the
    // day's first view, below, so the set never outlives a day without views.
    commands.push(["ZADD", liveKey(store.statsId), now, `${visitor.slice(0, 10)}|${(hit.source || "direct").slice(0, 40)}`]);
    pfAt = commands.length;
    commands.push(["PFADD", visitors, visitor]);
  } else if (hit.kind === "checkout" && hit.id) {
    firstAt = tally.length;
    both("c");
    both(`c:${hit.id}`);
    // The channel the checkout came from (lib/visit-channel.ts), so each
    // channel's visits, checkouts and sales can be read side by side; and,
    // for a free product, the address asked for, under the same channel.
    const channel = hit.channel && hit.channel !== "direct" ? hit.channel : "direct";
    both(`cs:${channel}`);
    if (hit.free) both(`fs:${channel}`);
  } else if (hit.kind === "signup") {
    // An address left in the store's sign-up box or on a product's waitlist
    // (added 11 October 2026), counted under its channel beside the free
    // products' addresses: everybody who asked to hear from the creator.
    const channel = hit.channel && hit.channel !== "direct" ? hit.channel : "direct";
    firstAt = tally.length;
    both(`fs:${channel}`);
  } else if (hit.kind === "link" && hit.id) {
    firstAt = tally.length;
    both(`l:${hit.id}`);
  } else if (hit.kind === "product" && hit.id) {
    // A product's own page was opened (each page load sends this once,
    // components/store-beacon.tsx): what its checkouts and sales are read
    // against. One command, and the day's end set once by the first of the
    // day, because every visit's cost is held to what a plan charges for it
    // (tests/traffic-cost.ts). The day's count only, not the all-time
    // record, so "all time" has no figure for it rather than a wrong one.
    const [opened] = await cappedCount(counts, DAY_FIELDS_MAX, [{ field: `pv:${hit.id}`, by: 1 }]);
    if (opened === 1) await redisPipeline([["EXPIRE", counts, TTL_SECONDS]]);
    return null;
  } else {
    return null;
  }
  const [counted, ...results] = await redisPipeline([cappedCountCommand([{ key: counts, most: DAY_FIELDS_MAX }, { key: life, most: LIFE_WRITE_MAX }], tally), ...commands]);
  const values = Array.isArray(counted) ? counted.map(Number) : [];
  // Written once, not on every hit (11 October 2026: every visit's commands
  // are a cost held to what a plan charges, tests/traffic-cost.ts, and these
  // three were sent on every page view though they change nothing after the
  // first). The day's expiry and the day the all-time record started counting
  // — so filling it from the kept days never counts that day or any after it
  // twice — with the day's first write of this kind; the visitors' expiry with
  // the visitor new to the day, who is a visitor for all time too.
  const follow: (string | number)[][] = [];
  if (firstAt >= 0 && values[firstAt] === 1) {
    follow.push(["EXPIRE", counts, TTL_SECONDS], ["HSETNX", life, "started", day]);
    // Those who were on before today let go once a day, so a store viewed
    // every day and never looked at live keeps a day of them, not every one.
    if (hit.kind === "view") follow.push(["ZREMRANGEBYSCORE", liveKey(store.statsId), 0, now - 30 * 60_000], ["EXPIRE", liveKey(store.statsId), 86400]);
  }
  if (pfAt >= 0 && Number(results[pfAt]) === 1) {
    follow.push(["HINCRBY", life, "u", 1], ["EXPIRE", visitorsKey(store.statsId, day), TTL_SECONDS]);
  }
  if (follow.length) await redisPipeline(follow);
  // The store page's views so far today, for the busy-day alert (lib/stats-report.ts).
  return hit.kind === "view" ? values[firstAt] || null : null;
}

/**
 * One measured visit of the store's own page (lib/page-read.ts): the furthest
 * item seen and the one clicked, on the day's record, which the day's first
 * view has already given its expiry. One command, and only for the visitors
 * the page chose to measure.
 */
export async function countReach(statsId: string, field: string, now = Date.now()): Promise<void> {
  if (!isRedisConfigured() || !field.startsWith("sr:")) return;
  await cappedCount(countsKey(statsId, dayKey(now)), DAY_FIELDS_MAX, [{ field, by: 1 }]);
}

/**
 * One address that used its confirmation link (13 [D10]): joining the store's
 * list as an address new to it, a waitlist spot's first press, or a free
 * product's emailed link on its first use. Counted on the all-time record as
 * "lc", which Marktmorgen Path reads its leads from (lib/path-facts.ts); the
 * addresses asked for (fs:<channel>) stay as the store's numbers show them.
 * One command, on a request already counted as a public one.
 */
export async function countConfirmedLead(statsId: string | null | undefined): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await cappedCount(lifeKey(statsId), LIFE_WRITE_MAX, [{ field: CONFIRMED_LEAD_FIELD, by: 1 }]);
}
/** The all-time record's field for confirmed leads (countConfirmedLead). */
export const CONFIRMED_LEAD_FIELD = "lc";

/** One answer's counts: its buyers and their money, and of those, the ones whose sale had no channel. */
export type Heard = { buyers: number; cents: number; unknownBuyers?: number; unknownCents?: number };

/**
 * One buyer's answer to "where did you hear about us?" (lib/heard.ts), and
 * the money of the sale it was given for, on the day's record. Once per paid
 * order, so the day's expiry is written with it rather than trusted to a view.
 */
export async function countHeard(statsId: string, answer: string, cents: number, now = Date.now(), untracked = false): Promise<void> {
  if (!isRedisConfigured()) return;
  const counts = countsKey(statsId, dayKey(now));
  await redisPipeline([
    cappedCountCommand([{ key: counts, most: DAY_FIELDS_MAX }], [
      { hash: 0, field: `h:${answer}`, by: 1 },
      ...(cents > 0 ? [{ hash: 0, field: `hc:${answer}`, by: Math.round(cents) }] : []),
      // A sale no link credited to any channel: what its buyer said is the only
      // trace of where it came from (lib/attribution-rules.ts).
      ...(untracked ? [{ hash: 0, field: `hu:${answer}`, by: 1 }] : []),
      ...(untracked && cents > 0 ? [{ hash: 0, field: `huc:${answer}`, by: Math.round(cents) }] : []),
    ]),
    ["EXPIRE", counts, TTL_SECONDS],
  ]);
}

/**
 * A search of the store that found nothing (added 11 October 2026): the words
 * searched for, counted on the day's record, so the creator sees what people
 * came looking for and could not buy — an idea for the next product, or a
 * word missing from a title. Only the words, lower case, at most 40
 * characters; nothing about who searched. One command, for a search, which
 * one connection may make 30 times in ten minutes.
 */
export async function countSearchMiss(statsId: string, words: string[], now = Date.now()): Promise<void> {
  const term = words.join(" ").slice(0, 40).trim();
  if (!term || !isRedisConfigured()) return;
  await cappedCount(countsKey(statsId, dayKey(now)), DAY_FIELDS_MAX, [{ field: `q:${term}`, by: 1 }]);
}

/** The store page's views and the checkouts started from one day to another, both counted: one read a day, at most 90. */
export async function daysCounts(statsId: string, from: string, to: string): Promise<{ views: number; checkouts: number }> {
  const out = { views: 0, checkouts: 0 };
  if (!isRedisConfigured() || from > to) return out;
  const dates: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); dates.length < 90; at += 86400_000) {
    const day = dayKey(at);
    if (day > to) break;
    dates.push(day);
  }
  const replies = await redisPipeline(dates.map((d) => ["HMGET", countsKey(statsId, d), "v", "c"]));
  for (const reply of replies) {
    if (!Array.isArray(reply)) continue;
    out.views += Number(reply[0]) || 0;
    out.checkouts += Number(reply[1]) || 0;
  }
  return out;
}

/** The store page's views on each of the `days` days before today, oldest first: one read a day. */
export async function viewsBefore(store: Store, days: number, now = Date.now()): Promise<number[]> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const dates = lastDays(now - 86400_000, days);
  const replies = await redisPipeline(dates.map((d) => ["HGET", countsKey(store.statsId as string, d), "v"]));
  return replies.map((r) => Number(r) || 0);
}

/** Today's channels by views so far, biggest first. */
export async function sourcesToday(store: Store, now = Date.now()): Promise<Ranked> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGETALL", countsKey(store.statsId, dayKey(now))]]);
  const tally = new Tally();
  for (const [field, count] of pairs(raw)) if (field.startsWith("r:")) tally.add(field, count);
  return tally.window(0).sources;
}

/**
 * Today so far (added 11 October 2026), as Plausible's "Last 24 hours": the
 * studio's numbers start at seven days, and on the day of a launch or a post
 * that is taking off, today is the only day that matters. Visitors, page
 * views, checkouts started and the channels, from today's own counts (two
 * commands), and today's paid sales from the creator's Stripe, read at most
 * every two minutes. The day is UTC, like every other day in the numbers.
 */
export type Today = {
  date: string;
  visitors: number;
  views: number;
  checkouts: number;
  sources: { source: string; visits: number }[];
  /** Null when Stripe is not connected or did not answer. */
  sales: { sales: number; cents: number } | null;
};
const todaySalesKey = (statsId: string, day: string) => `nl:stats:${statsId}:today:${day}`;
const TODAY_SALES_SECONDS = 120;

export async function readToday(store: Store, now = Date.now()): Promise<Today> {
  const date = dayKey(now);
  const empty: Today = { date, visitors: 0, views: 0, checkouts: 0, sources: [], sales: null };
  if (!store.statsId || !isRedisConfigured()) return empty;
  const statsId = store.statsId;
  const [raw, people, cached] = await redisPipeline([
    ["HGETALL", countsKey(statsId, date)],
    ["PFCOUNT", visitorsKey(statsId, date)],
    ["GET", todaySalesKey(statsId, date)],
  ]);
  const tally = new Tally();
  for (const [field, count] of pairs(raw)) tally.add(field, count);
  const window = tally.window(Number(people) || 0);
  let sales: Today["sales"] = null;
  if (typeof cached === "string") {
    try {
      sales = JSON.parse(cached) as Today["sales"];
    } catch {
      sales = null;
    }
  } else if (readsSales(store)) {
    const start = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    sales = await readPaidSales(store, start, 1)
      .then(({ sales: rows }) => {
        const own = rows.filter((sale) => sale.currency === store.currency && dayKey(sale.created) === date);
        return { sales: own.length, cents: own.reduce((n, sale) => n + sale.cents, 0) };
      })
      .catch(() => null);
    if (sales) await redisPipeline([["SET", todaySalesKey(statsId, date), JSON.stringify(sales), "EX", TODAY_SALES_SECONDS]]);
  }
  return {
    date,
    visitors: window.visitors,
    views: window.views,
    checkouts: window.checkouts,
    sources: window.sources.slice(0, 5).map((r) => ({ source: r.name, visits: r.visits })),
    sales,
  };
}

export type Live = {
  /** People who opened the store's page in the last LIVE_MINUTES minutes, each once. */
  visitors: number;
  /** Where they came from. */
  sources: { source: string; visitors: number }[];
};

/**
 * Who opened the store in the last few minutes (added 11 October 2026),
 * each person once, under where they came from. Written by the store page's
 * own count — one command, inside what a visit is costed at — and not by a
 * product's page, whose count has no room for it (tests/traffic-cost.ts):
 * somebody who goes on from the store page to a product counts for five
 * minutes from the store page. Read when the studio asks, every half minute
 * while it is open; members older than half an hour are let go on each read,
 * and the set lapses a day after a day's first view. Nothing in it can be
 * turned back into a person: ten characters of a fingerprint that changes
 * every day.
 */
export async function readLive(store: Store, now = Date.now()): Promise<Live> {
  const empty: Live = { visitors: 0, sources: [] };
  if (!store.statsId || !isRedisConfigured()) return empty;
  const key = liveKey(store.statsId);
  const [, members] = await redisPipeline([
    ["ZREMRANGEBYSCORE", key, 0, now - 30 * 60_000],
    ["ZRANGEBYSCORE", key, now - LIVE_MINUTES * 60_000, "+inf", "WITHSCORES"],
  ]);
  const flat = Array.isArray(members) ? (members as unknown[]).map(String) : [];
  const latest = new Map<string, { source: string; at: number }>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [who, source] = flat[i].split("|");
    const at = Number(flat[i + 1]) || 0;
    if (!who) continue;
    const seen = latest.get(who);
    if (!seen || at >= seen.at) latest.set(who, { source: source || "direct", at });
  }
  const by = new Map<string, number>();
  for (const v of latest.values()) by.set(v.source, (by.get(v.source) ?? 0) + 1);
  return {
    visitors: latest.size,
    sources: [...by.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([source, visitors]) => ({ source, visitors })),
  };
}

export type DayStats = { date: string; views: number; visitors: number; checkouts: number };

export type Ranked = { name: string; visits: number }[];

/** What happened over one stretch of days. */
export type WindowStats = {
  /** People, over the whole window — not the sum of the days. */
  visitors: number;
  views: number;
  checkouts: number;
  sources: Ranked;
  mediums: Ranked;
  campaigns: Ranked;
  checkoutsByProduct: Record<string, number>;
  /** Times each product's own page was opened. */
  viewsByProduct: Record<string, number>;
  linkClicks: Record<string, number>;
  /** Page views by country (two letters) and by kind of device; kept by the day only. */
  countries: Ranked;
  devices: Ranked;
  /** Checkouts started, and free products' addresses asked for, by channel (lib/visit-channel.ts). */
  checkoutsBySource: Ranked;
  freeBySource: Ranked;
  /** Measured visits of the store's page, by furthest item and item clicked (lib/page-read.ts); the field without "sr:". */
  reach: Record<string, number>;
  /** Buyers' answers to "where did you hear about us?" (lib/heard.ts), and the money of the sales each was given for. */
  heard: Record<string, Heard>;
  /** Searches of the store that found nothing, by the words searched for (countSearchMiss). */
  searchMisses: Ranked;
};

export type Windows = { d7: WindowStats; d30: WindowStats; d90: WindowStats };

/** The same stretch of days just before a window: what it is compared with (added 11 October 2026). */
export type PreviousWindow = { visitors: number; views: number; checkouts: number };

export type Stats = {
  /** The last STATS_DAYS days, oldest first. */
  days: DayStats[];
  windows: Windows;
  /** The 7, 30 and 90 days before each window, for "up 20% on the 30 days before". */
  previous: { d7: PreviousWindow; d30: PreviousWindow; d90: PreviousWindow };
  /** Source-read coverage before legacy numeric placeholders, independent by window. */
  previousTrafficAvailable?: Record<"d7" | "d30" | "d90", boolean>;
  /** Everything since `since`, or null when it could not be read. */
  life: (WindowStats & { since: string }) | null;
};

const ranked = (map: Map<string, number>): Ranked =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SOURCES)
    .map(([name, visits]) => ({ name, visits }));

/** Adds one day's (or one record's) fields into running totals. */
class Tally {
  views = 0;
  checkouts = 0;
  sources = new Map<string, number>();
  mediums = new Map<string, number>();
  campaigns = new Map<string, number>();
  checkoutsByProduct: Record<string, number> = {};
  viewsByProduct: Record<string, number> = {};
  linkClicks: Record<string, number> = {};
  countries = new Map<string, number>();
  devices = new Map<string, number>();
  checkoutsBySource = new Map<string, number>();
  freeBySource = new Map<string, number>();
  reach: Record<string, number> = {};
  heard: Record<string, Heard> = {};
  searchMisses = new Map<string, number>();

  add(field: string, count: number) {
    if (field === "v") this.views += count;
    else if (field === "c") this.checkouts += count;
    else if (field.startsWith("r:")) this.sources.set(field.slice(2), (this.sources.get(field.slice(2)) ?? 0) + count);
    else if (field.startsWith("m:")) this.mediums.set(field.slice(2), (this.mediums.get(field.slice(2)) ?? 0) + count);
    else if (field.startsWith("g:")) this.campaigns.set(field.slice(2), (this.campaigns.get(field.slice(2)) ?? 0) + count);
    else if (field.startsWith("c:")) this.checkoutsByProduct[field.slice(2)] = (this.checkoutsByProduct[field.slice(2)] ?? 0) + count;
    else if (field.startsWith("pv:")) this.viewsByProduct[field.slice(3)] = (this.viewsByProduct[field.slice(3)] ?? 0) + count;
    else if (field.startsWith("l:")) this.linkClicks[field.slice(2)] = (this.linkClicks[field.slice(2)] ?? 0) + count;
    else if (field.startsWith("k:")) this.countries.set(field.slice(2), (this.countries.get(field.slice(2)) ?? 0) + count);
    else if (field.startsWith("d:")) this.devices.set(field.slice(2), (this.devices.get(field.slice(2)) ?? 0) + count);
    else if (field.startsWith("cs:")) this.checkoutsBySource.set(field.slice(3), (this.checkoutsBySource.get(field.slice(3)) ?? 0) + count);
    else if (field.startsWith("fs:")) this.freeBySource.set(field.slice(3), (this.freeBySource.get(field.slice(3)) ?? 0) + count);
    else if (field.startsWith("sr:")) this.reach[field.slice(3)] = (this.reach[field.slice(3)] ?? 0) + count;
    else if (field.startsWith("h:")) (this.heard[field.slice(2)] ??= { buyers: 0, cents: 0 }).buyers += count;
    else if (field.startsWith("hc:")) (this.heard[field.slice(3)] ??= { buyers: 0, cents: 0 }).cents += count;
    else if (field.startsWith("hu:")) {
      const h = (this.heard[field.slice(3)] ??= { buyers: 0, cents: 0 });
      h.unknownBuyers = (h.unknownBuyers ?? 0) + count;
    } else if (field.startsWith("huc:")) {
      const h = (this.heard[field.slice(4)] ??= { buyers: 0, cents: 0 });
      h.unknownCents = (h.unknownCents ?? 0) + count;
    }
    else if (field.startsWith("q:")) this.searchMisses.set(field.slice(2), (this.searchMisses.get(field.slice(2)) ?? 0) + count);
  }

  window(visitors: number): WindowStats {
    return {
      visitors,
      views: this.views,
      checkouts: this.checkouts,
      sources: ranked(this.sources),
      mediums: ranked(this.mediums),
      campaigns: ranked(this.campaigns),
      checkoutsByProduct: this.checkoutsByProduct,
      viewsByProduct: this.viewsByProduct,
      linkClicks: this.linkClicks,
      countries: ranked(this.countries),
      devices: ranked(this.devices),
      checkoutsBySource: ranked(this.checkoutsBySource),
      freeBySource: ranked(this.freeBySource),
      reach: this.reach,
      heard: this.heard,
      searchMisses: ranked(this.searchMisses),
    };
  }
}

function pairs(reply: unknown): [string, number][] {
  const flat = Array.isArray(reply) ? (reply as unknown[]).map(String) : [];
  const out: [string, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1]) || 0]);
  return out;
}

/**
 * A day's HGETALL read exactly, for the all-time fill: field and count strings, an even number of them ([] for a day
 * with nothing kept), each count a whole number. Anything else throws (CX-123 rule 24).
 */
function exactPairs(reply: unknown): [string, number][] {
  const flat = stringList(reply);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("a kept day's counts");
  const out: [string, number][] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const count = /^-?\d{1,15}$/.test(flat[i + 1]) ? Number(flat[i + 1]) : NaN;
    if (!Number.isSafeInteger(count)) throw new UnknownReplyError("a kept day's counts");
    out.push([flat[i], count]);
  }
  return out;
}

/** The dates of the last `count` days, oldest first, ending today (UTC). */
function lastDays(now: number, count: number): string[] {
  const dates: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) dates.push(dayKey(now - i * 86400_000));
  return dates;
}

/** The last STATS_DAYS days of a store, and its all-time record. */
export async function readStats(store: Store, now = Date.now()): Promise<Stats | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const statsId = store.statsId;
  const dates = lastDays(now, STATS_DAYS);

  // The 90 days before these, for the comparison: only their views and
  // checkouts, and their people over the whole stretch (one command).
  const older = lastDays(now - STATS_DAYS * 86400_000, STATS_DAYS);
  const commands: (string | number)[][] = [
    ...dates.map((d) => ["HGETALL", countsKey(statsId, d)]),
    ...dates.map((d) => ["PFCOUNT", visitorsKey(statsId, d)]),
    ["PFCOUNT", ...dates.slice(-7).map((d) => visitorsKey(statsId, d))],
    ["PFCOUNT", ...dates.slice(-30).map((d) => visitorsKey(statsId, d))],
    ["PFCOUNT", ...dates.map((d) => visitorsKey(statsId, d))],
    ["PFCOUNT", ...dates.slice(-14, -7).map((d) => visitorsKey(statsId, d))],
    ["PFCOUNT", ...dates.slice(-60, -30).map((d) => visitorsKey(statsId, d))],
    ["PFCOUNT", ...older.map((d) => visitorsKey(statsId, d))],
    ...older.map((d) => ["HMGET", countsKey(statsId, d), "v", "c"]),
  ];
  const results = await redisPipeline(commands);
  const traffic = statsTrafficCoverage(results);
  if (!traffic.current) return null;

  const days: DayStats[] = [];
  const tallies = { d7: new Tally(), d30: new Tally(), d90: new Tally() };
  dates.forEach((date, index) => {
    const age = dates.length - 1 - index;
    let views = 0;
    let checkouts = 0;
    for (const [field, count] of pairs(results[index])) {
      if (field === "v") views = count;
      else if (field === "c") checkouts = count;
      tallies.d90.add(field, count);
      if (age < 30) tallies.d30.add(field, count);
      if (age < 7) tallies.d7.add(field, count);
    }
    days.push({ date, views, visitors: Number(results[dates.length + index]) || 0, checkouts });
  });
  const base = dates.length * 2;
  const windows: Windows = {
    d7: tallies.d7.window(Number(results[base]) || 0),
    d30: tallies.d30.window(Number(results[base + 1]) || 0),
    d90: tallies.d90.window(Number(results[base + 2]) || 0),
  };
  // The stretch before each window: days 8 to 14 ago, 31 to 60, and 91 to 180.
  const sum = (list: DayStats[]) => list.reduce((t, d) => ({ views: t.views + d.views, checkouts: t.checkouts + d.checkouts }), { views: 0, checkouts: 0 });
  const olderTotals = { views: 0, checkouts: 0 };
  older.forEach((_, i) => {
    const reply = results[base + 6 + i];
    if (!Array.isArray(reply)) return;
    olderTotals.views += Number(reply[0]) || 0;
    olderTotals.checkouts += Number(reply[1]) || 0;
  });
  const previous = {
    d7: { visitors: Number(results[base + 3]) || 0, ...sum(days.slice(-14, -7)) },
    d30: { visitors: Number(results[base + 4]) || 0, ...sum(days.slice(-60, -30)) },
    d90: { visitors: Number(results[base + 5]) || 0, ...olderTotals },
  };
  const life = await readLife(store, now).catch((error) => {
    console.error("reading all-time counts failed", error);
    return null;
  });
  return { days, windows, previous, previousTrafficAvailable: traffic.previous, life };
}

/**
 * Page loads that arrived wearing each of these campaign tags, over the last
 * `days` days, today included: what an email's links brought to the store
 * (lib/mail-links.ts), or one subject line's share of them (lib/mail-test.ts).
 *
 * Read from the days themselves, a few fields of each, rather than from the
 * all-time record: that one lets its smallest tags go once it is full, and an
 * email nobody clicked much is exactly the one whose count has to be right.
 * A load, not a person: somebody who opens the link twice is counted twice.
 * Null when it could not be read at all, which is not the same as none.
 */
export async function campaignViews(
  statsId: string | null,
  campaigns: string[],
  days = STATS_DAYS,
  now = Date.now(),
): Promise<Record<string, number> | null> {
  if (!statsId || !isRedisConfigured()) return null;
  const tags = [...new Set(campaigns.map(cleanTag).filter(Boolean))];
  const out: Record<string, number> = Object.fromEntries(tags.map((tag) => [tag, 0]));
  if (!tags.length) return out;
  const dates = lastDays(now, Math.max(1, Math.min(Math.floor(days), KEPT_DAYS)));
  const replies = await redisPipeline(dates.map((date) => ["HMGET", countsKey(statsId, date), ...tags.map((tag) => `g:${tag}`)]));
  for (const reply of replies) {
    if (!Array.isArray(reply)) continue;
    reply.forEach((count, i) => {
      if (i < tags.length) out[tags[i]] += Number(count) || 0;
    });
  }
  return out;
}

/** Fields the all-time record keeps for itself rather than as counts. */
const LIFE_OWN = new Set(["started", "since", "filled", "u", "v", "vgap"]);
/** Beyond this many fields, the smallest sources and tags are let go. */
const LIFE_MAX_FIELDS = 2000;
const LIFE_KEEP_PER_KIND = 300;

/**
 * The all-time record's HGETALL read exactly (CX-123 rule 24): its field and value strings, an even number of them
 * ([] for a record not there yet), or it throws. A loose read took any other answer for an empty record, so one
 * already filled was filled again and every count it holds was doubled (review of #2905).
 */
async function readLifeFlat(life: string): Promise<string[]> {
  const [raw] = repliesFor(await redisPipeline([["HGETALL", life]]), 1) ?? [undefined];
  const flat = stringList(raw);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("the all-time record");
  return flat;
}

/** Fields the all-time record keeps as dates, not counts. */
const LIFE_DATES = new Set(["started", "since", "filled"]);

/**
 * The all-time record's fields as counts, read exactly (CX-123 rule 24): every count a whole number, or it throws.
 * Its dates stay in the map as 0, as they did, so the record's size still counts them. A loose read took a count in
 * any other shape for 0, so the studio lost those views and the path showed zeros where it keeps the last reading.
 */
function lifeCounts(flat: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2) {
    const count = LIFE_DATES.has(flat[i]) ? 0 : /^\d{1,15}$/.test(flat[i + 1]) ? Number(flat[i + 1]) : NaN;
    if (!Number.isSafeInteger(count)) throw new UnknownReplyError("the all-time record's counts");
    out.set(flat[i], count);
  }
  return out;
}

/**
 * The store's all-time record. The first time it is read it is filled from
 * the days still kept from before it started counting — once, under a lock,
 * and marked so it never happens twice.
 */
async function readLife(store: Store, now: number): Promise<(WindowStats & { since: string }) | null> {
  const statsId = store.statsId as string;
  const life = lifeKey(statsId);
  let flat = await readLifeFlat(life);
  let fields = lifeCounts(flat);
  const text = (name: string) => {
    const at = flat.indexOf(name);
    return at >= 0 && at % 2 === 0 ? flat[at + 1] : "";
  };

  if (!text("filled")) {
    // The fill lock read exactly (lib/claim-mark.ts; CX-123 rule 24): another read's means that read fills it. An
    // unknown one fills nothing and is let go only while it holds this read's value; the throw leaves the all-time
    // record unread this time (readStats), never filled twice.
    const mine = claimValue();
    const claimed = await claimMark(lifeLockKey(statsId), 60, mine);
    if (claimed === "unknown") {
      await releaseMark(lifeLockKey(statsId), mine);
      throw new UnknownReplyError("the all-time record's fill lock");
    }
    if (claimed === "ours") {
      const today = dayKey(now);
      const started = /^\d{4}-\d{2}-\d{2}$/.test(text("started")) ? text("started") : today;
      const created = /^\d{4}-\d{2}-\d{2}/.test(store.createdAt) ? store.createdAt.slice(0, 10) : "";
      const earliest = dayKey(now - (KEPT_DAYS - 1) * 86400_000);
      const from = created && created > earliest ? created : earliest;
      const dates = lastDays(now, KEPT_DAYS).filter((d) => d >= from && d < started);
      const tally = new Map<string, number>();
      let visitors = 0;
      let first = "";
      if (dates.length) {
        // The kept days read exactly (CX-123 rule 24; review of #2905): the fill happens once, so a day read as empty
        // from an answer in another shape would be gone from the all-time record for good. Any such answer marks
        // nothing filled, lets this read's lock go and throws, so this view has no all-time record (readStats) and
        // the next read fills it once.
        let days: [string, number][][];
        let counts: number[];
        try {
          const replies = repliesFor(await redisPipeline([
            ...dates.map((d) => ["HGETALL", countsKey(statsId, d)]),
            ...dates.map((d) => ["PFCOUNT", visitorsKey(statsId, d)]),
          ]), 2 * dates.length);
          if (!replies) throw new UnknownReplyError("the all-time record's kept days");
          days = dates.map((_, i) => exactPairs(replies[i]));
          counts = dates.map((_, i) => countOf(replies[dates.length + i]) ?? -1);
          if (counts.some((n) => n < 0)) throw new UnknownReplyError("the all-time record's kept visitors");
        } catch (error) {
          await releaseMark(lifeLockKey(statsId), mine);
          throw error;
        }
        dates.forEach((date, i) => {
          const day = days[i];
          if (day.length && !first) first = date;
          // Countries and devices are kept by the day only: copied into the
          // all-time record they would start it on whatever day it was filled.
          for (const [field, count] of day) {
            if (field.startsWith("k:") || field.startsWith("d:") || field.startsWith("sr:") || field.startsWith("h:") || field.startsWith("hc:") || field.startsWith("q:")) continue;
            tally.set(field, (tally.get(field) ?? 0) + count);
          }
          visitors += counts[i];
        });
      }
      await redisPipeline([
        ...[...tally.entries()].map(([field, count]) => ["HINCRBY", life, field, count]),
        ...(visitors ? [["HINCRBY", life, "u", visitors]] : []),
        ["HSET", life, "since", first || started, "filled", today],
        ["HSETNX", life, "started", started],
      ]);
      // Let go only while it holds this read's value: a fill that outlasted its 60 seconds never frees another's.
      await releaseMark(lifeLockKey(statsId), mine);
      flat = await readLifeFlat(life);
      fields = lifeCounts(flat);
    }
  }

  // All-time views are the sum of the all-time sources, since every view adds
  // one to exactly one of them (recordHit), plus "vgap": the views whose
  // sources were let go below, and, once, whatever a record from before
  // 11 October 2026 counted in "v" beyond its sources.
  const sumOfSources = () => [...fields.entries()].reduce((n, [f, c]) => (f.startsWith("r:") ? n + c : n), 0);
  if (!fields.has("vgap")) {
    const gap = Math.max(0, (fields.get("v") ?? 0) - sumOfSources());
    await redisPipeline([["HSETNX", life, "vgap", gap]]);
    fields.set("vgap", gap);
  }

  // A record that has gathered too many one-off sources lets the smallest go.
  if (fields.size > LIFE_MAX_FIELDS) {
    const drop: string[] = [];
    let droppedViews = 0;
    for (const prefix of ["r:", "m:", "g:", "cs:", "fs:"]) {
      const kind = [...fields.entries()].filter(([f]) => f.startsWith(prefix)).sort((a, b) => b[1] - a[1]);
      for (const [f, c] of kind.slice(LIFE_KEEP_PER_KIND)) {
        drop.push(f);
        if (prefix === "r:") droppedViews += c;
      }
    }
    if (drop.length) {
      await redisPipeline([["HDEL", life, ...drop], ...(droppedViews ? [["HINCRBY", life, "vgap", droppedViews]] : [])]);
      for (const f of drop) fields.delete(f);
      fields.set("vgap", (fields.get("vgap") ?? 0) + droppedViews);
    }
  }

  const tally = new Tally();
  for (const [field, count] of fields) if (!LIFE_OWN.has(field)) tally.add(field, count);
  const since = text("since") || text("started") || dayKey(now);
  return { ...tally.window(fields.get("u") ?? 0), views: sumOfSources() + (fields.get("vgap") ?? 0), since };
}

// ---- Sales, from the creator's Stripe -----------------------------------------

type SalesWindow = { sales: number; cents: number };

export type SalesStats = {
  /** Existing paid-record subsets only; no additional provider reads. */
  levers?: LeverReading;
  /** Paid checkouts per day, same days as the visits. */
  byDay: Record<string, SalesWindow>;
  byProduct: Record<string, { d7: SalesWindow; d30: SalesWindow; d90: SalesWindow }>;
  totals: { d7: SalesWindow; d30: SalesWindow; d90: SalesWindow };
  /** True when there were more sales than one reading covers. */
  partial: boolean;
  /**
   * Sales in another currency than the store's, from before it changed:
   * counted here and left out of every total above, because euros added to
   * dollars make a number that means nothing. They are in the CSV.
   */
  elsewhere: number;
  /**
   * What each of the creator's own links brought in, over the same 90 days,
   * biggest first (lib/came-from.ts). Only the store's own currency, for the
   * reason above. "direct" is every sale that carried no tag.
   */
  bySource: { source: string; currency: string; cents: number; sales: number }[];
  /**
   * The payments after the first (added 11 October 2026): memberships renewed
   * and the later payments of payment plans, read from the paid invoices of
   * this store's subscriptions. A first payment is a checkout and is in the
   * sales above, so it is never counted twice. Absent on a reading from before.
   */
  renewals?: { d7: Renewals; d30: Renewals; d90: Renewals; partial: boolean; bySource?: RenewalsBySource; bySourceDay?: ChannelDays };
  /** What each channel brought in, credited to the buyer's FIRST visit from somewhere (lib/visit-channel.ts). */
  firstBySource?: { source: string; currency: string; cents: number; sales: number }[];
  /**
   * For each window, the same sales by the last visit and by the first, side
   * by side (lib/attribution-rules.ts): checkouts only, in the store's
   * currency, so the two columns add up to the same money.
   */
  attributionIn?: Record<"d7" | "d30" | "d90", { last: { source: string; cents: number; sales: number }[]; first: { source: string; cents: number; sales: number }[] }>;
  /** Money by campaign — one post, when its link was made for it — for each window, in the store's currency. */
  byCampaignIn?: Record<"d7" | "d30" | "d90", { campaign: string; source: string; sources?: string[]; cents: number; sales: number }[]>;
  /** bySource for each window, so a channel's sales sit beside its visits for the same days. */
  bySourceIn?: Record<"d7" | "d30" | "d90", { source: string; currency: string; cents: number; sales: number }[]>;
  /**
   * Sales in the stretch just before each window (added 11 October 2026):
   * days 8 to 14 ago, 31 to 60, 91 to 180. Null for a stretch the reading did
   * not reach all of, because a part of it compared with a whole says nothing.
   */
  previous?: { d7: SalesWindow | null; d30: SalesWindow | null; d90: SalesWindow | null };
  /** Money by the ad each sale came from (utm_content), for each window. */
  byContentIn?: Record<"d7" | "d30" | "d90", { content: string; source: string; campaign: string; cents: number; sales: number }[]>;
  /** Money by the buyer's country, for each window. */
  byCountryIn?: Record<"d7" | "d30" | "d90", { country: string; cents: number; sales: number }[]>;
  /**
   * The tax Stripe added at checkout, by the buyer's region, each currency on
   * its own (lib/tax-summary.ts; 601 [KB22] U4, added 6 November 2026). From
   * the sales above, with no read of its own. Absent on a reading from before.
   */
  taxIn?: TaxSummary;
  /** Refunds made in each window, by the channel of the sale refunded; "" is direct, UNRECORDED a payment not among the sales read. */
  refundsIn?: Record<"d7" | "d30" | "d90", { source: string; refunds: number; cents: number }[]>;
  /** Refunds by product over the 90 days. */
  refundsByProduct?: Record<string, { refunds: number; cents: number }>;
  /**
   * Refunds and disputes of the last 90 days in a currency other than the
   * store's (from before it changed its currency), left out of every amount
   * above as sales in another one are, and counted here so the page can say
   * so (22 [E5], unit 2b). A count is null when that list could not be read.
   */
  takenBackElsewhere?: { refunds: number | null; disputes: number | null };
  /**
   * Disputes opened in each window that the bank holds or the buyer won, by
   * the channel of the sale disputed (added 18 October 2026); null when they
   * could not be read. "unrecorded" is a payment not among the sales read.
   */
  disputesIn?: Record<"d7" | "d30" | "d90", { source: string; disputes: number; cents: number }[]> | null;
  /** Every dispute page was read; true with no Stripe account, where there is none to read. */
  disputesComplete?: boolean;
  /**
   * What each currency kept in each window: sales and renewals in, refunds
   * and disputes out, never converted or added across currencies
   * (lib/retained-revenue.ts). Added 18 October 2026.
   */
  keptIn?: Record<"d7" | "d30" | "d90", KeptWindow>;
  /** The store sells through PayPal too, whose disputes are not read. */
  paypalDisputesUnread?: boolean;
  /**
   * The money each channel brought on each of the 90 days, first sales and
   * renewals together, in the store's currency (added 11 October 2026): what
   * says on which day a channel's ads had paid for themselves
   * (lib/ad-spend-rules.ts, paybackOf). Days with nothing are left out.
   */
  channelDays?: ChannelDays;
  /** Refund amounts on the UTC day recorded; null means no complete ledger was read. */
  refundDays?: Record<string, number> | null;
  /** Who bought, for each window, and the biggest buyers of the 90 days (buyersFrom; added 12 October 2026). */
  buyers?: BuyerNumbers;
  buyerChannels?: BuyerChannels;
  /** All receipts, renewals and refunds were read, and each refund was matched to this store. */
  cashflowComplete?: boolean;
  /** Purchases and renewals were read in full for the current 90-day ledger, independently of refunds. */
  paymentsComplete?: boolean;
  /** Full price beside each kind of discount over the 90 days (lib/discount-impact.ts); null with no discounted sale. */
  discounts?: { rows: DiscountRow[] | null; refundsRead: boolean };
  /** When buyers bought over the 90 days: checkouts by hour of the week in UTC, Sunday 0:00 first (hoursOfWeek). */
  hours?: { sales: number[]; cents: number[] };
};

/**
 * Buyers in one window (added 12 October 2026), in the store's currency:
 * how many people bought, how many orders they placed and what those came
 * to, how many had bought before the window began (in the 180 days of
 * sales read), and how many bought more than once inside it. A support
 * payment ("Support my work") is not an order and is left out.
 */
export type BuyersWindow = { buyers: number; orders: number; cents: number; returning: number; repeat: number };
/** One of the biggest buyers: what they spent in the 90 days, and the latest sale that opens their page (lib/buyer-profile.ts). */
export type TopBuyer = { email: string; cents: number; orders: number; last: number; reference: string };
export type BuyerNumbers = { d7: BuyersWindow; d30: BuyersWindow; d90: BuyersWindow; top: TopBuyer[] };

/** How many of the biggest buyers are kept. */
export const TOP_BUYERS = 10;

/** The address a sale was paid with: the checkout's, or a one-click payment's receipt; "" when none. */
function buyerOf(sale: Sale): string {
  const details = sale.row.customer_details as { email?: unknown } | null | undefined;
  const raw = sale.upsell ? sale.row.receipt_email : details?.email;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * Who bought, worked out from the sales read (pure, so a test can hand it
 * sales). `sales` are every sale read, the 180 days; only the store's
 * currency counts. An extra taken in one click after a checkout adds to its
 * buyer's money and is not an order of its own.
 */
export function buyersFrom(sales: Sale[], currency: string, now: number): BuyerNumbers {
  const cuts = { d7: dayKey(now - 6 * 86400_000), d30: dayKey(now - 29 * 86400_000), d90: dayKey(now - (STATS_DAYS - 1) * 86400_000) };
  const own = sales.filter((sale) => sale.currency === currency && (sale.row.metadata as Record<string, string> | null | undefined)?.kind !== "tip");
  // When each address first bought, as far back as the reading goes.
  const first = new Map<string, number>();
  for (const sale of own) {
    const who = buyerOf(sale);
    if (who && (!first.has(who) || sale.created < (first.get(who) as number))) first.set(who, sale.created);
  }
  const window = (cut: string): { stats: BuyersWindow; people: Map<string, TopBuyer> } => {
    const people = new Map<string, TopBuyer>();
    const stats: BuyersWindow = { buyers: 0, orders: 0, cents: 0, returning: 0, repeat: 0 };
    for (const sale of own) {
      if (dayKey(sale.created) < cut) continue;
      stats.cents += sale.cents;
      if (!sale.upsell) stats.orders += 1;
      const who = buyerOf(sale);
      if (!who) continue;
      const row = people.get(who) ?? { email: who, cents: 0, orders: 0, last: 0, reference: "" };
      row.cents += sale.cents;
      if (!sale.upsell) row.orders += 1;
      if (sale.created > row.last) {
        row.last = sale.created;
        row.reference = typeof sale.row.id === "string" ? sale.row.id : row.reference;
      }
      people.set(who, row);
    }
    const startsAt = Date.parse(`${cut}T00:00:00Z`);
    stats.buyers = people.size;
    for (const [who, row] of people) {
      if ((first.get(who) ?? Infinity) < startsAt) stats.returning += 1;
      if (row.orders > 1) stats.repeat += 1;
    }
    return { stats, people };
  };
  const d90 = window(cuts.d90);
  const top = [...d90.people.values()]
    .filter((row) => row.reference)
    .sort((a, b) => b.cents - a.cents || b.orders - a.orders || b.last - a.last)
    .slice(0, TOP_BUYERS);
  return { d7: window(cuts.d7).stats, d30: window(cuts.d30).stats, d90: d90.stats, top };
}

/** Channel → day → money, in the smallest unit; "direct" for none named. */
export type ChannelDays = Record<string, Record<string, number>>;

/** Payments after the first, and what they came to, in the store's currency. */
export type Renewals = { payments: number; cents: number };

/** Renewals over the last 90 days by the channel the subscription was sold through; "" is direct. */
export type RenewalsBySource = ({ source: string } & Renewals)[];

/** The channel of a subscription sold before channels were written onto subscriptions. */
export const UNRECORDED = "unrecorded";

export type AllTimeSales = {
  totals: SalesWindow;
  byProduct: Record<string, SalesWindow>;
  /** The first sale read, as a date; empty when none. */
  since: string;
  partial: boolean;
  /** What the totals are in: the store's currency when they were read. */
  currency: string;
  /** Sales in another currency, left out of the totals. */
  elsewhere: number;
  /** What the buyers of each product also bought (lib/also-bought.ts); absent on a reading from before it. */
  together?: Together;
};

type Row = {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  created?: unknown;
  metadata?: Record<string, string> | null;
};

/**
 * One paid sale as read from Stripe: a checkout, or a one-click extra after
 * one, with the amount in the smallest unit of the currency it was paid in.
 */
export type Sale = {
  created: number;
  product: string;
  cents: number;
  currency: string;
  row: Record<string, unknown>;
  upsell: boolean;
  /**
   * The channel this sale is credited to, "" when it came from nowhere the
   * store could name: the utm_source on the page it was bought from
   * (lib/came-from.ts), else the channel remembered for the buyer's visit
   * (lib/visit-channel.ts), which sales from before 11 October 2026 lack.
   */
  source: string;
  medium: string;
  campaign: string;
  /** The channel of the buyer's first visit from somewhere, where it was remembered; else `source`. */
  first: string;
  /** The ad it came from: utm_content on the page or remembered (added 11 October 2026); empty when none. */
  content: string;
  /** The buyer's country as Stripe has it, two capital letters, or "" when Stripe did not collect one. */
  country: string;
  /** The payment Stripe made for it, which a refund names. */
  paymentIntent: string;
};

/** The channel a checkout's metadata credits, "" for direct (lib/visit-channel.ts). */
export function saleChannel(meta: Record<string, string>): { source: string; medium: string; campaign: string; first: string; content: string } {
  const named = (value: string | undefined) => (value && value !== "direct" ? value : "");
  const source = meta.utm_source || named(meta.channel);
  return {
    source,
    medium: meta.utm_medium || meta.channel_medium || "",
    campaign: meta.utm_campaign || meta.channel_campaign || "",
    first: named(meta.channel_first) || source,
    content: meta.utm_content || meta.channel_content || "",
  };
}

/** Whether a store has sales to read: a Stripe account connected, or PayPal (lib/paypal-sales.ts). */
export function readsSales(store: Pick<Store, "stripeAccountId" | "paypalSeller">): boolean {
  return Boolean(store.stripeAccountId || store.paypalSeller);
}

/**
 * A PayPal sale as a Stripe one is read everywhere here: a row shaped like a
 * paid Checkout Session, with the channel, the affiliate and the store sale
 * the order carried in its metadata, and `paid_with: "paypal"`. Pure.
 */
export function payPalSale(paid: Paid): Sale {
  const meta: Record<string, string> = {
    store: paid.handle ?? "",
    product: paid.product,
    ...(paid.meta ?? {}),
    ...(paid.via ? { via: paid.via.aff, via_rate: String(paid.via.rate) } : {}),
    ...(paid.sale ? { sale: String(paid.sale) } : {}),
    paid_with: "paypal",
  };
  const row: Record<string, unknown> = {
    id: `paypal:${paid.order}`,
    object: "paypal.order",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: paid.cents,
    currency: paid.currency,
    created: paid.at,
    customer_details: { email: paid.email, name: null },
    total_details: { amount_discount: paid.off ?? 0, amount_tax: 0 },
    payment_intent: paypalPaymentId(paid.capture),
    metadata: meta,
  };
  return {
    created: paid.at * 1000,
    product: paid.product,
    cents: paid.cents,
    currency: paid.currency,
    row,
    upsell: false,
    ...saleChannel(meta),
    country: "",
    paymentIntent: paypalPaymentId(paid.capture),
  };
}

/**
 * The currency Stripe reports on a checkout, a payment, an invoice, a refund
 * or a dispute, as its three-letter code in lower case; "" when the answer
 * names none or something that is not a code (rule 24). An unknown currency
 * is never taken for US dollars nor for "another currency": a row with "" is
 * left out of every amount and its reading is marked incomplete.
 */
const currencyOf = (row: { currency?: unknown }) => (typeof row.currency === "string" && /^[a-z]{3}$/i.test(row.currency) ? row.currency.toLowerCase() : "");

/**
 * Every paid sale of this store since `since` (seconds), newest first, read
 * from the creator's own Stripe account: checkouts this store opened that
 * were paid, and the one-click extras taken after them. At most `pages`
 * pages of a hundred of each are read; `partial` says when there were more.
 * Amounts are what the buyer paid, after any discount code and before
 * Stripe's fee or any refund, each in the currency it was paid in.
 */
/** A financial page completes only with explicit valid pagination and distinct records. */
function financialPage(list: { data?: unknown; has_more?: unknown }, seen: Set<string>): Record<string, unknown>[] {
  // Invalid pages and stalled cursors are failed readings, never confirmed zero.
  if (!list || !Array.isArray(list.data) || typeof list.has_more !== "boolean") {
    throw new Error("Invalid financial page");
  }
  const rows = list.data as Record<string, unknown>[];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !row.id || seen.has(row.id)) {
      throw new Error("Invalid or repeated financial record");
    }
    seen.add(row.id);
  }
  if (list.has_more && rows.length === 0) throw new Error("Paid-sales pagination has no next cursor");
  return rows;
}

export async function readPaidSales(store: Store, since: number, pages: number): Promise<{ sales: Sale[]; partial: boolean }> {
  if (!readsSales(store)) return { sales: [], partial: false };
  const handles = saleHandles(store);
  const sales: Sale[] = [];
  let partial = false;
  // Sales paid with PayPal, written down as each was paid (lib/paypal-sales.ts): counted beside Stripe's.
  const paypal = await readPayPalSales(store.statsId, since, pages * 100).catch((error) => {
    console.error("reading PayPal sales failed", error);
    return { sales: [], partial: true };
  });
  for (const paid of paypal.sales) sales.push(payPalSale(paid));
  if (paypal.partial) partial = true;
  if (!store.stripeAccountId) {
    sales.sort((a, b) => b.created - a.created);
    return { sales, partial };
  }
  const walk = async (path: string, take: (row: Record<string, unknown>) => void) => {
    let after = "";
    const seen = new Set<string>();
    for (let page = 0; page < pages; page += 1) {
      const list = (await onAccount(
        "GET",
        store.stripeAccountId as string,
        `${path}${since > 0 ? `&created[gte]=${since}` : ""}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
      )) as { data?: unknown; has_more?: unknown };
      const rows = financialPage(list, seen);
      rows.forEach(take);
      if (!list.has_more) return;
      after = rows[rows.length - 1].id as string;
      if (page === pages - 1) partial = true;
    }
  };
  // The two lists are read side by side, so a whole store's sales wait on the longer of them, not both (lib/store-export.ts).
  const checkouts = walk("/checkout/sessions?limit=100", (raw) => {
    const row = raw as Row;
    const meta = row.metadata ?? {};
    if (!handles.has(meta.store ?? "")) return;
    if (row.status !== "complete" || row.payment_status !== "paid") return;
    const details = (raw.customer_details ?? {}) as { address?: { country?: unknown } | null };
    const country = typeof details.address?.country === "string" && /^[A-Z]{2}$/.test(details.address.country) ? details.address.country : "";
    const currency = currencyOf(row);
    // A sale in a currency the answer does not name cannot be counted anywhere: the reading is incomplete.
    if (!currency) partial = true;
    sales.push({
      created: typeof row.created === "number" ? row.created * 1000 : Date.now(),
      product: meta.product ?? "",
      cents: typeof row.amount_total === "number" ? row.amount_total : 0,
      currency,
      row: raw,
      upsell: false,
      ...saleChannel(meta),
      country,
      paymentIntent: typeof raw.payment_intent === "string" ? raw.payment_intent : "",
    });
  });
  // Products taken in one click after paying are charges of their own.
  const extras = walk("/payment_intents?limit=100", (pi) => {
    const meta = (pi.metadata ?? {}) as Record<string, string>;
    if (meta.kind !== "upsell" || !handles.has(meta.store ?? "") || pi.status !== "succeeded") return;
    if (!currencyOf(pi)) partial = true;
    sales.push({
      created: typeof pi.created === "number" ? pi.created * 1000 : Date.now(),
      product: meta.product ?? "",
      cents: typeof pi.amount === "number" ? pi.amount : 0,
      currency: currencyOf(pi),
      row: pi,
      upsell: true,
      // An upsell is taken in one click after a checkout that already has
      // its channel. It belongs to the same visit, and the sale it followed
      // carries the tag, so this is left blank rather than guessed at.
      source: "",
      medium: "",
      campaign: "",
      first: "",
      content: "",
      country: "",
      paymentIntent: typeof pi.id === "string" ? pi.id : "",
    });
  });
  await Promise.all([checkouts, extras]);
  sales.sort((a, b) => b.created - a.created);
  return { sales, partial };
}

/** The metadata of the subscription an invoice is for, where either of Stripe's API versions keeps it. */
function invoiceMeta(invoice: Record<string, unknown>): Record<string, string> {
  const older = (invoice.subscription_details as { metadata?: unknown } | null | undefined)?.metadata;
  const parent = invoice.parent as { subscription_details?: { metadata?: unknown } | null } | null | undefined;
  const newer = parent?.subscription_details?.metadata;
  const meta = (newer && typeof newer === "object" ? newer : older && typeof older === "object" ? older : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(meta).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * The payments after the first of this store's memberships and payment plans
 * since `since` (seconds): paid invoices Stripe made because a period came
 * round (billing_reason "subscription_cycle"), on subscriptions this store
 * opened. At most `pages` pages of a hundred. Pure on what it is handed, so a
 * test can give it invoices.
 */
export function renewalsFrom(
  store: Store,
  invoices: Record<string, unknown>[],
  now: number,
  currency: string,
): { d7: Renewals; d30: Renewals; d90: Renewals; bySource: RenewalsBySource; bySourceDay: ChannelDays } {
  const handles = saleHandles(store);
  const cut7 = dayKey(now - 6 * 86400_000);
  const cut30 = dayKey(now - 29 * 86400_000);
  const zero = (): Renewals => ({ payments: 0, cents: 0 });
  const out = { d7: zero(), d30: zero(), d90: zero() };
  const by = new Map<string, Renewals>();
  // A channel is a visitor's utm_source, so it can be "__proto__": added up with no prototype (tests/proto-keys.test.ts),
  // and handed on as an ordinary record of own keys, which a page can take.
  const bySourceDay: ChannelDays = Object.create(null);
  for (const invoice of invoices) {
    if (invoice.status !== "paid" || invoice.billing_reason !== "subscription_cycle") continue;
    const meta = invoiceMeta(invoice);
    if (!handles.has(meta.store ?? "")) continue;
    if (currencyOf(invoice) !== currency) continue;
    const cents = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
    if (cents <= 0) continue;
    const day = dayKey((typeof invoice.created === "number" ? invoice.created : 0) * 1000);
    const windows: ("d7" | "d30" | "d90")[] = ["d90", ...(day >= cut30 ? (["d30"] as const) : []), ...(day >= cut7 ? (["d7"] as const) : [])];
    for (const w of windows) {
      out[w].payments += 1;
      out[w].cents += cents;
    }
    // The channel the subscription was sold through, which every renewal
    // carries in its subscription's metadata (lib/visit-channel.ts). One sold
    // before channels were written down says nothing, and is kept apart as
    // UNRECORDED rather than counted as direct, which would be a guess.
    const source = "channel" in meta ? (meta.channel === "direct" ? "" : meta.channel) : meta.utm_source || UNRECORDED;
    const row = by.get(source) ?? zero();
    row.payments += 1;
    row.cents += cents;
    by.set(source, row);
    const days = (bySourceDay[source || "direct"] ??= {});
    days[day] = (days[day] ?? 0) + cents;
  }
  const bySource = [...by.entries()].map(([source, r]) => ({ source, ...r })).sort((a, b) => b.cents - a.cents || a.source.localeCompare(b.source));
  return { ...out, bySource, bySourceDay: { ...bySourceDay } };
}

/**
 * Each paid renewal of this store as one entry, in whatever currency it was
 * paid (lib/retained-revenue.ts): the same invoices renewalsFrom counts, but
 * not limited to the store's currency, so a line in another currency is
 * reconciled with its own renewals. Pure on what it is handed.
 */
export function renewalEntries(store: Store, invoices: Record<string, unknown>[]): Entry[] {
  const handles = saleHandles(store);
  const out: Entry[] = [];
  for (const invoice of invoices) {
    if (invoice.status !== "paid" || invoice.billing_reason !== "subscription_cycle") continue;
    const meta = invoiceMeta(invoice);
    if (!handles.has(meta.store ?? "")) continue;
    const cents = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
    if (cents <= 0) continue;
    const source = "channel" in meta ? (meta.channel === "direct" ? "" : meta.channel) : meta.utm_source || UNRECORDED;
    out.push({ day: dayKey((typeof invoice.created === "number" ? invoice.created : 0) * 1000), cents, currency: currencyOf(invoice), source });
  }
  return out;
}

async function readRenewals(store: Store, since: number, now: number, pages: number): Promise<SalesStats["renewals"] & { entries: Entry[] }> {
  const invoices: Record<string, unknown>[] = [];
  let after = "";
  const seen = new Set<string>();
  let partial = false;
  for (let page = 0; page < pages; page += 1) {
    const list = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/invoices?limit=100&status=paid&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    )) as { data?: unknown; has_more?: unknown };
    const rows = financialPage(list, seen);
    invoices.push(...rows);
    if (!list.has_more) break;
    const last = rows[rows.length - 1];
    after = typeof last.id === "string" ? last.id : "";
    if (!after) break;
    if (page === pages - 1) partial = true;
  }
  const entries = renewalEntries(store, invoices);
  // A renewal in a currency the answer does not name is in no total: the reading is incomplete.
  if (entries.some((entry) => !entry.currency)) partial = true;
  return { ...renewalsFrom(store, invoices, now, store.currency), partial, entries };
}

/** One paid renewal of this store's memberships and payment plans, for the buyer ledger (lib/segments.ts, 270 [GR1] unit 2). */
export type RenewalPayment = {
  email: string;
  created: number;
  cents: number;
  currency: string;
  /** The payment, when the invoice names it: on the invoice itself in older API versions, or among its payments when they come with it; empty otherwise, so a refund of it cannot be matched. */
  paymentIntent: string;
  /** The channel the subscription was sold through, by the same rule as renewalEntries: "" for direct, UNRECORDED when it says nothing. */
  channel: string;
  /** The invoice, to find its payment among the account's invoice payments when the invoice does not name it. */
  invoice: string;
};

/**
 * Each paid invoice's payment on the creator's account, invoice id to payment
 * intent, from Stripe's list of invoice payments (GET /v1/invoice_payments,
 * whose `invoice` filter is optional: "List all payments for an invoice",
 * read 2 November 2026), so a refund of a membership's or a payment plan's
 * payment can be matched whatever API version the account answers in. At
 * most `pages` pages of a hundred, stopping at `deadline`; `partial` when
 * there was more (270 [GR1], unit 3a).
 */
export async function readInvoicePayments(store: Store, since: number, pages: number, deadline = Infinity): Promise<{ byInvoice: Map<string, string[]>; partial: boolean }> {
  // Every paid payment of an invoice (one paid in parts has several); a paid one with no payment intent (a charge) is kept as "", a miss.
  const byInvoice = new Map<string, string[]>();
  let after = "";
  const seen = new Set<string>();
  let partial = false;
  for (let page = 0; page < pages; page += 1) {
    const list = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/invoice_payments?limit=100&status=paid&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    )) as { data?: unknown; has_more?: unknown };
    const rows = financialPage(list, seen);
    for (const row of rows) {
      const invoice = typeof row.invoice === "string" ? row.invoice : "";
      const intent = (row.payment as { payment_intent?: unknown } | null | undefined)?.payment_intent;
      if (row.status !== "paid" || !invoice) continue;
      byInvoice.set(invoice, [...(byInvoice.get(invoice) ?? []), typeof intent === "string" ? intent : ""]);
    }
    if (!list.has_more) break;
    const last = rows[rows.length - 1];
    after = typeof last.id === "string" ? last.id : "";
    if (!after) { partial = true; break; }
    if (page === pages - 1 || Date.now() > deadline) { partial = true; break; }
  }
  return { byInvoice, partial };
}

/**
 * The paid renewals of this store since `since` (seconds), each with the
 * buyer's address as the invoice has it: the same invoices renewalEntries
 * counts (paid, billing_reason "subscription_cycle", this store's handles),
 * at most `pages` pages of a hundred; `partial` when there were more.
 */
export async function readRenewalPayments(store: Store, since: number, pages: number, deadline = Infinity): Promise<{ rows: RenewalPayment[]; partial: boolean }> {
  const handles = saleHandles(store);
  const out: RenewalPayment[] = [];
  let after = "";
  const seen = new Set<string>();
  let partial = false;
  for (let page = 0; page < pages; page += 1) {
    const list = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/invoices?limit=100&status=paid&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    )) as { data?: unknown; has_more?: unknown };
    const rows = financialPage(list, seen);
    for (const invoice of rows) {
      if (invoice.status !== "paid" || invoice.billing_reason !== "subscription_cycle") continue;
      if (!handles.has(invoiceMeta(invoice).store ?? "")) continue;
      const cents = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
      const email = typeof invoice.customer_email === "string" ? invoice.customer_email.trim() : "";
      if (cents <= 0 || !email) continue;
      const meta = invoiceMeta(invoice);
      const listedPayment = ((invoice.payments as { data?: { status?: unknown; payment?: { payment_intent?: unknown } | null }[] } | null | undefined)?.data ?? []).find((p) => p.status === "paid")?.payment?.payment_intent;
      const paymentIntent = typeof invoice.payment_intent === "string" ? invoice.payment_intent : typeof listedPayment === "string" ? listedPayment : "";
      const channel = "channel" in meta ? (meta.channel === "direct" ? "" : meta.channel) : meta.utm_source || UNRECORDED;
      const currency = currencyOf(invoice);
      if (!currency) partial = true;
      out.push({ email, created: (typeof invoice.created === "number" ? invoice.created : 0) * 1000, cents, currency, paymentIntent, channel, invoice: typeof invoice.id === "string" ? invoice.id : "" });
    }
    if (!list.has_more) break;
    // Out of time: what was read is kept, and the reading says it is partial.
    if (Date.now() > deadline) { partial = true; break; }
    const last = rows[rows.length - 1];
    after = typeof last.id === "string" ? last.id : "";
    if (!after) { partial = true; break; }
    if (page === pages - 1) partial = true;
  }
  return { rows: out, partial };
}

/** The disputes that took money since `since`, for a reader outside this file (lib/segments.ts); the same reading the numbers use. */
export function readStoreDisputes(store: Store, since: number, pages = DISPUTE_PAGES): Promise<{ rows: DisputeRow[]; partial: boolean }> {
  return readDisputes(store, since, pages);
}

/** One dispute as Stripe lists it, only in a state that takes the money (DISPUTE_TAKES). */
export type DisputeRow = { created: number; cents: number; currency: string; paymentIntent: string };

/** How many pages of a hundred disputes are read for the numbers; the affiliate book reads as many. */
const DISPUTE_PAGES = 3;

/**
 * The disputes opened on the creator's account since `since` (seconds) that
 * the bank is holding or the buyer won. At most DISPUTE_PAGES pages of a
 * hundred; `partial` when there were more.
 */
async function readDisputes(store: Store, since: number, pages = DISPUTE_PAGES): Promise<{ rows: DisputeRow[]; partial: boolean }> {
  const out: DisputeRow[] = [];
  let after = "";
  const seen = new Set<string>();
  let partial = false;
  for (let page = 0; page < pages; page += 1) {
    const list = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/disputes?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    )) as { data?: unknown; has_more?: unknown };
    const rows = financialPage(list, seen);
    for (const row of rows) {
      if (typeof row.status !== "string" || !DISPUTE_TAKES.has(row.status)) continue;
      const raw = row.payment_intent;
      const pi = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "";
      const cents = typeof row.amount === "number" && row.amount > 0 ? row.amount : 0;
      if (!cents) continue;
      const currency = currencyOf(row);
      if (!currency) partial = true;
      out.push({ created: typeof row.created === "number" ? row.created * 1000 : 0, cents, currency, paymentIntent: pi });
    }
    if (!list.has_more) break;
    const last = rows[rows.length - 1];
    after = typeof last.id === "string" ? last.id : "";
    if (!after) { partial = true; break; }
    if (page === pages - 1) partial = true;
  }
  return { rows: out, partial };
}

/** One refund as Stripe lists it: when, how much, in what, and the payment it gave back. */
export type RefundRow = { created: number; cents: number; currency: string; paymentIntent: string };

/** The refunds made on the creator's account since `since` (seconds) that went through; at most `pages` pages of a hundred. */
async function readRefunds(store: Store, since: number, pages: number): Promise<{ rows: RefundRow[]; partial: boolean }> {
  const out: RefundRow[] = [];
  let after = "";
  const seen = new Set<string>();
  let partial = false;
  for (let page = 0; page < pages; page += 1) {
    const list = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/refunds?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    )) as { data?: unknown; has_more?: unknown };
    const rows = financialPage(list, seen);
    for (const row of rows) {
      if (row.status !== "succeeded" && row.status !== "pending") continue;
      const currency = currencyOf(row);
      if (!currency) partial = true;
      out.push({
        created: typeof row.created === "number" ? row.created * 1000 : 0,
        cents: typeof row.amount === "number" ? row.amount : 0,
        currency,
        paymentIntent: typeof row.payment_intent === "string" ? row.payment_intent : "",
      });
    }
    if (!list.has_more) break;
    const last = rows[rows.length - 1];
    after = typeof last.id === "string" ? last.id : "";
    if (!after) { partial = true; break; }
    if (page === pages - 1) partial = true;
  }
  return { rows: out, partial };
}

/**
 * The refunds made on the creator's account since `since` (seconds), for a
 * reader outside this file that has to take refunds off sales it read itself
 * (lib/path-facts.ts). The same reading the numbers use.
 */
export function readStoreRefunds(store: Store, since: number, pages: number): Promise<{ rows: RefundRow[]; partial: boolean }> {
  return readRefunds(store, since, pages);
}

/**
 * The store's all-time record as it is kept, in one command and without
 * filling it from the days (readLife does that, from the studio's numbers):
 * where visits came from (r:<source>), the addresses asked for (fs:<channel>)
 * and the visitors (u). Empty when there is none; an answer in any other
 * shape throws (CX-123 rule 24), so readPathCounts keeps the last reading.
 */
export async function readLifeRecord(statsId: string | null): Promise<Map<string, number>> {
  if (!statsId || !isRedisConfigured()) return new Map();
  return lifeCounts(await readLifeFlat(lifeKey(statsId)));
}

/** Sales in the last STATS_DAYS days, by day, by product, and for each window. */
export async function readSales(store: Store, now = Date.now()): Promise<SalesStats | null> {
  if (!readsSales(store)) return null;
  const since = Math.floor(now / 1000) - STATS_DAYS * 86400;
  // Twice as far back for the sales, so each window can be set beside the
  // stretch before it; twice the pages, so the 90 days themselves reach as far
  // as they did when only they were read.
  const sinceBefore = Math.floor(now / 1000) - 2 * STATS_DAYS * 86400;
  // Read beside the sales; a store whose renewals cannot be read still sees its sales.
  const [{ sales: read, partial: readPartial }, renewalRead, refundRead, disputeRead] = await Promise.all([
    readPaidSales(store, sinceBefore, 20),
    store.stripeAccountId
      ? readRenewals(store, since, now, 10).catch((error) => {
          console.error("reading renewals failed", error);
          return undefined;
        })
      : Promise.resolve(undefined),
    (async (): Promise<{ rows: RefundRow[]; partial: boolean } | null> => {
      // Stripe's refunds, and PayPal's refunded in full (lib/paypal-sales.ts), named by the payment each gave back.
      const stripe = store.stripeAccountId
        ? await readRefunds(store, since, 5).catch((error) => {
            console.error("reading refunds failed", error);
            return null;
          })
        : { rows: [], partial: false };
      if (stripe === null) return null;
      const paypal = await readPayPalRefundsWithCoverage(store.statsId, since).catch(() => null);
      if (paypal === null) return null;
      return {
        rows: [...stripe.rows, ...paypal.rows.map((r) => ({ created: r.at * 1000, cents: r.cents, currency: r.currency, paymentIntent: paypalPaymentId(r.capture) }))],
        partial: stripe.partial || paypal.partial,
      };
    })(),
    // Chargebacks: money the bank holds or the buyer won. None to read without a Stripe account.
    store.stripeAccountId
      ? readDisputes(store, since).catch((error): null => {
          console.error("reading disputes failed", error);
          return null;
        })
      : Promise.resolve({ rows: [] as DisputeRow[], partial: false }),
  ]);
  const renewalEntryRows = renewalRead?.entries ?? [];
  let renewals: SalesStats["renewals"] = undefined;
  if (renewalRead) {
    const { d7, d30, d90, partial: renewalsPartial, bySource, bySourceDay } = renewalRead;
    renewals = { d7, d30, d90, partial: renewalsPartial, bySource, bySourceDay };
  }
  const refundRows = refundRead?.rows ?? null;
  const cut7 = dayKey(now - 6 * 86400_000);
  const cut30 = dayKey(now - 29 * 86400_000);
  const cut90 = dayKey(now - (STATS_DAYS - 1) * 86400_000);
  // The 90 days are the days the visits are read for, today and the 89 before.
  const sales = read.filter((sale) => dayKey(sale.created) >= cut90);
  // A merged old sale cannot certify independent capped payment sources.
  const partial = readPartial;
  const stretch = (from: string, to: string): SalesWindow | null => {
    if (readPartial) return null;
    const out = { sales: 0, cents: 0 };
    for (const sale of read) {
      const day = dayKey(sale.created);
      if (day < from || day >= to || sale.currency !== store.currency) continue;
      out.sales += 1;
      out.cents += sale.cents;
    }
    return out;
  };
  const zero = () => ({ sales: 0, cents: 0 });
  const out: SalesStats = { byDay: {}, byProduct: Object.create(null), totals: { d7: zero(), d30: zero(), d90: zero() }, partial, elsewhere: 0, bySource: [], ...(renewals ? { renewals } : {}) };
  for (const sale of sales) {
    if (sale.currency !== store.currency) {
      // A currency not named is not "another currency": the reading is marked incomplete instead.
      if (sale.currency) out.elsewhere += 1;
      continue;
    }
    const day = dayKey(sale.created);
    const d = (out.byDay[day] ??= zero());
    d.sales += 1;
    d.cents += sale.cents;
    const p = (out.byProduct[sale.product] ??= { d7: zero(), d30: zero(), d90: zero() });
    const windows: ("d7" | "d30" | "d90")[] = ["d90", ...(day >= cut30 ? (["d30"] as const) : []), ...(day >= cut7 ? (["d7"] as const) : [])];
    for (const w of windows) {
      p[w].sales += 1;
      p[w].cents += sale.cents;
      out.totals[w].sales += 1;
      out.totals[w].cents += sale.cents;
    }
  }
  // A product id is read from the sale's metadata, which the creator's own Stripe account can set to "__proto__":
  // added up with no prototype above, handed on as an ordinary record of own keys.
  out.byProduct = { ...out.byProduct };
  // What each link brought in, over the same ninety days. Only the store's
  // own currency: the sales in another one are counted in `elsewhere` and
  // left out of every total here, for the reason given on that field.
  out.bySource = revenueBySource(
    sales.filter((sale) => sale.currency === store.currency).map((sale) => ({
      cents: sale.cents,
      currency: sale.currency,
      source: sale.source,
    })),
  );
  const own = sales.filter((sale) => sale.currency === store.currency);
  const fromDay = (cut: string) =>
    revenueBySource(own.filter((sale) => dayKey(sale.created) >= cut).map((sale) => ({ cents: sale.cents, currency: sale.currency, source: sale.source })));
  out.bySourceIn = { d7: fromDay(cut7), d30: fromDay(cut30), d90: out.bySource };
  const campaignsFrom = (cut: string) => {
    const by = new Map<string, { campaign: string; source: string; sources: string[]; cents: number; sales: number }>();
    for (const sale of own) {
      if (!sale.campaign || dayKey(sale.created) < cut) continue;
      const source = sale.source || "direct";
      const row = by.get(sale.campaign) ?? { campaign: sale.campaign, source, sources: [], cents: 0, sales: 0 };
      row.sources = [...new Set([...row.sources, source])].sort();
      row.source = row.sources.length === 1 ? row.sources[0] : "";
      row.cents += sale.cents;
      row.sales += 1;
      by.set(sale.campaign, row);
    }
    return [...by.values()].sort((a, b) => b.cents - a.cents || a.campaign.localeCompare(b.campaign));
  };
  out.byCampaignIn = { d7: campaignsFrom(cut7), d30: campaignsFrom(cut30), d90: campaignsFrom("") };
  out.firstBySource = revenueBySource(
    sales.filter((sale) => sale.currency === store.currency && !sale.upsell).map((sale) => ({
      cents: sale.cents,
      currency: sale.currency,
      source: sale.first,
    })),
  );
  // The same checkouts by the last visit and by the first, for each window.
  const sideBySide = (cut: string) => {
    const kept = own.filter((sale) => !sale.upsell && dayKey(sale.created) >= cut);
    return {
      last: revenueBySource(kept.map((sale) => ({ cents: sale.cents, currency: sale.currency, source: sale.source }))),
      first: revenueBySource(kept.map((sale) => ({ cents: sale.cents, currency: sale.currency, source: sale.first }))),
    };
  };
  out.attributionIn = { d7: sideBySide(cut7), d30: sideBySide(cut30), d90: sideBySide("") };
  // Which ad, and which country, each window's money came from.
  const contentIn = (cut: string) => creativeRowsFrom(own, cut);
  const countryIn = (cut: string) => {
    const by = new Map<string, { country: string; cents: number; sales: number }>();
    for (const sale of own) {
      if (!sale.country || dayKey(sale.created) < cut) continue;
      const row = by.get(sale.country) ?? { country: sale.country, cents: 0, sales: 0 };
      row.cents += sale.cents;
      row.sales += 1;
      by.set(sale.country, row);
    }
    return [...by.values()].sort((a, b) => b.cents - a.cents || b.sales - a.sales || a.country.localeCompare(b.country));
  };
  out.byContentIn = { d7: contentIn(cut7), d30: contentIn(cut30), d90: contentIn("") };
  out.byCountryIn = { d7: countryIn(cut7), d30: countryIn(cut30), d90: countryIn("") };
  // The tax collected at checkout, every currency each on its own, from the same 90 days' sales (lib/tax-summary.ts).
  out.taxIn = taxSummary(sales, { d7: cut7, d30: cut30, d90: cut90 }, store.currency, readPartial);
  if (refundRows) {
    // A refund is credited to the channel and product of the sale it gave back,
    // found by the payment it names among every sale read, the 180 days.
    const byPayment = new Map(read.filter((sale) => sale.paymentIntent).map((sale) => [sale.paymentIntent, sale]));
    const refundsFrom = (cut: string) => {
      const by = new Map<string, { source: string; refunds: number; cents: number }>();
      for (const refund of refundRows) {
        if (dayKey(refund.created) < cut || refund.currency !== store.currency) continue;
        const sale = byPayment.get(refund.paymentIntent);
        const source = sale ? sale.source : UNRECORDED;
        const row = by.get(source) ?? { source, refunds: 0, cents: 0 };
        row.refunds += 1;
        row.cents += refund.cents;
        by.set(source, row);
      }
      return [...by.values()].sort((a, b) => b.cents - a.cents || a.source.localeCompare(b.source));
    };
    out.refundsIn = { d7: refundsFrom(cut7), d30: refundsFrom(cut30), d90: refundsFrom(cut90) };
    out.refundDays = {};
    for (const refund of refundRows) {
      const day = dayKey(refund.created);
      if (refund.currency !== store.currency || day < cut90) continue;
      out.refundDays[day] = (out.refundDays[day] ?? 0) + refund.cents;
    }
    out.takenBackElsewhere = { refunds: refundRows.filter((refund) => refund.currency && refund.currency !== store.currency && dayKey(refund.created) >= cut90).length, disputes: null };
    const refundsByProduct: NonNullable<SalesStats["refundsByProduct"]> = Object.create(null);
    for (const refund of refundRows) {
      if (refund.currency !== store.currency) continue;
      const sale = byPayment.get(refund.paymentIntent);
      if (!sale?.product) continue;
      const row = (refundsByProduct[sale.product] ??= { refunds: 0, cents: 0 });
      row.refunds += 1;
      row.cents += refund.cents;
    }
    out.refundsByProduct = { ...refundsByProduct };
  }
  // Each channel's money by the day, renewals included.
  const channelDays: ChannelDays = Object.create(null);
  const addDay = (channel: string, day: string, cents: number) => {
    const days = (channelDays[channel] ??= {});
    days[day] = (days[day] ?? 0) + cents;
  };
  for (const sale of own) addDay(sale.source || "direct", dayKey(sale.created), sale.cents);
  for (const [channel, days] of Object.entries(renewals?.bySourceDay ?? {})) {
    for (const [day, cents] of Object.entries(days)) if (day >= cut90) addDay(channel, day, cents);
  }
  out.channelDays = { ...channelDays };
  out.buyers = buyersFrom(read, store.currency, now);
  out.buyerChannels = buyerChannelsFrom(read, store.currency, now, readPartial);
  if (disputeRead) {
    // A dispute is credited to the channel of the sale it takes back, as a refund is.
    const byPayment = new Map(read.filter((sale) => sale.paymentIntent).map((sale) => [sale.paymentIntent, sale]));
    const disputesFrom = (cut: string) => {
      const by = new Map<string, { source: string; disputes: number; cents: number }>();
      for (const dispute of disputeRead.rows) {
        if (dayKey(dispute.created) < cut || dispute.currency !== store.currency) continue;
        const sale = dispute.paymentIntent ? byPayment.get(dispute.paymentIntent) : undefined;
        const source = sale ? sale.source : UNRECORDED;
        const row = by.get(source) ?? { source, disputes: 0, cents: 0 };
        row.disputes += 1;
        row.cents += dispute.cents;
        by.set(source, row);
      }
      return [...by.values()].sort((a, b) => b.cents - a.cents || a.source.localeCompare(b.source));
    };
    out.disputesIn = { d7: disputesFrom(cut7), d30: disputesFrom(cut30), d90: disputesFrom(cut90) };
    out.takenBackElsewhere = { refunds: out.takenBackElsewhere?.refunds ?? null, disputes: disputeRead.rows.filter((dispute) => dispute.currency && dispute.currency !== store.currency && dayKey(dispute.created) >= cut90).length };
  } else {
    out.disputesIn = null;
  }
  out.disputesComplete = disputeRead !== null && !disputeRead.partial;
  out.paypalDisputesUnread = sellsThroughPayPal(store);
  {
    // What each currency kept (lib/retained-revenue.ts): every reading as entries with its channel.
    const byPayment = new Map(read.filter((sale) => sale.paymentIntent).map((sale) => [sale.paymentIntent, sale]));
    const placed = (paymentIntent: string) => (paymentIntent ? byPayment.get(paymentIntent)?.source : undefined) ?? UNRECORDED;
    out.keptIn = keptByCurrency(
      {
        sales: { entries: sales.map((sale) => ({ day: dayKey(sale.created), cents: sale.cents, currency: sale.currency, source: sale.source })), complete: !readPartial },
        renewals: store.stripeAccountId ? { entries: renewalEntryRows, complete: Boolean(renewals && !renewals.partial) } : null,
        refunds: refundRead
          ? { entries: refundRead.rows.map((r) => ({ day: dayKey(r.created), cents: r.cents, currency: r.currency, source: placed(r.paymentIntent) })), complete: !refundRead.partial }
          : null,
        disputes: disputeRead
          ? { entries: disputeRead.rows.map((d) => ({ day: dayKey(d.created), cents: d.cents, currency: d.currency, source: placed(d.paymentIntent) })), complete: !disputeRead.partial }
          : null,
      },
      dayKey(now),
      store.currency,
    );
  }
  out.paymentsComplete = !partial && (!store.stripeAccountId || Boolean(renewals && !renewals.partial));
  out.cashflowComplete = out.paymentsComplete && !readPartial && refundRead !== null && !refundRead.partial &&
    !(out.refundsIn?.d90 ?? []).some((r) => r.source === UNRECORDED);
  out.levers = measureSalesLevers(read,store.currency,readPartial,now);
  out.hours = hoursOfWeek(own.filter((sale) => !sale.upsell));
  out.discounts = {
    rows: discountImpact(read, new Set((refundRows ?? []).map((r) => r.paymentIntent).filter(Boolean)), store.currency, now, STATS_DAYS),
    refundsRead: refundRows !== null,
  };
  out.previous = {
    d7: stretch(dayKey(now - 13 * 86400_000), cut7),
    d30: stretch(dayKey(now - 59 * 86400_000), cut30),
    d90: stretch(dayKey(now - (2 * STATS_DAYS - 1) * 86400_000), cut90),
  };
  return out;
}

/** Checkouts by hour of the week in UTC, Sunday 0:00 first, 168 hours: how many and the money. Pure. */
export function hoursOfWeek(sales: { created: number; cents: number }[]): { sales: number[]; cents: number[] } {
  const out = { sales: new Array<number>(168).fill(0), cents: new Array<number>(168).fill(0) };
  for (const sale of sales) {
    const at = new Date(sale.created);
    const hour = at.getUTCDay() * 24 + at.getUTCHours();
    out.sales[hour] += 1;
    out.cents[hour] += sale.cents;
  }
  return out;
}

/** Any stretch of days the creator picks, as far back as the days are kept (added 12 October 2026). */
export type RangeData = {
  from: string;
  to: string;
  currency: string;
  days: { date: string; visitors: number; views: number; checkouts: number; sales: number; cents: number }[];
  totals: { visitors: number; views: number; checkouts: number; sales: number; cents: number };
  /** The same number of days just before, where they are kept; null where they are not. */
  before: { visitors: number; views: number; checkouts: number; sales: number | null; cents: number | null } | null;
  /** Visits by channel, with the sales credited to it, the biggest first. */
  channels: { source: string; visits: number; sales: number; cents: number }[];
  /** Each product's page views, checkouts and sales, the biggest first. */
  products: { id: string; views: number; checkouts: number; sales: number; cents: number }[];
  /** Recorded rows before the display cap, not a claim of complete paid coverage. */
  channelsTotal?: number;
  channelsTruncated?: boolean;
  productsTotal?: number;
  productsTruncated?: boolean;
  sales: "ok" | "none" | "error";
  /** More sales than one reading covers: the oldest are missing. */
  partial: boolean;
  /** Sales in another currency, left out of the sums. */
  elsewhere: number;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a stretch can be read: real dates, in order, not in the future, and inside the kept days. Pure. */
export function rangeProblem(from: string, to: string, now = Date.now()): "dates" | "order" | "future" | "kept" | null {
  if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return "dates";
  if (dayKey(Date.parse(`${from}T00:00:00Z`)) !== from || dayKey(Date.parse(`${to}T00:00:00Z`)) !== to) return "dates";
  if (from > to) return "order";
  if (to > dayKey(now)) return "future";
  if (from < dayKey(now - (KEPT_DAYS - 1) * 86400_000)) return "kept";
  return null;
}

const datesBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); out.length <= KEPT_DAYS; at += 86400_000) {
    const day = dayKey(at);
    if (day > to) break;
    out.push(day);
  }
  return out;
};

/**
 * A stretch of days the creator picks: the visits from the days kept (one
 * read a day, and the people over the whole stretch in one command), and
 * the sales from the creator's own Stripe account, as the 90 days are read.
 * Beside it, the same number of days just before, where they are kept.
 */
export async function readRange(store: Store, from: string, to: string, now = Date.now(), options: { fullDetails?: boolean } = {}): Promise<RangeData | null> {
  if (!store.statsId || !isRedisConfigured() || rangeProblem(from, to, now)) return null;
  const statsId = store.statsId;
  const dates = datesBetween(from, to);
  const span = dates.length;
  const beforeFrom = dayKey(Date.parse(`${from}T00:00:00Z`) - span * 86400_000);
  const beforeTo = dayKey(Date.parse(`${from}T00:00:00Z`) - 86400_000);
  const beforeKept = !rangeProblem(beforeFrom, beforeTo, now);
  const beforeDates = beforeKept ? datesBetween(beforeFrom, beforeTo) : [];
  const results = await redisPipeline([
    ...dates.map((d) => ["HGETALL", countsKey(statsId, d)]),
    ...dates.map((d) => ["PFCOUNT", visitorsKey(statsId, d)]),
    ["PFCOUNT", ...dates.map((d) => visitorsKey(statsId, d))],
    ...(beforeKept ? [["PFCOUNT", ...beforeDates.map((d) => visitorsKey(statsId, d))], ...beforeDates.map((d) => ["HMGET", countsKey(statsId, d), "v", "c"])] : []),
  ]);
  const traffic = rangeTrafficCoverage(results, span, beforeKept);
  if (!traffic.current) return null;
  const tally = new Tally();
  const days: RangeData["days"] = dates.map((date, i) => {
    let views = 0;
    let checkouts = 0;
    for (const [field, n] of pairs(results[i])) {
      if (field === "v") views = n;
      else if (field === "c") checkouts = n;
      tally.add(field, n);
    }
    return { date, visitors: Number(results[span + i]) || 0, views, checkouts, sales: 0, cents: 0 };
  });
  const window = tally.window(Number(results[2 * span]) || 0);
  let before: RangeData["before"] = null;
  if (traffic.previous) {
    const at = 2 * span + 1;
    before = { visitors: Number(results[at]) || 0, views: 0, checkouts: 0, sales: 0, cents: 0 };
    beforeDates.forEach((_, i) => {
      const reply = results[at + 1 + i];
      if (!Array.isArray(reply)) return;
      before!.views += Number(reply[0]) || 0;
      before!.checkouts += Number(reply[1]) || 0;
    });
  }

  const out: RangeData = {
    from,
    to,
    currency: store.currency,
    days,
    totals: { visitors: window.visitors, views: window.views, checkouts: window.checkouts, sales: 0, cents: 0 },
    before,
    channels: [],
    products: [],
    sales: readsSales(store) ? "ok" : "none",
    partial: false,
    elsewhere: 0,
  };
  const bySource = new Map<string, { source: string; visits: number; sales: number; cents: number }>();
  for (const row of window.sources) bySource.set(row.name, { source: row.name, visits: row.visits, sales: 0, cents: 0 });
  const byProduct = new Map<string, { id: string; views: number; checkouts: number; sales: number; cents: number }>();
  const productRow = (id: string) => byProduct.get(id) ?? { id, views: 0, checkouts: 0, sales: 0, cents: 0 };
  for (const [id, n] of Object.entries(window.viewsByProduct)) byProduct.set(id, { ...productRow(id), views: n });
  for (const [id, n] of Object.entries(window.checkoutsByProduct)) byProduct.set(id, { ...productRow(id), checkouts: n });

  if (readsSales(store)) {
    const start = Date.parse(`${(before ? beforeFrom : from)}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`) + 86400_000;
    try {
      const { sales, partial } = await readPaidSales(store, Math.floor(start / 1000), 20);
      // Different providers and record types have independent pagination. An old
      // returned sale cannot prove that another capped reading reached this range.
      out.partial = partial;
      const byDay = new Map(days.map((d) => [d.date, d]));
      for (const sale of sales) {
        if (sale.created >= end || sale.created < start) continue;
        if (sale.currency !== store.currency) {
          if (sale.currency && sale.created >= Date.parse(`${from}T00:00:00Z`)) out.elsewhere += 1;
          continue;
        }
        const day = byDay.get(dayKey(sale.created));
        if (!day) {
          if (before) {
            before.sales = (before.sales ?? 0) + 1;
            before.cents = (before.cents ?? 0) + sale.cents;
          }
          continue;
        }
        day.sales += 1;
        day.cents += sale.cents;
        out.totals.sales += 1;
        out.totals.cents += sale.cents;
        if (!sale.upsell) {
          const source = sale.source || "direct";
          const row = bySource.get(source) ?? { source, visits: 0, sales: 0, cents: 0 };
          row.sales += 1;
          row.cents += sale.cents;
          bySource.set(source, row);
        }
        if (sale.product) {
          const row = productRow(sale.product);
          byProduct.set(sale.product, { ...row, sales: row.sales + 1, cents: row.cents + sale.cents });
        }
      }
    } catch (error) {
      console.error("reading the sales of a stretch failed", error);
      out.sales = "error";
    }
  }
  if (before && (out.sales !== "ok" || out.partial)) {
    before.sales = null;
    before.cents = null;
  }
  out.channelsTotal = bySource.size;
  out.productsTotal = byProduct.size;
  out.channelsTruncated = !options.fullDetails && bySource.size > 15;
  out.productsTruncated = !options.fullDetails && byProduct.size > 15;
  const paidKnown = out.sales === "ok" && !out.partial;
  out.channels = [...bySource.values()].sort((a, b) => (paidKnown ? b.cents - a.cents : 0) || b.visits - a.visits || a.source.localeCompare(b.source)).slice(0, options.fullDetails ? undefined : 15);
  out.products = [...byProduct.values()].sort((a, b) => (paidKnown ? b.cents - a.cents : 0) || b.views - a.views || a.id.localeCompare(b.id)).slice(0, options.fullDetails ? undefined : 15);
  return out;
}

/** The most pages of a hundred read for all-time sales. */
export const ALL_TIME_PAGES = 30;
const allSalesKey = (statsId: string) => `nl:stats:${statsId}:allsales`;
/** How long an all-time reading is reused, so the button can be pressed freely. */
const ALL_SALES_SECONDS = 600;

/**
 * Every sale the store has made, as far back as ALL_TIME_PAGES pages of
 * checkouts reach, read when the creator asks for it and kept ten minutes.
 */
export async function readAllTimeSales(store: Store): Promise<AllTimeSales | null> {
  if (!readsSales(store)) return null;
  if (store.statsId && isRedisConfigured()) {
    const [cached] = await redisPipeline([["GET", allSalesKey(store.statsId)]]);
    if (typeof cached === "string" && cached) {
      try {
        const kept = JSON.parse(cached) as AllTimeSales;
        // Read again when the store has changed its currency since, or when the kept reading does not say
        // what it is in or how many sales it left out (rule 24): never taken for dollars nor for none.
        if (kept.currency === store.currency && Number.isSafeInteger(kept.elsewhere) && kept.elsewhere >= 0) return { ...kept, together: parseTogether(kept.together) };
      } catch {
        // Read again below.
      }
    }
  }
  const { sales, partial } = await readPaidSales(store, 0, ALL_TIME_PAGES);
  const out: AllTimeSales = { totals: { sales: 0, cents: 0 }, byProduct: Object.create(null), since: "", partial, currency: store.currency, elsewhere: 0 };
  for (const sale of sales) {
    if (sale.currency !== store.currency) {
      if (sale.currency) out.elsewhere += 1;
      continue;
    }
    out.totals.sales += 1;
    out.totals.cents += sale.cents;
    const p = (out.byProduct[sale.product] ??= { sales: 0, cents: 0 });
    p.sales += 1;
    p.cents += sale.cents;
  }
  out.byProduct = { ...out.byProduct };
  if (sales.length) out.since = dayKey(sales[sales.length - 1].created);
  out.together = togetherFrom(sales);
  // What each product's buyers bought later, and how long after (lib/next-bought.ts), kept a week for the studio.
  await keepPaths(store.statsId, pathsFrom(sales)).catch(() => {});
  if (store.statsId && isRedisConfigured()) {
    await redisPipeline([["SET", allSalesKey(store.statsId), JSON.stringify(out), "EX", ALL_SALES_SECONDS]]).catch(() => {});
  }
  return out;
}

// ---- What the studio shows ------------------------------------------------

export type RangeKey = "d7" | "d30" | "d90" | "all";

export type Totals = { visitors: number; views: number; checkouts: number; sales: number; cents: number };

/** `views` is -1 for all time, which is not kept for a product's page. */
export type ProductRow = { views: number; checkouts: number; sales: number; cents: number };

export type StatsData = {
  days: { date: string; visitors: number; views: number; checkouts: number; sales: number }[];
  /** "all" has no sales until the creator asks for them (salesAll). */
  totals: Record<RangeKey, Totals>;
  sources: Record<RangeKey, Ranked>;
  mediums: Record<RangeKey, Ranked>;
  campaigns: Record<RangeKey, Ranked>;
  products: ({ id: string; title: string } & Record<RangeKey, ProductRow>)[];
  links: ({ id: string; title: string } & Record<RangeKey, number>)[];
  /** "none" when there is no Stripe account to read sales from yet. */
  sales: "ok" | "none" | "error";
  partial: boolean;
  /** What the money in it is in: the store's currency. */
  currency: string;
  /** Sales in another currency, from before the store changed it: not in the totals. */
  elsewhere: number;
  /** The first day all-time visits cover, or empty when unknown. */
  since: string;
  /**
   * What each link brought in over the last 90 days, biggest first.
   *
   * The whole point of tagging a link is this row and not the visitor count
   * beside it: four hundred people from a newsletter and six hundred dollars
   * in the same month were two numbers that never met, and a creator cannot
   * decide where to spend their week on the first one alone.
   */
  revenueBySource: { source: string; cents: number; sales: number; renewalCents: number; renewals: number }[];
  /**
   * The same money credited to where each buyer FIRST came from, rather than
   * to the visit they bought on (lib/visit-channel.ts). Renewals are not in
   * it: a subscription remembers the channel it was sold through, not the
   * buyer's first one.
   */
  firstBySource: { source: string; cents: number; sales: number }[];
  /**
   * Each channel from visit to sale for the window (not "all": sales are read
   * for 90 days): visits from it, checkouts started from it, free products'
   * addresses asked for from it, and its sales and revenue. Biggest first.
   */
  channels: Record<"d7" | "d30" | "d90", ChannelRow[]>;
  /**
   * Each campaign — a post, when the creator made its link with the post's
   * name (lib/share-links.ts postLink) — with its visits and the money it
   * brought, for the window. Biggest first.
   */
  posts: Record<"d7" | "d30" | "d90", { campaign: string; source: string; sources?: string[]; visits: number; sales: number; cents: number }[]>;
  /** Page views by country and by device, for the window; empty for "all", which keeps neither. */
  countries: Record<RangeKey, Ranked>;
  devices: Record<RangeKey, Ranked>;
  /** Memberships renewed and later plan payments, by window (SalesStats.renewals); null when they could not be read. */
  renewals: { d7: Renewals; d30: Renewals; d90: Renewals; partial: boolean } | null;
  /**
   * The store's own page item by item, for the window (lib/page-read.ts): of
   * the visitors measured, how many got as far as each item and how many
   * clicked it, in the order of the page. Measured on one visitor in eight.
   */
  reach: Record<"d7" | "d30" | "d90", { visitors: number; rows: ReachItem[] }>;
  /**
   * The stretch of days just before each window, to set the window beside:
   * the 7 days before the last 7, and so on. Sales and money are null where
   * they were not read, or not read in full.
   */
  previous: Record<"d7" | "d30" | "d90", { visitors: number; views: number; checkouts: number; sales: number | null; cents: number | null }>;
  /** Availability of the source traffic history, before legacy zero placeholders are applied. */
  previousTrafficAvailable?: Record<"d7" | "d30" | "d90", boolean>;
  /** Buyers' answers to "where did you hear about us?" for the window, the most first (lib/heard.ts). */
  heard: Record<"d7" | "d30" | "d90", { answer: string; buyers: number; cents: number; unknownBuyers?: number; unknownCents?: number }[]>;
  /** Each channel's money three ways, for the window: by the last visit, the first, and what buyers said (lib/attribution-rules.ts). */
  attribution?: Record<"d7" | "d30" | "d90", AttributionTable>;
  /** How many days after a visit a sale is credited to it, as the creator chose. */
  attributionDays?: number;
  /** What visitors searched the store for and found nothing, for the window, the most first. */
  searchMisses: Record<"d7" | "d30" | "d90", Ranked>;
  /** Money by the ad it came from (utm_content), for the window. */
  ads: Record<"d7" | "d30" | "d90", { content: string; source: string; campaign: string; sales: number; cents: number }[]>;
  /** Money by the buyer's country, for the window, as Stripe has the country. */
  salesCountries: Record<"d7" | "d30" | "d90", { country: string; sales: number; cents: number }[]>;
  /** The tax collected at checkout (SalesStats.taxIn); null when it could not be read. */
  taxCollected?: TaxSummary | null;
  /** Refunds made in the window, by the channel of the sale refunded; null when they could not be read. */
  refunds: Record<"d7" | "d30" | "d90", { source: string; refunds: number; cents: number }[]> | null;
  /** Refunds over the last 90 days, by product. */
  refundsByProduct: Record<string, { refunds: number; cents: number }>;
  /** Refunds and disputes of the last 90 days in another currency, left out of the amounts (SalesStats.takenBackElsewhere). */
  takenBackElsewhere?: { refunds: number | null; disputes: number | null } | null;
  /** Disputes opened in the window that took money, by the channel of the sale; null when they could not be read. */
  disputes?: Record<"d7" | "d30" | "d90", { source: string; disputes: number; cents: number }[]> | null;
  disputesComplete?: boolean;
  /** What each currency kept in each window (SalesStats.keptIn). */
  kept?: Record<"d7" | "d30" | "d90", KeptWindow> | null;
  paypalDisputesUnread?: boolean;
  /** Each channel's money by the day over the 90 days, renewals included (SalesStats.channelDays). */
  channelDays?: ChannelDays;
  /** Refund amounts on the UTC day recorded; null means no complete ledger was read. */
  refundDays?: Record<string, number> | null;
  /** Who bought, for each window (SalesStats.buyers): counts and money only, no address. */
  buyers?: Record<"d7" | "d30" | "d90", BuyersWindow> | null;
  buyerChannels?: BuyerChannels | null;
  cashflowComplete?: boolean;
  /** Purchases and renewals were read in full for the current 90-day ledger, independently of refunds. */
  paymentsComplete?: boolean;
  /** Full price beside each kind of discount over the 90 days (SalesStats.discounts). */
  discounts?: { rows: DiscountRow[] | null; refundsRead: boolean } | null;
  /** Checkouts by hour of the week in UTC over the 90 days (SalesStats.hours); the browser turns them to its own time. */
  hours?: { sales: number[]; cents: number[] } | null;
  /**
   * The biggest buyers of the 90 days, with their addresses: added by the
   * studio page only for whoever may read orders (lib/team-roles.ts), never
   * by studioStats, so no file, email or API made from it has them.
   */
  topBuyers?: TopBuyer[];
};

export type ReachItem = { item: string; kind: "product" | "link" | "part"; title: string; position: number; reached: number; clicks: number };

/** The products the store page's measured items name, so their titles can be read with the others (studioStats). */
export function reachProducts(stats: Stats): string[] {
  const ids = new Set<string>();
  for (const field of Object.keys(stats.windows.d90.reach ?? {})) {
    for (const part of field.split(/[.>]/)) if (part.startsWith("p:")) ids.add(part.slice(2));
  }
  return [...ids];
}

/** One window's store page, item by item, with each item's name. */
export function reachItems(store: Store, fields: Record<string, number>, titles: Map<string, string>): { visitors: number; rows: ReachItem[] } {
  const { visitors, rows } = reachRows(fields);
  const parts = new Map<string, string>(PAGE_PARTS.map((p) => [p.id, p.label]));
  return {
    visitors,
    rows: rows.map((row) => {
      const id = row.item.slice(2);
      const kind = row.item.startsWith("p:") ? "product" : row.item.startsWith("l:") ? "link" : "part";
      const title =
        kind === "product"
          ? titles.get(id) ?? "A product no longer in your store"
          : kind === "link"
            ? store.links.find((link) => link.id === id)?.title ?? "A link no longer on your page"
            : parts.get(id) ?? id;
      return { ...row, kind, title };
    }),
  };
}

const EMPTY_WINDOW: WindowStats = {
  visitors: 0,
  views: 0,
  checkouts: 0,
  sources: [],
  mediums: [],
  campaigns: [],
  checkoutsByProduct: {},
  viewsByProduct: {},
  linkClicks: {},
  countries: [],
  devices: [],
  checkoutsBySource: [],
  freeBySource: [],
  reach: {},
  heard: {},
  searchMisses: [],
};

export type ChannelRow = { source: string; visits: number; checkouts: number; free: number; sales: number; cents: number };

/** One window's channels, put together from the visit counts and the sales read from Stripe. */
export function channelRows(
  window: WindowStats,
  sales: { source: string; cents: number; sales: number }[] | undefined,
): ChannelRow[] {
  const rows = new Map<string, ChannelRow>();
  const row = (source: string) => {
    const name = source || "direct";
    let found = rows.get(name);
    if (!found) {
      found = { source: name, visits: 0, checkouts: 0, free: 0, sales: 0, cents: 0 };
      rows.set(name, found);
    }
    return found;
  };
  for (const s of window.sources ?? []) row(s.name).visits += s.visits;
  for (const s of window.checkoutsBySource ?? []) row(s.name).checkouts += s.visits;
  for (const s of window.freeBySource ?? []) row(s.name).free += s.visits;
  for (const s of sales ?? []) {
    const r = row(s.source);
    r.sales += s.sales;
    r.cents += s.cents;
  }
  return [...rows.values()]
    .filter((r) => r.visits || r.checkouts || r.sales)
    .sort((a, b) => b.cents - a.cents || b.sales - a.sales || b.checkouts - a.checkouts || b.visits - a.visits || a.source.localeCompare(b.source));
}

/** One window's posts: the visits each campaign tag brought, beside the money its sales carried. */
export function postRows(
  window: WindowStats,
  sales: { campaign: string; source: string; sources?: string[]; cents: number; sales: number }[] | undefined,
): StatsData["posts"]["d7"] {
  const rows = new Map<string, StatsData["posts"]["d7"][number]>();
  const unknownChannels = new Set<string>();
  for (const c of window.campaigns ?? []) rows.set(c.name, { campaign: c.name, source: "", visits: c.visits, sales: 0, cents: 0 });
  for (const s of sales ?? []) {
    const row = rows.get(s.campaign) ?? { campaign: s.campaign, source: s.source, visits: 0, sales: 0, cents: 0 };
    if (s.sources === undefined) unknownChannels.add(s.campaign);
    row.sources = unknownChannels.has(s.campaign) ? undefined : [...new Set([...(row.sources ?? []), ...(s.sources ?? [])])].sort();
    row.source = row.sources && row.sources.length > 1 ? "" : row.source || s.source;
    row.sales += s.sales;
    row.cents += s.cents;
    rows.set(s.campaign, row);
  }
  return [...rows.values()].sort((a, b) => b.cents - a.cents || b.sales - a.sales || b.visits - a.visits || a.campaign.localeCompare(b.campaign));
}

/** The short links' results (components/short-links.tsx): each campaign tag's visits, sales and money over the 90 days, added up across channels. */
export function resultsByCampaign(posts: { campaign: string; visits: number; sales: number; cents: number }[]): Record<string, { visits: number; sales: number; cents: number }> {
  // A campaign tag is a visitor's utm_campaign, so it can be "__proto__" or "constructor": added up with no prototype,
  // then handed to the page as an ordinary record, the only kind a Client Component takes (tests/proto-keys.test.ts).
  const sums = posts.reduce<Record<string, { visits: number; sales: number; cents: number }>>((all, row) => {
    const sum = all[row.campaign] ?? { visits: 0, sales: 0, cents: 0 };
    all[row.campaign] = { visits: sum.visits + row.visits, sales: sum.sales + row.sales, cents: sum.cents + row.cents };
    return all;
  }, Object.create(null));
  return { ...sums };
}

/**
 * First sales and the renewals they went on to bring, by channel: what each
 * channel is worth over the 90 days, not only what it sold on the day. A
 * channel with renewals and no first sale in the window still gets its row.
 */
export function withRenewals(
  firsts: { source: string; cents: number; sales: number }[],
  renewals: RenewalsBySource,
): StatsData["revenueBySource"] {
  const rows = new Map<string, StatsData["revenueBySource"][number]>();
  for (const f of firsts) rows.set(f.source, { source: f.source, cents: f.cents, sales: f.sales, renewalCents: 0, renewals: 0 });
  for (const r of renewals) {
    const source = r.source || "direct";
    const row = rows.get(source) ?? { source, cents: 0, sales: 0, renewalCents: 0, renewals: 0 };
    row.renewalCents += r.cents;
    row.renewals += r.payments;
    rows.set(source, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.cents + b.renewalCents - (a.cents + a.renewalCents) || a.source.localeCompare(b.source),
  );
}

/** Visits and sales put together, the shape the studio's panel draws. */
/** Products listed in the numbers when none has any activity yet: the first ones in the store's order. */
const QUIET_PRODUCTS = 50;

/**
 * Which products the numbers are about: every product anybody started a
 * checkout for or bought in any window, and while there is none, the first
 * QUIET_PRODUCTS of the store. Read with readListings and handed to studioStats.
 */
export function productsInStats(store: Store, stats: Stats, sales: SalesStats | null): string[] {
  const active = new Set<string>();
  for (const window of [...Object.values(stats.windows), ...(stats.life ? [stats.life] : [])]) {
    for (const [id, count] of Object.entries(window.checkoutsByProduct)) if (count > 0) active.add(id);
  }
  for (const id of Object.keys(sales?.byProduct ?? {})) active.add(id);
  const ids = productIds(store);
  const named = ids.filter((id) => active.has(id));
  return named.length ? named : ids.slice(0, QUIET_PRODUCTS);
}

export function studioStats(
  store: Store,
  stats: Stats,
  sales: SalesStats | null,
  salesState: StatsData["sales"],
  /** The products to list (productsInStats), read by the caller; the store record's own when not given. */
  listings: Listing[] = recordListings(store),
): StatsData {
  const w: Record<RangeKey, WindowStats> = { ...stats.windows, all: stats.life ?? EMPTY_WINDOW };
  const days = stats.days.map((day) => ({ ...day, sales: sales?.byDay[day.date]?.sales ?? 0 }));
  const zero = { sales: 0, cents: 0 };
  const salesOf = (key: RangeKey) => (key === "all" ? zero : sales?.totals[key] ?? zero);
  const keys: RangeKey[] = ["d7", "d30", "d90", "all"];
  const per = <T,>(pick: (key: RangeKey) => T) => Object.fromEntries(keys.map((k) => [k, pick(k)])) as Record<RangeKey, T>;
  const ownCurrency = (rows: { source: string; currency: string; cents: number; sales: number }[] | undefined) =>
    rows?.filter((r) => r.currency === store.currency);
  const titles = new Map(listings.map((l) => [l.id, l.title]));
  return {
    days,
    totals: per((k) => ({ visitors: w[k].visitors, views: w[k].views, checkouts: w[k].checkouts, ...salesOf(k) })),
    sources: per((k) => w[k].sources),
    mediums: per((k) => w[k].mediums),
    campaigns: per((k) => w[k].campaigns),
    products: listings.map((product) => ({
      id: product.id,
      title: product.title,
      ...per((k) => {
        const s = k === "all" ? zero : sales?.byProduct[product.id]?.[k] ?? zero;
        // Page views are kept by the day only (recordHit): no all-time figure, rather than a wrong one.
        return { views: k === "all" ? -1 : w[k].viewsByProduct[product.id] ?? 0, checkouts: w[k].checkoutsByProduct[product.id] ?? 0, sales: s.sales, cents: s.cents };
      }),
    })),
    links: store.links.filter((link) => !link.header).map((link) => ({ id: link.id, title: link.title, ...per((k) => w[k].linkClicks[link.id] ?? 0) })),
    sales: salesState,
    partial: sales?.partial ?? false,
    currency: store.currency,
    elsewhere: sales?.elsewhere ?? 0,
    since: stats.life?.since ?? "",
    revenueBySource: withRenewals(
      (sales?.bySource ?? []).filter((row) => row.currency === store.currency),
      sales?.renewals?.bySource ?? [],
    ),
    channels: {
      d7: channelRows(w.d7, ownCurrency(sales?.bySourceIn?.d7)),
      d30: channelRows(w.d30, ownCurrency(sales?.bySourceIn?.d30)),
      d90: channelRows(w.d90, ownCurrency(sales?.bySourceIn?.d90 ?? sales?.bySource)),
    },
    posts: {
      d7: postRows(w.d7, sales?.byCampaignIn?.d7),
      d30: postRows(w.d30, sales?.byCampaignIn?.d30),
      d90: postRows(w.d90, sales?.byCampaignIn?.d90),
    },
    countries: per((k) => (k === "all" ? [] : w[k].countries ?? [])),
    devices: per((k) => (k === "all" ? [] : w[k].devices ?? [])),
    firstBySource: (sales?.firstBySource ?? [])
      .filter((row) => row.currency === store.currency)
      .map(({ source, cents, sales: n }) => ({ source, cents, sales: n })),
    // The days of renewals by channel are in channelDays already; not sent twice.
    renewals: sales?.renewals
      ? { d7: sales.renewals.d7, d30: sales.renewals.d30, d90: sales.renewals.d90, partial: sales.renewals.partial }
      : null,
    previousTrafficAvailable: Object.fromEntries(
      (["d7", "d30", "d90"] as const).map(k => [k, stats.previous?.[k] != null && stats.previousTrafficAvailable?.[k] !== false]),
    ) as NonNullable<StatsData["previousTrafficAvailable"]>,
    previous: Object.fromEntries(
      (["d7", "d30", "d90"] as const).map((k) => {
        const visits = stats.previous?.[k] ?? { visitors: 0, views: 0, checkouts: 0 };
        const sold = sales?.previous?.[k] ?? null;
        return [k, { ...visits, sales: sold ? sold.sales : null, cents: sold ? sold.cents : null }];
      }),
    ) as StatsData["previous"],
    heard: Object.fromEntries(
      (["d7", "d30", "d90"] as const).map((k) => [
        k,
        Object.entries(w[k].heard ?? {})
          .map(([answer, v]) => ({ answer, ...v }))
          .filter((row) => row.buyers > 0)
          .sort((a, b) => b.buyers - a.buyers || b.cents - a.cents || a.answer.localeCompare(b.answer)),
      ]),
    ) as StatsData["heard"],
    attribution: Object.fromEntries(
      (["d7", "d30", "d90"] as const).map((k) => [
        k,
        attributionTable(
          sales?.attributionIn?.[k].last ?? [],
          sales?.attributionIn?.[k]?.first,
          Object.entries(w[k].heard ?? {}).map(([answer, v]) => ({ answer, ...v })),
        ),
      ]),
    ) as StatsData["attribution"],
    attributionDays: store.attributionDays,
    searchMisses: { d7: w.d7.searchMisses ?? [], d30: w.d30.searchMisses ?? [], d90: w.d90.searchMisses ?? [] },
    ads: sales?.byContentIn ?? { d7: [], d30: [], d90: [] },
    salesCountries: sales?.byCountryIn ?? { d7: [], d30: [], d90: [] },
    taxCollected: sales?.taxIn ?? null,
    refunds: sales?.refundsIn ?? null,
    refundsByProduct: sales?.refundsByProduct ?? {},
    takenBackElsewhere: sales?.takenBackElsewhere ?? null,
    disputes: sales?.disputesIn ?? null,
    disputesComplete: sales?.disputesComplete ?? false,
    kept: sales?.keptIn ?? null,
    paypalDisputesUnread: sales?.paypalDisputesUnread ?? false,
    channelDays: sales?.channelDays ?? {},
    refundDays: sales?.refundDays ?? null,
    buyers: sales?.buyers ? { d7: sales.buyers.d7, d30: sales.buyers.d30, d90: sales.buyers.d90 } : null,
    buyerChannels: sales?.buyerChannels ?? null,
    cashflowComplete: sales?.cashflowComplete ?? false,
    paymentsComplete: sales?.paymentsComplete,
    discounts: sales?.discounts ?? null,
    hours: sales?.hours ?? null,
    reach: {
      d7: reachItems(store, w.d7.reach ?? {}, titles),
      d30: reachItems(store, w.d30.reach ?? {}, titles),
      d90: reachItems(store, w.d90.reach ?? {}, titles),
    },
  };
}

// ---- Files to take away -------------------------------------------------------

/**
 * One spreadsheet cell: quoted always, and a leading character a spreadsheet
 * would read as a formula defused, because a product name or a buyer's name
 * is text somebody else typed and must never run on the creator's computer.
 */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvRow(values: (string | number)[]): string {
  return values.map(csvCell).join(",");
}


/** The most pages of a hundred read for a sales file. */
export const EXPORT_PAGES = 50;

/**
 * The store's sales as CSV, newest first: every paid checkout and one-click
 * extra since `sinceSeconds` (0 for all), up to EXPORT_PAGES pages of each.
 */
export async function salesCsv(store: Store, sinceSeconds: number): Promise<{ csv: string; rows: number; partial: boolean }> {
  const { sales, partial } = await readPaidSales(store, sinceSeconds, EXPORT_PAGES);
  const find = listingFinder(store);
  const title = async (id: string, fallback: unknown) => (await find(id))?.title ?? (typeof fallback === "string" ? fallback : "");
  const lines = [
    csvRow(["paid_at_utc", "stripe_id", "product_id", "product", "price_option", "order_bump", "kind", "amount", "discount", "tax", "currency", "buyer_email", "buyer_name", "buyer_country", "paid_with"]),
  ];
  for (const sale of sales) {
    const row = sale.row;
    const meta = (row.metadata ?? {}) as Record<string, string>;
    const details = (row.customer_details ?? {}) as { email?: unknown; name?: unknown; address?: { country?: unknown } | null };
    const totals = (row.total_details ?? {}) as { amount_discount?: unknown; amount_tax?: unknown };
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    // An amount Stripe's record does not give as whole cents is left blank, never written as 0.00 (601 [KB22] U4).
    const amount = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? plainAmount(v, sale.currency) : "");
    const product = await find(sale.product);
    const option = product?.options.find((o) => o.id === meta.option)?.label ?? meta.option ?? "";
    const kind = sale.upsell
      ? "upsell"
      : meta.kind === "tip"
        ? "support"
      : meta.kind === "call"
        ? "call"
        : meta.kind === "plan"
          ? "payment_plan"
          : row.mode === "subscription"
            ? "membership"
            : "one_time";
    lines.push(
      csvRow([
        new Date(sale.created).toISOString().replace(/\.\d{3}Z$/, "Z"),
        text(row.id),
        sale.product,
        await title(sale.product, meta.title),
        option,
        (await Promise.all(bumpsFromMeta(meta).map((added) => title(added.id, "")))).filter(Boolean).join(" + "),
        kind,
        plainAmount(sale.cents, sale.currency),
        // A one-click extra is a bare payment: no coupon and no tax calculation (lib/upsell.ts), so both are a known zero.
        sale.upsell ? plainAmount(0, sale.currency) : amount(totals.amount_discount),
        sale.upsell ? plainAmount(0, sale.currency) : amount(totals.amount_tax),
        sale.currency.toUpperCase(),
        text(details.email) || text(row.customer_email) || text(row.receipt_email),
        text(details.name),
        text(details.address?.country),
        meta.paid_with === "paypal" ? "paypal" : "stripe",
      ]),
    );
  }
  return { csv: `${lines.join("\r\n")}\r\n`, rows: sales.length, partial };
}

/** Every kept day of visits as CSV, newest first. */
export async function visitsCsv(store: Store, now = Date.now()): Promise<string> {
  const lines = [csvRow(["date_utc", "visitors", "page_views", "checkouts_started", "link_opens", "top_source"])];
  if (!store.statsId || !isRedisConfigured()) return `${lines.join("\r\n")}\r\n`;
  const statsId = store.statsId;
  const created = /^\d{4}-\d{2}-\d{2}/.test(store.createdAt) ? store.createdAt.slice(0, 10) : "";
  const dates = lastDays(now, KEPT_DAYS).filter((d) => !created || d >= created);
  const replies = await redisPipeline([
    ...dates.map((d) => ["HGETALL", countsKey(statsId, d)]),
    ...dates.map((d) => ["PFCOUNT", visitorsKey(statsId, d)]),
  ]);
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    let views = 0;
    let checkouts = 0;
    let links = 0;
    let top = ["", 0] as [string, number];
    for (const [field, count] of pairs(replies[i])) {
      if (field === "v") views = count;
      else if (field === "c") checkouts = count;
      else if (field.startsWith("l:")) links += count;
      else if (field.startsWith("r:") && count > top[1]) top = [field.slice(2), count];
    }
    lines.push(csvRow([dates[i], Number(replies[dates.length + i]) || 0, views, checkouts, links, top[0]]));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Where visits came from, by source, medium and campaign, for each window, as CSV. */
export function sourcesCsv(data: StatsData): string {
  const lines = [csvRow(["kind", "name", "visits_7_days", "visits_30_days", "visits_90_days", "visits_all_time"])];
  for (const [kind, table] of [["source", data.sources], ["medium", data.mediums], ["campaign", data.campaigns]] as const) {
    const names = new Set<string>();
    for (const key of ["d7", "d30", "d90", "all"] as const) for (const row of table[key]) names.add(row.name);
    const count = (key: RangeKey, name: string) => table[key].find((row) => row.name === name)?.visits ?? 0;
    for (const name of [...names].sort((a, b) => count("all", b) - count("all", a) || count("d90", b) - count("d90", a))) {
      lines.push(csvRow([kind, name, count("d7", name), count("d30", name), count("d90", name), count("all", name)]));
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}
