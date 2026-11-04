/**
 * A store's rates beside stores its size (lib/benchmark-rules.ts,
 * lib/benchmarks.ts; added 13 October 2026). Checked:
 *
 *   - a store's four rates over 90 days, each only once its own counts mean
 *     something, and its size band by visitors;
 *   - a band shows a range for a rate only from 10 stores, as its middle
 *     half and median;
 *   - where a store sits, with fewer refunds counted as the better side;
 *   - samples kept by the week, the latest of each store used, the demo
 *     store and suspended ones never in them.
 */
import { MIN_STORES, bandOf, compare, parseSample, percentile, rangesFrom, sampleFrom, type Sample } from "@/lib/benchmark-rules";
import { mondayOf, readRanges, recordSample, refreshRanges } from "@/lib/benchmarks";
import { HOUSE_OWNER } from "@/lib/house-store";
import type { StatsData } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const data = (visitors: number, checkouts: number, sales: number, refunds: number, buyers: number, returning: number, extra: Partial<StatsData> = {}) =>
  ({
    sales: "ok",
    partial: false,
    totals: { d90: { visitors, views: visitors * 2, checkouts, sales, cents: sales * 2000 } },
    refunds: { d7: [], d30: [], d90: [{ source: "", refunds, cents: refunds * 2000 }] },
    buyers: { d90: { buyers, orders: sales, cents: sales * 2000, returning, repeat: 0 } },
    ...extra,
  }) as unknown as StatsData;

async function main(): Promise<void> {
  redis.clear();

  part("A store's own rates");
  is("bands by visitors in 90 days", [bandOf(299), bandOf(300), bandOf(2_999), bandOf(3_000), bandOf(30_000)], [null, "a", "a", "b", "c"]);
  is("the four rates", sampleFrom(data(1_000, 50, 20, 2, 18, 6)), { band: "a", converted: 0.02, paid: 0.4, refunded: 0.1, returning: 0.3333 });
  is("too few visitors: nothing", sampleFrom(data(200, 50, 20, 0, 20, 5)), null);
  is("too few checkouts, sales or buyers: only the rates that mean something", sampleFrom(data(1_000, 5, 3, 1, 3, 1)), { band: "a", converted: 0.003 });
  is("sales not read in full: nothing", [sampleFrom(data(1_000, 50, 20, 2, 18, 6, { partial: true })), sampleFrom(data(1_000, 50, 20, 2, 18, 6, { sales: "error" }))], [null, null]);
  is("read back whole only", [parseSample(JSON.stringify({ band: "b", converted: 0.5, paid: 7 })), parseSample("{"), parseSample(JSON.stringify({ band: "z" }))], [{ band: "b", converted: 0.5 }, null, null]);

  part("Ranges from stores, never from too few");
  is("percentiles read between neighbors", [percentile([1, 2, 3, 4], 0.25), percentile([1, 2, 3, 4], 0.5), percentile([5], 0.75)], [1.75, 2.5, 5]);
  const many: Sample[] = Array.from({ length: MIN_STORES }, (_, i) => ({ band: "a", converted: (i + 1) / 100, refunded: (i + 1) / 100 }));
  is("nine stores are not enough", rangesFrom(many.slice(0, MIN_STORES - 1)), {});
  const ranges = rangesFrom([...many, { band: "b", converted: 0.5 }]);
  is("ten are: the middle half and the median, and the band with one store has none", [ranges.a?.converted, ranges.b], [{ low: 0.0325, median: 0.055, high: 0.0775, stores: 10 }, undefined]);

  part("Where a store sits");
  const beside = compare({ band: "a", converted: 0.09, refunded: 0.09, paid: 0.5 }, ranges);
  is("above the middle half on sales is better; above it on refunds is not; a rate with no range is left out", beside?.rows.map((r) => [r.metric, r.place, r.better]), [["converted", "above", true], ["refunded", "above", false]]);
  is("within it is neither", compare({ band: "a", converted: 0.05 }, ranges)?.rows[0].better, null);
  is("a band with no ranges shows nothing", compare({ band: "c", converted: 0.05 }, ranges), null);

  part("Samples kept by the week");
  is("weeks start on Monday", [mondayOf(Date.UTC(2026, 9, 13)), mondayOf(Date.UTC(2026, 9, 12)), mondayOf(Date.UTC(2026, 9, 18, 23))], ["2026-10-12", "2026-10-12", "2026-10-12"]);
  const NOW = Date.UTC(2026, 9, 14, 12);
  for (let i = 0; i < MIN_STORES; i += 1) {
    await recordSample({ statsId: `store${i}`, email: `o${i}@example.com`, suspended: "", handle: `h-${`store${i}`}`, previousHandles: [], releasedHandles: [] }, data(1_000, 50, 10 + i, 1, 12, 3), NOW - 7 * 86_400_000);
  }
  // One store's numbers changed this week: its latest sample is the one used.
  await recordSample({ statsId: "store0", email: "o0@example.com", suspended: "", handle: `h-${"store0"}`, previousHandles: [], releasedHandles: [] }, data(1_000, 50, 40, 1, 12, 3), NOW);
  await recordSample({ statsId: "demo", email: HOUSE_OWNER, suspended: "", handle: `h-${"demo"}`, previousHandles: [], releasedHandles: [] }, data(1_000, 50, 50, 0, 20, 10), NOW);
  await recordSample({ statsId: "gone", email: "x@example.com", suspended: "2026-10-01", handle: `h-${"gone"}`, previousHandles: [], releasedHandles: [] }, data(1_000, 50, 50, 0, 20, 10), NOW);
  const kept = await refreshRanges(NOW);
  is("ten stores, a store's latest sample each, the demo and the suspended left out", kept?.stores, MIN_STORES);
  is("the range uses this week's figure for the store that changed", (await readRanges())?.ranges.a?.converted?.high, percentile([0.011, 0.012, 0.013, 0.014, 0.015, 0.016, 0.017, 0.018, 0.019, 0.04], 0.75));
  await recordSample({ statsId: "store0", email: "o0@example.com", suspended: "", handle: `h-${"store0"}`, previousHandles: [], releasedHandles: [] }, data(100, 5, 1, 0, 1, 0), NOW);
  const after = await refreshRanges(NOW);
  is("a store that no longer qualifies is taken out, last week's sample of it too, and nine stores show no range", [after?.stores, after?.ranges.a], [MIN_STORES - 1, undefined]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
