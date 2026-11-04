/**
 * Where the samples of stores' rates are kept, and the ranges made from them
 * (lib/benchmark-rules.ts says what they are). A store's sample is written
 * when its numbers are read anyway — the studio's page, the weekly email —
 * never on a visit to the store; the ranges are worked out once a day from
 * the last two weeks' samples, and the studio only reads that one record.
 *
 * What a sample holds: the store's band and four rates, with nothing that
 * names the store but the field it is kept under, which is the store's
 * counter id and never shown. What anyone is shown is a band's middle half
 * and median, made from at least MIN_STORES stores. The demo store and a
 * suspended store are never in it.
 *
 *   nl:bench:s:<monday>   hash: <statsId> → the store's sample that week, three weeks
 *   nl:bench:ranges       the ranges, a month
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countGap } from "@/lib/traffic";
import { type Ranges, type Sample, parseSample, rangesFrom, sampleFrom } from "@/lib/benchmark-rules";
import { isHouseStore } from "@/lib/house-store";
import type { Store } from "@/lib/store";
import type { StatsData } from "@/lib/stats";

const SAMPLE_SECONDS = 21 * 86_400;
const RANGES_SECONDS = 30 * 86_400;
const RANGES_KEY = "nl:bench:ranges";
const weekKey = (monday: string) => `nl:bench:s:${monday}`;

/** The Monday (UTC) of the week `now` is in. */
export function mondayOf(now: number): string {
  const day = new Date(now);
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** Keeps a store's rates for this week, or marks it out when it no longer qualifies. Never throws. */
export async function recordSample(store: Pick<Store, "statsId" | "email" | "suspended" | "handle" | "previousHandles" | "releasedHandles">, data: StatsData | null, now = Date.now()): Promise<void> {
  if (!store.statsId || !data || !isRedisConfigured()) return;
  const key = weekKey(mondayOf(now));
  const sample = store.suspended || isHouseStore(store) ? null : sampleFrom(data, await visitsWhole(store, now));
  // "{}" when it no longer qualifies, so last week's sample of it is not used either.
  await redisPipeline([["HSET", key, store.statsId, sample ? JSON.stringify(sample) : "{}"], ["EXPIRE", key, SAMPLE_SECONDS]]).catch(() => {});
}

export type KeptRanges = { at: number; stores: number; ranges: Ranges };

/** Works the ranges out again from this week's and last week's samples, a store's latest one each. */
export async function refreshRanges(now = Date.now()): Promise<KeptRanges | null> {
  if (!isRedisConfigured()) return null;
  const thisWeek = mondayOf(now);
  const lastWeek = mondayOf(now - 7 * 86_400_000);
  const [last, current] = await redisPipeline([["HGETALL", weekKey(lastWeek)], ["HGETALL", weekKey(thisWeek)]]);
  const latest = new Map<string, Sample>();
  for (const flat of [last, current]) {
    const list = Array.isArray(flat) ? (flat as unknown[]).map(String) : [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      const sample = parseSample(list[i + 1]);
      // A later week's word wins, "no longer qualifies" included.
      if (sample) latest.set(list[i], sample);
      else latest.delete(list[i]);
    }
  }
  const kept: KeptRanges = { at: Math.floor(now / 1000), stores: latest.size, ranges: rangesFrom([...latest.values()]) };
  await redisPipeline([["SET", RANGES_KEY, JSON.stringify(kept), "EX", RANGES_SECONDS]]);
  return kept;
}

/** The ranges kept, or null before the first day's. */
export async function readRanges(): Promise<KeptRanges | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", RANGES_KEY]]);
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as KeptRanges;
    return v && typeof v.ranges === "object" ? v : null;
  } catch {
    return null;
  }
}

/** Whether every visit of the last 90 days was counted (lib/traffic.ts, countGap): an unreadable record is not. */
export async function visitsWhole(store: Pick<Store, "handle" | "previousHandles" | "releasedHandles">, now = Date.now()): Promise<boolean> {
  const gap = await countGap(store).catch(() => "unknown" as const);
  return gap === null || (gap !== "unknown" && gap.last < now - 90 * 86_400_000);
}
