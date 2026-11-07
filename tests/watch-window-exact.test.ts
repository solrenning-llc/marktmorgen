/**
 * The hourly video reading adds what was watched only to the counter that
 * pauses the store's video (lib/watch.ts measure, lib/learn.ts lessonVideo).
 *
 * The defect held here (Claude 5, reviews of #2914 and #2876): when the read
 * of whose folder it is came back unknown (a reply of another shape, or a
 * database that did not answer), the window fell back to the calendar month
 * while the last totals were moved on in the same write. The seconds went to
 * a key no admission reads, and were never counted again: the video kept
 * playing past the plan's hours, and the video service's cost had no ceiling.
 *
 * Now the window is read exactly before anything is written. Unknown writes
 * nothing, so what was watched stays between the service's total and the
 * last total kept here, and the next reading that knows the window counts it
 * there, once. While the store is still being watched it is read again a
 * quarter of an hour on; once nobody has opened a lesson for a token's life
 * and an hour, it is let go, and the next lesson opened brings it back with
 * nothing lost.
 */
import { rememberFolderOwner } from "@/lib/delivery";
import { calendarWindow, windowId } from "@/lib/allowance-window";
import { claimHandle, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { PLAYER_SECONDS } from "@/lib/stream";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measure, measureDue, opened, watchedForAdmission } from "@/lib/watch";
import { MEASURE_SOON_MS } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const LIBRARY = "4343";
const API_KEY = "a-stand-in-library-key-for-tests-only";
process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
process.env.BUNNY_STREAM_API_KEY = API_KEY;
process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";

type Video = { guid: string; collectionId: string; totalWatchTime: number };
const videos = new Map<string, Video>();
let made = 0;
const guid = () => `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN && url.pathname === `/library/${LIBRARY}/videos` && (init?.method ?? "GET") === "GET") {
    if ((init?.headers as Record<string, string>).AccessKey !== API_KEY) return json({}, 401);
    const all = [...videos.values()].filter((v) => v.collectionId === url.searchParams.get("collection"));
    return json({ totalItems: all.length, currentPage: 1, itemsPerPage: 1000, items: all });
  }
  return json({}, 404);
}) as typeof fetch;

/** A fault on the replies to one key: a reply of another shape, or the database not answering. */
type Fault = { key: string; mode: "shape" | "throw" } | null;
let fault: Fault = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const hit = fault ? commands.findIndex((c) => c[1] === fault!.key) : -1;
  if (hit >= 0 && fault!.mode === "throw") throw new Error("Redis request failed with status 503");
  const replies = await realPipeline(commands);
  if (hit >= 0) replies[hit] = 42;
  return replies;
}) as typeof redis.pipeline;

const folderOwnerKey = (folder: string) => `nl:store:folder-owner:${folder}`;
const lastOf = async (folder: string) => (await realPipeline([["HGETALL", `nl:watch:last:${folder}`]]))[0];
const secondsIn = async (folder: string, window: string) => (await realPipeline([["GET", `nl:watch:sec:${folder}:${window}`]]))[0];
const due = async (folder: string) => (await realPipeline([["ZSCORE", "nl:watch:due", folder]]))[0];

/** A paying store (its own billing month, not the calendar's) with one lesson video at the service. */
async function payingStore(email: string, handle: string): Promise<{ folder: string; window: string; video: Video; storeKey: string }> {
  await claimHandle(email, handle, handle, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}0001`, active: true, cycle: "month", period: paidPeriod() });
  const folder = await storeFolder(email);
  await rememberFolderOwner(folder, email);
  const collection = guid();
  await realPipeline([["SET", `nl:stream:col:${folder}`, collection]]);
  const video: Video = { guid: guid(), collectionId: collection, totalWatchTime: 0 };
  videos.set(video.guid, video);
  const store = await storeForEmail(email);
  const window = store ? windowId(store) : null;
  if (!window) throw new Error("the fixture store has no window");
  // The store record's own key, found by asking which GET storeForEmail sends.
  let storeKey = "";
  const spy = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => { storeKey = String(commands[0]?.[1] ?? ""); return realPipeline(commands); }) as typeof redis.pipeline;
  await storeForEmail(email);
  redis.pipeline = spy;
  return { folder, window, video, storeKey };
}

