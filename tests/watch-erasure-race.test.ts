/**
 * A video-meter read that was already due must not recreate a closed store's
 * usage after erasure starts.  Every service and identifier here is a local
 * synthetic stand-in.
 */
import { rememberFolderOwner } from "@/lib/delivery";
import { calendarWindow } from "@/lib/allowance-window";
import { claimHandle, ERASING_KEY, erasingField, storeFolder, storeIdCommand, storeRef } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measureDue, opened } from "@/lib/watch";
import { MEASURE_SOON_MS } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIBRARY = "4249";
const COLLECTION = "00000000-0000-4000-8000-00000000c049";
const VIDEO = "00000000-0000-4000-8000-000000000049";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = "synthetic-watch-erasure-key";
  process.env.BUNNY_STREAM_TOKEN_KEY = "synthetic-watch-erasure-token";

  const email = "watch-erasure@example.com";
  const claimed = await claimHandle(email, "watch-erasure", "Watch erasure", "");
  if (!claimed.ok) throw new Error("synthetic store was not made");
  const { store } = claimed;
  const ref = storeRef(store);
  const folder = await storeFolder(ref);
  await rememberFolderOwner(folder, ref);
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);

  let eraseDuringRead = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== STREAM_API_ORIGIN || url.pathname !== `/library/${LIBRARY}/videos` || (init?.method ?? "GET") !== "GET") {
      return new Response("{}", { status: 404 });
    }
    if (eraseDuringRead) {
      const month = calendarWindow().id;
      await redis.pipeline([
        ["HSET", ERASING_KEY, await erasingField(ref), String(Date.now())],
        ["DEL", storeIdCommand(store.sid)[1]],
        ["DEL", `nl:watch:last:${folder}`],
        ["DEL", `nl:watch:sec:${folder}:${month}`],
        ["SREM", `nl:watch:folders:${month}`, folder],
      ]);
    }
    return Response.json({ totalItems: 1, currentPage: 1, itemsPerPage: 1000, items: [{ guid: VIDEO, collectionId: COLLECTION, totalWatchTime: 600 }] });
  }) as typeof fetch;

  const now = Date.now();
  await opened(folder, now);
  eraseDuringRead = true;

  part("a due video read cannot resurrect a store whose erasure starts while the service is read");
  is("the stale due snapshot records no watching", await measureDue(Date.now() + 5_000, now + MEASURE_SOON_MS), { read: 0, seconds: 0 });
  const month = calendarWindow(now + MEASURE_SOON_MS).id;
  const [last, seconds, folders, due] = await redis.pipeline([
    ["EXISTS", `nl:watch:last:${folder}`],
    ["EXISTS", `nl:watch:sec:${folder}:${month}`],
    ["SISMEMBER", `nl:watch:folders:${month}`, folder],
    ["ZSCORE", "nl:watch:due", folder],
  ]);
  is("no erased watch data or retry marker is recreated", [last, seconds, folders, due], [0, 0, 0, null]);

  done();
}

void main();
