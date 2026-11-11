/**
 * A capped count gives the hash it creates its expiry in the same script (lib/capped-count.ts, version 3; Codex C2's
 * review of #3649 and Claude 1's of #3676, 11 November 2026).
 *
 * The defect: the day's record (lib/stats.ts) was counted by the script and given its expiry by a separate EXPIRE,
 * in the same pipeline (countSearchMiss, countHeard) or a later one (recordHit's follow-up). An Upstash pipeline is not
 * atomic (https://upstash.com/docs/redis/features/restapi, Pipelining, read 11 November 2026): a request cut after
 * the count and before the EXPIRE left the record with no expiry, kept for good, and every later hit of the day read
 * the count past 1 and never sent it again. Now a hash given an expiry (`ttl`) gets it inside the script that creates
 * it, so the count and the expiry are written together or not at all. Billed one command more, only on the write that
 * creates the hash; a hash already there keeps its expiry as it was.
 */
import { cappedCount, cappedCountCommand } from "@/lib/capped-count";
import { countSearchMiss, recordHit } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);
type Pipe = typeof real;
const ttl = async (key: string) => Number((await real([["TTL", key]]))[0]);
/** Runs only the first command of the next pipeline, then fails, as a request cut after its first write. */
function cutAfterFirst(): void {
  redis.pipeline = (async (commands: Parameters<Pipe>[0]) => {
    redis.pipeline = real;
    await real(commands.slice(0, 1));
    throw new Error("synthetic: the request was cut after its first command");
  }) as Pipe;
}

const STATS = "c".repeat(32);
const NOW = Date.UTC(2026, 10, 11, 3, 0, 0);
const DAY_KEY = `nl:stats:${STATS}:2026-11-11`;
const KEPT = 400 * 86_400;
const kept = (left: number) => left > 0 && left <= KEPT;

async function main(): Promise<void> {
  part("The script gives the hash it creates its expiry");
  redis.clear();
  const [made] = await real([cappedCountCommand([{ key: "nl:test:cct", most: 5, ttl: 600 }], [{ hash: 0, field: "a", by: 1 }])]);
  is("the count is answered as before", made, [1]);
  const first = await ttl("nl:test:cct");
  is("the new hash expires", first > 0 && first <= 600, true);
  await real([["EXPIRE", "nl:test:cct", 50]]);
  await real([cappedCountCommand([{ key: "nl:test:cct", most: 5, ttl: 600 }], [{ hash: 0, field: "a", by: 1 }])]);
  const after = await ttl("nl:test:cct");
  is("a hash already there keeps its expiry as it was", after > 0 && after <= 50, true);
  is("cappedCount takes the expiry too", [await cappedCount("nl:test:cct2", 5, [{ field: "x", by: 2 }], 90), (await ttl("nl:test:cct2")) > 0], [[2], true]);
  await real([cappedCountCommand([{ key: "nl:test:cct3", most: 5 }], [{ hash: 0, field: "a", by: 1 }])]);
  is("without an expiry, nothing changes: the hash has none", await ttl("nl:test:cct3"), -1);

  part("Billed one command more, only on the write that creates the hash");
  redis.clear();
  let before = redis.scriptCalls;
  await real([cappedCountCommand([{ key: "nl:test:bill", most: 5, ttl: 600 }], [{ hash: 0, field: "a", by: 1 }])]);
  is("creating: HLEN, HINCRBY and EXPIRE", redis.scriptCalls - before, 3);
  before = redis.scriptCalls;
  await real([cappedCountCommand([{ key: "nl:test:bill", most: 5, ttl: 600 }], [{ hash: 0, field: "a", by: 1 }])]);
  is("already there: HLEN and HINCRBY, as before", redis.scriptCalls - before, 2);

  part("An expiry that does not read is refused, and nothing is written");
  redis.clear();
  for (const most of ["5:0", "5:x", "5:", ":5", "5:1.5", "0:60"]) {
    const refused = await real([["EVAL", cappedCountCommand([{ key: "nl:test:bad", most: 1 }], [])[1], 1, "nl:test:bad", most, 1, "a", 1]]).then(
      () => false,
      () => true,
    );
    is(`most "${most}" is refused`, refused, true);
  }
  is("(nothing was written)", (await real([["EXISTS", "nl:test:bad"]]))[0], 0);

  part("A search that found nothing, its request cut after the count: the day's record still expires");
  redis.clear();
  cutAfterFirst();
  await countSearchMiss(STATS, ["sourdough"], NOW);
  is("the words were counted", (await real([["HGET", DAY_KEY, "q:sourdough"]]))[0], "1");
  is("the day's record expires", kept(await ttl(DAY_KEY)), true);

  part("A day's first view whose follow-up request is lost: the day's record still expires");
  redis.clear();
  const store = { statsId: STATS, handle: "harbor" } as unknown as Store;
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  let calls = 0;
  redis.pipeline = (async (commands: Parameters<Pipe>[0]) => {
    calls += 1;
    if (calls === 2) throw new Error("synthetic: the follow-up request was lost");
    return real(commands);
  }) as Pipe;
  await recordHit(store, { kind: "view", ip: "203.0.113.7", userAgent: UA, source: "direct" }, NOW).catch(() => null);
  redis.pipeline = real;
  is("the view was counted", (await real([["HGET", DAY_KEY, "v"]]))[0], "1");
  is("the day's record expires", kept(await ttl(DAY_KEY)), true);
  await recordHit(store, { kind: "view", ip: "203.0.113.8", userAgent: UA, source: "direct" }, NOW + 1000);
  is("and still does after the next view", kept(await ttl(DAY_KEY)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