async function main(): Promise<void> {
  const now = Date.now();
  const month = calendarWindow(now).id;

  part("The window a store pays in is not the calendar month");
  const ana = await payingStore("ana@example.com", "anawin");
  is("the fixture's billing window differs from the calendar month", ana.window !== month, true);
  ana.video.totalWatchTime = 600;
  is("a known window: what was watched is added to the counter that pauses", [await measure(ana.folder, now), await watchedForAdmission(ana.folder, ana.window)], [600, 600]);
  is("and nothing to the calendar month's key", await secondsIn(ana.folder, month), null);

  for (const [what, key, mode] of [
    ["the owner of the folder answered in another shape", (f: string) => folderOwnerKey(f), "shape"],
    ["the owner of the folder could not be read", (f: string) => folderOwnerKey(f), "throw"],
    ["the store's record could not be read", (_f: string, s: string) => s, "throw"],
  ] as const) {
    part(`Unknown window: ${what}`);
    const before = await watchedForAdmission(ana.folder, ana.window);
    const last = JSON.stringify(await lastOf(ana.folder));
    ana.video.totalWatchTime += 300;
    fault = { key: key(ana.folder, ana.storeKey), mode };
    is("the reading is said as not made", await measure(ana.folder, now), null);
    fault = null;
    is("the last totals are not moved on", JSON.stringify(await lastOf(ana.folder)), last);
    is("nothing goes to the calendar month, where no admission reads", await secondsIn(ana.folder, month), null);
    is("the counter that pauses is where it was", await watchedForAdmission(ana.folder, ana.window), before);
    is("the next reading that knows the window counts it there, once", [await measure(ana.folder, now), await watchedForAdmission(ana.folder, ana.window)], [300, (before ?? 0) + 300]);
    is("and not again", await measure(ana.folder, now), 0);
  }

  part("A paying store whose period is not known: no window, nothing written");
  const bea = await payingStore("bea@example.com", "beawin");
  await setSubscription("bea@example.com", { active: true, period: null });
  const unknown = await storeForEmail("bea@example.com");
  is("the store has no window (its video does not play)", unknown ? windowId(unknown) : "no store", null);
  bea.video.totalWatchTime = 900;
  is("the reading is said as not made", await measure(bea.folder, now), null);
  is("and nothing is counted in the calendar month", [await lastOf(bea.folder), await secondsIn(bea.folder, month)], [[], null]);
  await setSubscription("bea@example.com", { active: true, period: paidPeriod() });
  const back = await storeForEmail("bea@example.com");
  const beaWindow = back ? windowId(back) : null;
  is("once its window is known again, the watching is counted there", [await measure(bea.folder, now), beaWindow && await watchedForAdmission(bea.folder, beaWindow)], [900, 900]);

  part("A folder nobody is confirmed to own is still counted somewhere");
  const orphan = "a".repeat(32);
  const collection = guid();
  await realPipeline([["SET", `nl:stream:col:${orphan}`, collection]]);
  const orphanVideo = guid();
  videos.set(orphanVideo, { guid: orphanVideo, collectionId: collection, totalWatchTime: 120 });
  is("a confirmed absence of an owner counts in the calendar month, as before", [await measure(orphan, now), await secondsIn(orphan, month)], [120, "120"]);

  part("The hourly job: read again while watched, let go after, nothing lost");
  const cal = await payingStore("cal@example.com", "calwin");
  await opened(cal.folder, now);
  cal.video.totalWatchTime = 1200;
  fault = { key: folderOwnerKey(cal.folder), mode: "throw" };
  const first = now + MEASURE_SOON_MS;
  is("an unknown window is not counted as read", (await measureDue(Date.now() + 5_000, first)).read, 0);
  is("and is read again a quarter of an hour on, while lessons are open", await due(cal.folder), String(first + 15 * 60_000));
  const late = now + (PLAYER_SECONDS + 3600) * 1000 + 60_000;
  is("past a token's life and an hour with nobody watching, it is let go", [(await measureDue(Date.now() + 5_000, late)).read, await due(cal.folder)], [0, null]);
  fault = null;
  is("with nothing written meanwhile", [await watchedForAdmission(cal.folder, cal.window), await secondsIn(cal.folder, month)], [0, null]);
  await opened(cal.folder, late);
  is("the next lesson opened brings it back, and the watching is counted in the window", [await measureDue(Date.now() + 5_000, late + MEASURE_SOON_MS), await watchedForAdmission(cal.folder, cal.window)], [{ read: 1, seconds: 1200 }, 1200]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
