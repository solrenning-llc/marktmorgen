/**
 * Claude 6's MEDIUM on #4888 @fbcd645745 (7035339160): the video meter's erasure fence keyed on the store's id key
 * (storeIdCommand(sid)), and a live store kept from before ids (sid "") has none, so its reads were refused as if the
 * store were erased: measure() gave 0 where main gave 600, the folder left the due list, and its hours cap never saw
 * the watching. A store with no id is fenced on its owner record (ownerKey(ref)), as lib/store-live-cache.ts does;
 * once that record is gone (erasure), nothing is written. Synthetic store and video service; MemoryRedis.
 */
import { rememberFolderOwner } from "@/lib/delivery";
import { allowanceWindow } from "@/lib/allowance-window";
import { ERASING_KEY, claimHandle, erasingField, ownerKey, setSubscription, storeFolder, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measure } from "@/lib/watch";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIBRARY = "4250";
const COLLECTION = "00000000-0000-4000-8000-00000000c050";
const VIDEO = "00000000-0000-4000-8000-000000000050";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = "synthetic-watch-legacy-key";
  process.env.BUNNY_STREAM_TOKEN_KEY = "synthetic-watch-legacy-token";

  const email = "watch-legacy@example.com";
  const claimed = await claimHandle(email, "watch-legacy", "Watch legacy", "");
  if (!claimed.ok) throw new Error("synthetic store was not made");
  const ref = storeRef(claimed.store);
  // A paying store, so it has a billing window the video meter counts in.
  const now = Date.now();
  await setSubscription(email, { customerId: "cus_WatchLegacy01", subscriptionId: "sub_WatchLegacy01", active: true, cycle: "month", period: paidPeriod(now) });
  // A store kept from before ids: its record has no sid, and there is no id key.
  const owner = await ownerKey(ref);
  const record = JSON.parse(String(redis.run(["GET", owner]))) as Record<string, unknown>;
  const oldId = storeIdCommand(String(record.sid ?? ""))[1];
  delete record.sid;
  redis.run(["SET", owner, JSON.stringify(record)]);
  redis.run(["DEL", oldId]);
  const legacy = await storeForEmail(email);
  if (!legacy || legacy.sid !== "") throw new Error("setup: the store did not read back without an id");

  const folder = await storeFolder(ref);
  await rememberFolderOwner(folder, ref);
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== STREAM_API_ORIGIN || url.pathname !== `/library/${LIBRARY}/videos` || (init?.method ?? "GET") !== "GET") {
      return new Response("{}", { status: 404 });
    }
    return Response.json({ totalItems: 1, currentPage: 1, itemsPerPage: 1000, items: [{ guid: VIDEO, collectionId: COLLECTION, totalWatchTime: 600 }] });
  }) as typeof fetch;

  const month = allowanceWindow(legacy, now)?.id;
  if (!month) throw new Error("setup: the paying store has no billing window");

  part("A live store from before ids has its watching measured, as on main");
  is("the read counts the 600 seconds watched", await measure(folder, now), 600);
  is("the month's seconds are written", Number(redis.run(["GET", `nl:watch:sec:${folder}:${month}`])), 600);

  part("Once its erasure has begun, nothing is written for it");
  redis.run(["DEL", `nl:watch:sec:${folder}:${month}`]);
  redis.run(["DEL", `nl:watch:last:${folder}`]);
  redis.run(["HSET", ERASING_KEY, await erasingField(ref), String(now)]);
  is("an erasing legacy store records no watching", await measure(folder, now + 1), 0);
  is("and no seconds are written", redis.run(["GET", `nl:watch:sec:${folder}:${month}`]), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
