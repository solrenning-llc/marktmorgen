import { rememberFolderOwner } from "@/lib/delivery";
import { claimHandle, ERASING_KEY, erasingField, storeFolder, storeIdCommand, storeRef } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measureDue, opened } from "@/lib/watch";
import { MEASURE_SOON_MS } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.BUNNY_STREAM_LIBRARY_ID = "4249";
process.env.BUNNY_STREAM_API_KEY = "synthetic-watch-due-key";
process.env.BUNNY_STREAM_TOKEN_KEY = "synthetic-watch-due-token";
const COLLECTION = "00000000-0000-4000-8000-00000000c049";
const VIDEO = "00000000-0000-4000-8000-000000000049";
const real = redis.pipeline.bind(redis);

async function scenario(how: "live" | "last-read" | "unknown" | "unchanged") {
  redis.clear();
  const claimed = await claimHandle("watch-due@example.com", "watch-due", "Watch due", "");
  if (!claimed.ok) throw new Error("synthetic shop");
  const shop = claimed.store, ref = storeRef(shop), folder = await storeFolder(ref);
  const openedKey = `nl:watch:opened:${folder}`;
  await rememberFolderOwner(folder, ref);
  await real([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
  if (how === "unchanged") await real([["HSET", `nl:watch:last:${folder}`, VIDEO, "600"]]);
  let erased = false;
  const erase = async () => {
    erased = true;
    await real([
      ["HSET", ERASING_KEY, await erasingField(ref), "synthetic-erasing"],
      ["DEL", storeIdCommand(shop.sid)[1]],
      ["ZREM", "nl:watch:due", folder],
    ]);
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.origin !== STREAM_API_ORIGIN || !url.pathname.endsWith("/videos")) throw new Error("synthetic route");
    if (how === "unknown" || how === "unchanged") await erase();
    if (how === "unknown") return Response.json({ error: "synthetic outage" }, { status: 503 });
    return Response.json({ totalItems: 1, currentPage: 1, itemsPerPage: 1000, items: [{ guid: VIDEO, collectionId: COLLECTION, totalWatchTime: 600 }] });
  }) as typeof fetch;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const result = await real(commands);
    if (how === "last-read" && commands.some(c => c[0] === "GET" && c[1] === openedKey)) await erase();
    return result;
  };
  try {
    const now = Date.now();
    await opened(folder, now);
    const result = await measureDue(now + 30_000, now + MEASURE_SOON_MS);
    const due = (await real([["ZSCORE", "nl:watch:due", folder]]))[0];
    return { erased, result, due, now };
  } finally { redis.pipeline = real; }
}
async function main() {
  part("a current folder still schedules its next measurement");
  const control = await scenario("live");
  is("live measurement is counted", control.result, { read: 1, seconds: 600 });
  is("live folder stays scheduled in the future", Number(control.due) > control.now, true);
  for (const how of ["last-read", "unknown", "unchanged"] as const) {
    part(how);
    const got = await scenario(how);
    is("the synthetic erasure ran", got.erased, true);
    is("a removed due member stays absent", got.due, null);
  }
  done();
}
void main();
