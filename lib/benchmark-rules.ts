/**
 * How a store's numbers sit beside those of stores its size (added 13
 * October 2026). Pure, so the weekly sample, the daily ranges, the studio and
 * the tests read them the same way; kept by lib/benchmarks.ts.
 *
 * Read before it was built: Baremetrics' Benchmarks, ChartMogul's and
 * ProfitWell's, Triple Whale's and Polar's, and GA4's: a figure is set beside
 * the middle half of businesses like it, never beside a named one.
 *
 * Four rates, over the last 90 days, each one a store's own:
 *
 *   - visits that became a sale (sales / visitors);
 *   - checkouts that were paid (sales / checkouts);
 *   - sales refunded (refunds / sales);
 *   - buyers who had bought before (returning / buyers).
 *
 * Stores are put in a band by their visitors in those 90 days, so a store of
 * five hundred visits is set beside others of its size and not beside one of
 * fifty thousand. A store's rate is used only once its own counts are big
 * enough to mean something (MIN_VISITORS, MIN_SALES, MIN_BUYERS), and a band
 * shows a range only once MIN_STORES stores in it have that rate: below that
 * a range would say more about one store than about stores, and could let
 * someone guess at one. What is shown is the middle half (the 25th to the
 * 75th percentile) and the median, never a single store's figure.
 */
import type { StatsData } from "@/lib/stats";

export type Metric = "converted" | "paid" | "refunded" | "returning";
export const METRICS: Metric[] = ["converted", "paid", "refunded", "returning"];

export const METRIC_NAMES: Record<Metric, string> = {
  converted: "Visits that became a sale",
  paid: "Checkouts that were paid",
  refunded: "Sales refunded",
  returning: "Buyers who had bought before",
};

/** Whether more is better: a refund rate is the one where less is. */
export const HIGHER_IS_BETTER: Record<Metric, boolean> = { converted: true, paid: true, refunded: false, returning: true };

export type Band = "a" | "b" | "c";
/** Visitors over 90 days: from 300, from 3,000, from 30,000. */
export const BANDS: { band: Band; from: number; label: string }[] = [
  { band: "a", from: 300, label: "300 to 2,999 visitors in 90 days" },
  { band: "b", from: 3_000, label: "3,000 to 29,999 visitors in 90 days" },
  { band: "c", from: 30_000, label: "30,000 visitors or more in 90 days" },
];

export const MIN_VISITORS = 300;
/** Sales a store needs for its paid and refund rates to count. */
export const MIN_SALES = 10;
/** Checkouts a store needs for its paid rate to count. */
export const MIN_CHECKOUTS = 10;
/** Buyers a store needs for its returning rate to count. */
export const MIN_BUYERS = 10;
/** Stores a band needs before a range is shown for a rate. */
export const MIN_STORES = 10;

export type Sample = { band: Band } & Partial<Record<Metric, number>>;

export function bandOf(visitors: number): Band | null {
  let found: Band | null = null;
  for (const b of BANDS) if (visitors >= b.from) found = b.band;
  return found;
}

const rate = (part: number, whole: number) => Math.round((part / whole) * 10_000) / 10_000;

/**
 * A store's own rates from its numbers, or null when it is too small to be
 * set beside others, or its sales were not read in full.
 */
export function sampleFrom(data: StatsData, visitsWhole = true): Sample | null {
  if (data.sales !== "ok" || data.partial) return null;
  const t = data.totals.d90;
  const band = bandOf(t.visitors);
  if (!band) return null;
  // Visits that became a sale only from visits all counted over the 90 days (lib/traffic.ts, countGap): neither shown nor set beside others otherwise.
  const sample: Sample = { band, ...(visitsWhole ? { converted: rate(Math.min(t.sales, t.visitors), t.visitors) } : {}) };
  if (t.checkouts >= MIN_CHECKOUTS) sample.paid = rate(Math.min(t.sales, t.checkouts), t.checkouts);
  const refunds = data.refunds ? data.refunds.d90.reduce((sum, r) => sum + r.refunds, 0) : null;
  if (refunds !== null && t.sales >= MIN_SALES) sample.refunded = rate(Math.min(refunds, t.sales), t.sales);
  const buyers = data.buyers?.d90;
  if (buyers && buyers.buyers >= MIN_BUYERS) sample.returning = rate(Math.min(buyers.returning, buyers.buyers), buyers.buyers);
  return sample;
}

/** A sample read back from where it was kept: only a whole one. */
export function parseSample(raw: unknown): Sample | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!BANDS.some((b) => b.band === v.band)) return null;
    const out: Sample = { band: v.band as Band };
    for (const m of METRICS) {
      const n = Number(v[m]);
      if (v[m] !== undefined && Number.isFinite(n) && n >= 0 && n <= 1) out[m] = n;
    }
    return out;
  } catch {
    return null;
  }
}

/** The value at a share of the way through sorted values, read between neighbors. */
export function percentile(sorted: number[], share: number): number {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * share;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return Math.round((sorted[low] + (sorted[high] - sorted[low]) * (at - low)) * 10_000) / 10_000;
}

export type Range = { low: number; median: number; high: number; stores: number };
export type Ranges = Partial<Record<Band, Partial<Record<Metric, Range>>>>;

/** Each band's range for each rate, only where MIN_STORES stores have it. */
export function rangesFrom(samples: Sample[]): Ranges {
  const out: Ranges = {};
  for (const { band } of BANDS) {
    const mine = samples.filter((s) => s.band === band);
    for (const m of METRICS) {
      const values = mine.map((s) => s[m]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      if (values.length < MIN_STORES) continue;
      (out[band] ??= {})[m] = { low: percentile(values, 0.25), median: percentile(values, 0.5), high: percentile(values, 0.75), stores: values.length };
    }
  }
  return out;
}

export type Place = "above" | "within" | "below";

/** Where a store's rate sits: above the middle half, within it, or below it. */
export function placeOf(value: number, range: Range): Place {
  return value > range.high ? "above" : value < range.low ? "below" : "within";
}

export type Comparison = { metric: Metric; yours: number; range: Range; place: Place; better: boolean | null };

/** A store's rates beside its band's ranges: only the rates both have. */
export function compare(sample: Sample | null, ranges: Ranges | null): { band: Band; rows: Comparison[] } | null {
  if (!sample || !ranges) return null;
  const band = ranges[sample.band];
  if (!band) return null;
  const rows: Comparison[] = [];
  for (const m of METRICS) {
    const range = band[m];
    const yours = sample[m];
    if (!range || typeof yours !== "number") continue;
    const place = placeOf(yours, range);
    rows.push({ metric: m, yours, range, place, better: place === "within" ? null : (place === "above") === HIGHER_IS_BETTER[m] });
  }
  return rows.length ? { band: sample.band, rows } : null;
}
