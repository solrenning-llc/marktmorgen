/**
 * One malformed stored total never stops a store's video from being counted
 * (independent review 1 of the SG2 L8 batch, finding 1).
 *
 * measure (lib/watch.ts) reads every video's last total from
 * nl:watch:last:<folder>. The L8 batch made it refuse to count anything when
 * one entry was not a whole number, so the store was not metered this round.
 * But the entry is persisted and the key does not expire: the next round read
 * it again, and the one after, and the store was never metered again. Its
 * month of video stopped growing, so the limited-video admission never saw
 * the ceiling and the billing never saw the usage: an uncapped cost.
 *
 * Two cases are now told apart:
 *
 *   - a reply out of shape (not a list of text, odd length, a Redis that
 *     cannot be asked) is still unknown: nothing is counted or written this
 *     round, and the store is read again soon (tests/sg2-l8-counts.test.ts);
 *   - a well-formed reply holding an entry that is not a whole number: that
 *     entry is dropped and rewritten with the video's current total, nothing
 *     is added for that video this round (never counted from 0), and every
 *     other video, the forgetting of deleted videos and the writing of the
 *     new totals go on as usual.
 */
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measure, watchedIn } from "@/lib/watch";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIBRARY = "4243";
const COLLECTION = "00000000-0000-4000-8000-00000000c012";
const GOOD = "00000000-0000-4000-8000-0000000000b1";
const BAD = "00000000-0000-4000-8000-0000000000b2";
const DELETED = "old-deleted-video";
/** What the video service says each video has been watched, in all. */
let totals: Record<string, number> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN && url.pathname === `/library/${LIBRARY}/videos` && (init?.method ?? "GET") === "GET") {
    const items = url.searchParams.get("collection") === COLLECTION ? Object.entries(totals).map(([guid, totalWatchTime]) => ({ guid, collectionId: COLLECTION, totalWatchTime })) : [];
    return json({ totalItems: items.length, currentPage: 1, itemsPerPage: 1000, items });
  }
  return json({}, 404);
}) as typeof fetch;

/** The last totals kept for a folder, as an object. */
async function lastOf(folder: string): Promise<Record<string, string>> {
  const [flat] = (await redis.pipeline([["HGETALL", `nl:watch:last:${folder}`]])) as [string[]];
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = "a-stand-in-library-key-for-tests-only";
  process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  // ------------------------------------------------- the review's reproduction
  part("measure: one deleted video's malformed total does not stop the store's metering (the review's reproduction)");
  {
    const folder = "aaaabbbbccccdddd0000111122223333";
    await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
    await redis.pipeline([["HSET", `nl:watch:last:${folder}`, GOOD, "100", DELETED, "12.5"]]);
    const added: (number | null)[] = [];
    for (const total of [400, 4000, 40000]) {
      totals = { [GOOD]: total };
      added.push(await measure(folder));
    }
    is("each round adds only what the video grew by", added, [300, 3600, 36000]);
    is("the month's video grows with it", await watchedIn(folder), 39900);
    is("the deleted video's entry is let go; the video's total is the newest", await lastOf(folder), { [GOOD]: "40000" });
  }

  // ------------------------------------- a malformed total of a video still there
  part("measure: a video whose stored total is malformed is resynced, never counted from 0, and counts from then on");
  {
    const folder = "aaaabbbbccccdddd0000111122224444";
    await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
    await redis.pipeline([["HSET", `nl:watch:last:${folder}`, GOOD, "100", BAD, "12.5", DELETED, "lots"]]);
    logged.length = 0;

    totals = { [GOOD]: 400, [BAD]: 1000 };
    is("round 1: only the good video's growth is added; the malformed one adds nothing", await measure(folder), 300);
    is("round 1: the malformed entry is rewritten with the video's current total, the deleted one let go", await lastOf(folder), { [GOOD]: "400", [BAD]: "1000" });
    is("round 1: the month's video grew", await watchedIn(folder), 300);
    is("round 1: the dropped entries are logged", logged.some((line) => line.includes("watch") && line.includes(folder)), true);

    totals = { [GOOD]: 4000, [BAD]: 1500 };
    is("round 2: the resynced video counts normally, with the good one", await measure(folder), 3600 + 500);
    is("round 2: both totals kept", await lastOf(folder), { [GOOD]: "4000", [BAD]: "1500" });
    is("round 2: the month's video grew", await watchedIn(folder), 4400);

    totals = { [GOOD]: 40000, [BAD]: 1500 };
    is("round 3: the good video goes on counting", await measure(folder), 36000);
    is("round 3: the month's video grew", await watchedIn(folder), 40400);
  }

  // --------------------------------------------------- an entry malformed again
  part("measure: an entry written malformed again later is resynced again, never counted from 0");
  {
    const folder = "aaaabbbbccccdddd0000111122225555";
    await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
    await redis.pipeline([["HSET", `nl:watch:last:${folder}`, GOOD, "-5"]]);
    totals = { [GOOD]: 900 };
    is("a negative total: nothing added, resynced", await measure(folder), 0);
    is("a negative total: rewritten with the current total", await lastOf(folder), { [GOOD]: "900" });
    is("nothing was added to the month", await watchedIn(folder), 0);
    totals = { [GOOD]: 950 };
    is("then it counts what it grew by", await measure(folder), 50);
  }

  console.error = realError;
  done();
}

void main();
