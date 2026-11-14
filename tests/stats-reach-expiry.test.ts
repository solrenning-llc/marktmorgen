/**
 * A store page's reading counted on a day with no view yet (its token is good for two hours, so a page shown at
 * 23:30 UTC may be read at 00:30) gives the day's record its expiry, never a record kept for good (Claude 5's second
 * review of #2571, the MEDIUM in main that this PR feeds). Synthetic records (MemoryRedis); no outside request.
 */
import { countReach } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const at = Date.parse("2026-11-08T00:30:00Z");
  part("A reading on a day with no view");
  await countReach("statsc5000002", "sr:3:p:prod000001:", at);
  const [ttl, held] = (await redis.pipeline([["TTL", "nl:stats:statsc5000002:2026-11-08"], ["HLEN", "nl:stats:statsc5000002:2026-11-08"]])) as number[];
  is("(the reading was counted on the day's record)", held > 0, true);
  is("the day's record has its expiry", ttl > 0, true);
  done();
}
void main();
