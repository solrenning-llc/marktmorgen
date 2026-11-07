/**
 * Every day record a count creates is given its expiry in the same request
 * (added 7 November 2026, found in the review of #2571).
 *
 * A day's numbers (lib/stats.ts, nl:stats:<statsId>:<day>) are kept
 * KEPT_DAYS and then let go. Three ways of counting into them created the
 * day's record without that expiry, so a record made that way was kept for
 * ever and what the database held grew without a figure:
 *   - how the store's page was read (countReach) and a search that found
 *     nothing (countSearchMiss) never wrote it at all: one of them arriving
 *     after midnight UTC, before the day's first view, made the day's record
 *     with no expiry, and a day with no view never got one;
 *   - a product page's count and a view wrote it only when the count's own
 *     answer said this was the day's first, in a second request: when the
 *     count was applied but its answer was lost, or the second request
 *     failed, the record kept no expiry. The same for the day's visitors.
 * The count (lib/capped-count.ts) now gives a hash it creates its expiry
 * inside the same script, so the record and its expiry are one write; the
 * day's visitors get theirs even when the answer is not known.
 */
import { cappedCount } from "@/lib/capped-count";
import { DAY_FIELDS_MAX, countReach, countSearchMiss, recordHit } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const KEPT = 400 * 86400;
const real = redis.pipeline.bind(redis);
let lose: ((list: (string | number)[][]) => boolean) | null = null;
let sent: (string | number)[][][] = [];
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
  sent.push(list);
  const out = await real(list);
  if (lose && lose(list)) throw new Error("timeout after the write");
  return out;
}) as typeof redis.pipeline;

const ttl = (key: string) => Number(redis.run(["TTL", key]));
const exists = (key: string) => Number(redis.run(["EXISTS", key]));
/** Kept about as long as a day's record is: KEPT_DAYS, not for ever and not a moment. */
const keptAsADay = (key: string) => ttl(key) > KEPT - 60 && ttl(key) <= KEPT;
const shop = (statsId: string) => ({ handle: "ttl", statsId }) as unknown as Store;
const AFTER_MIDNIGHT = Date.UTC(2026, 10, 8, 0, 30);
const DAY = "2026-11-08";
const first = (list: (string | number)[][]) => list.length > 0 && list[0][0] === "EVAL";

async function main(): Promise<void> {
  part("A reading of the store's page on a day with no view yet");
  redis.clear();
  await countReach("statsttl00001", "sr:0:prod000001:", AFTER_MIDNIGHT);
  const read = `nl:stats:statsttl00001:${DAY}`;
  is("the day's record is made", exists(read), 1);
  is("and it is given the day's expiry, not kept for ever", keptAsADay(read), true);
  is("in one request of one command, as the reading is priced (tests/traffic-cost.ts, readBeacon)", sent.map((l) => l.length), [1]);

  part("A search that found nothing, on a day with no view yet");
  redis.clear();
  await countSearchMiss("statsttl00002", ["blue", "mug"], AFTER_MIDNIGHT);
  const miss = `nl:stats:statsttl00002:${DAY}`;
  is("the day's record is made and given its expiry", [exists(miss), keptAsADay(miss)], [1, true]);

  part("A product page's count whose answer is lost after it was applied");
  redis.clear();
  lose = first;
  await recordHit(shop("statsttl00003"), { kind: "product", id: "prod000001", ip: "192.0.2.1", userAgent: "Mozilla/5.0 (iPhone)" }, AFTER_MIDNIGHT).catch(() => null);
  lose = null;
  const opened = `nl:stats:statsttl00003:${DAY}`;
  is("the count was written", exists(opened), 1);
  is("and its record still has the day's expiry", keptAsADay(opened), true);

  part("A view whose answer is lost after it was applied");
  redis.clear();
  lose = first;
  await recordHit(shop("statsttl00004"), { kind: "view", source: "instagram", ip: "192.0.2.2", userAgent: "Mozilla/5.0 (iPhone)", country: "US", device: "mobile" }, AFTER_MIDNIGHT).catch(() => null);
  lose = null;
  const day = `nl:stats:statsttl00004:${DAY}`;
  const visitors = `nl:stats:statsttl00004:${DAY}:u`;
  const live = "nl:stats:statsttl00004:live";
  is("the day's record, its visitors and who is on now were written", [exists(day), exists(visitors), exists(live)], [1, 1, 1]);
  is("and each has its expiry", [keptAsADay(day), keptAsADay(visitors), ttl(live) > 0 && ttl(live) <= 86400], [true, true, true]);
  is("the all-time record is kept, as it always was, with no expiry", ttl("nl:stats:statsttl00004:life"), -1);

  part("A view whose answer comes back as nothing anybody can read");
  redis.clear();
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
    sent.push(list);
    const out = await real(list);
    return first(list) ? out.map(() => null) : out;
  }) as typeof redis.pipeline;
  await recordHit(shop("statsttl00005"), { kind: "view", source: "direct", ip: "192.0.2.3", userAgent: "Mozilla/5.0 (iPhone)" }, AFTER_MIDNIGHT).catch(() => null);
  const unread = `nl:stats:statsttl00005:${DAY}`;
  is("the day's record and its visitors each have their expiry", [keptAsADay(unread), keptAsADay(`${unread}:u`)], [true, true]);
  is("and a visitor not known to be new is not counted as one for all time", redis.run(["HGET", "nl:stats:statsttl00005:life", "u"]), null);
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
    sent.push(list);
    const out = await real(list);
    if (lose && lose(list)) throw new Error("timeout after the write");
    return out;
  }) as typeof redis.pipeline;

  part("The count itself, with its answer lost");
  redis.clear();
  lose = () => true;
  const answer = await cappedCount("nl:test:ttl:a", DAY_FIELDS_MAX, [{ field: "x", by: 1 }], 3600);
  lose = null;
  is("it answers that nothing is known, as before", answer, [0]);
  is("and the hash it made has the expiry asked for", [exists("nl:test:ttl:a"), ttl("nl:test:ttl:a") > 3500 && ttl("nl:test:ttl:a") <= 3600], [1, true]);

  part("Controls: what already had an expiry, and what asked for none");
  redis.clear();
  redis.run(["HSET", "nl:test:ttl:b", "x", "1"]);
  redis.run(["EXPIRE", "nl:test:ttl:b", 50]);
  redis.scriptCalls = 0;
  await cappedCount("nl:test:ttl:b", DAY_FIELDS_MAX, [{ field: "x", by: 1 }], 3600);
  is("a record that is there keeps the expiry it had, and its count costs no command more", [ttl("nl:test:ttl:b") <= 50, redis.scriptCalls], [true, 2]);
  redis.scriptCalls = 0;
  await cappedCount("nl:test:ttl:c", DAY_FIELDS_MAX, [{ field: "x", by: 1 }], 3600);
  is("a record it makes is given its expiry with one command more, once", [keptAsADay("nl:test:ttl:c") || ttl("nl:test:ttl:c") > 3500, redis.scriptCalls], [true, 3]);
  await cappedCount("nl:test:ttl:d", DAY_FIELDS_MAX, [{ field: "x", by: 1 }]);
  is("a count asked with no expiry gives none", ttl("nl:test:ttl:d"), -1);
  is("and counts as before", redis.run(["HGET", "nl:test:ttl:d", "x"]), "1");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
