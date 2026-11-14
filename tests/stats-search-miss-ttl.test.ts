/**
 * A search of the store that found nothing keeps the day's record only as long as every other day's
 * (lib/stats.ts, countSearchMiss; rule 24 sweep of Claude 4, cloud F, 11 November 2026).
 *
 * The defect: the count of the words was written alone, and the day's expiry was left to the day's first
 * counted view. On a day with no counted view (a visitor whose beacon never arrived, or a crawler asking
 * `?q=` of a quiet store), the search was the record's first write and the record was kept for good: one
 * hash a store a day, never expiring. The expiry now goes with the count, in the same request.
 */
import { countSearchMiss } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "f".repeat(32);
const NOW = Date.UTC(2026, 10, 11, 3, 0, 0);
const KEY = `nl:stats:${STATS}:2026-11-11`;
const KEPT_SECONDS = 400 * 86_400;

async function ttl(): Promise<number> {
  const [left] = await redis.pipeline([["TTL", KEY]]);
  return Number(left);
}

async function main(): Promise<void> {
  part("A day whose first write is a search that found nothing");
  redis.clear();
  await countSearchMiss(STATS, ["sourdough", "starter"], NOW);
  const [count] = await redis.pipeline([["HGET", KEY, "q:sourdough starter"]]);
  is("the words are counted on the day's record", count, "1");
  const left = await ttl();
  is("the day's record is kept as long as any day's, not for good", left > 0 && left <= KEPT_SECONDS, true);

  part("A later search the same day keeps the same expiry");
  await countSearchMiss(STATS, ["rye"], NOW + 60_000);
  const later = await ttl();
  is("still expires, within the kept days", later > 0 && later <= KEPT_SECONDS, true);

  part("Nothing searched: nothing written");
  redis.clear();
  await countSearchMiss(STATS, ["   "], NOW);
  const [exists] = await redis.pipeline([["EXISTS", KEY]]);
  is("no record is made for empty words", exists, 0);

  done();
}

main();
