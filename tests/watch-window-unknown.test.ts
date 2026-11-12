/**
 * Video watched is never added to the wrong window on an unknown read
 * (CX-123 rule 24; audit of storeKeysOf and its callers).
 *
 * measure (lib/watch.ts) adds what a store's videos grew by to the store's
 * own window (lib/allowance-window.ts): a paying store's billing month, named
 * by its first day ("2026-10-10"), which is what the limited-video admission
 * (lib/learn.ts, watchedForAdmission) and the usage watch read. Working out
 * that window reads which store the folder belongs to and the store's record.
 * When either read failed, windowOfFolder fell back to the calendar month
 * ("2026-10") and measure went on: the seconds were added under the calendar
 * month and the videos' last totals were moved on. The billing month never
 * saw that watching, so a store could play past its plan's hours: a cost
 * past its ceiling, for every reading that failed.
 *
 * Now an unknown window is unknown: measure answers null, writes nothing
 * (neither the seconds nor the last totals), and the store is read again
 * soon; the next reading adds the whole growth to the right window, once.
 * A folder that is known to belong to no store still counts in the calendar
 * month, as before ("counted somewhere, never nowhere").
 */
import { rememberFolderOwner } from "@/lib/delivery";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { claimHandle, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measure, measureDue, opened, watchedIn } from "@/lib/watch";
import { MEASURE_SOON_MS } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const LIBRARY = "4244";
const COLLECTION = "00000000-0000-4000-8000-00000000c013";
const VIDEO = "00000000-0000-4000-8000-0000000000c1";
/** What the video service says the one video has been watched, in all. */
let total = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN && url.pathname === `/library/${LIBRARY}/videos` && (init?.method ?? "GET") === "GET") {
    const items = url.searchParams.get("collection") === COLLECTION ? [{ guid: VIDEO, collectionId: COLLECTION, totalWatchTime: total }] : [];
    return json({ totalItems: items.length, currentPage: 1, itemsPerPage: 1000, items });
  }
  return json({}, 404);
}) as typeof fetch;

/** A prefix of a key whose GET fails as a database that does not answer. */
let failing: string | null = null;
const sent: (string | number)[][][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(commands);
  if (failing && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith(failing as string))) throw new Error("the database did not answer");
  return pipeline(commands);
}) as typeof redis.pipeline;

/** Whether any pipeline sent since `from` holds a command named `name` on a key starting with `prefix`. */
const sentSince = (from: number, name: string, prefix: string) =>
  sent.slice(from).some((commands) => commands.some((c) => c[0] === name && String(c[1]).startsWith(prefix)));

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = "a-stand-in-library-key-for-tests-only";
  process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";
  const realError = console.error;
  console.error = () => {};

  const now = Date.now();
  const email = "window@example.com";
  await claimHandle(email, "window", "window", "");
  await setSubscription(email, { customerId: "cus_Win0001", subscriptionId: "sub_Win0001", active: true, cycle: "month", period: paidPeriod(now) });
  const folder = await storeFolder(email);
  await rememberFolderOwner(folder, email);
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
  const store = await storeForEmail(email);
  const billing = store ? allowanceWindow(store, now)?.id : undefined;
  const calendar = calendarWindow(now).id;

  part("set up: a paying store counts its video in its billing month, not the calendar month");
  is("the billing month is named by its first day, apart from the calendar month", typeof billing === "string" && billing !== calendar, true);
  total = 600;
  is("a first reading adds what was watched", await measure(folder, now), 600);
  is("under the billing month", [await watchedIn(folder, billing), await watchedIn(folder, calendar)], [600, 0]);

  part("measure: a store record that cannot be read never moves watching to the calendar month");
  {
    total = 4200;
    failing = "nl:store:owner:";
    const from = sent.length;
    is("unknown window: nothing measured this round (null)", await measure(folder, now), null);
    failing = null;
    is("nothing added under the calendar month", await watchedIn(folder, calendar), 0);
    is("nothing added under the billing month either", await watchedIn(folder, billing), 600);
    is("the seconds are not written", sentSince(from, "INCRBY", "nl:watch:sec:"), false);
    is("the last totals are not moved on", sentSince(from, "HSET", "nl:watch:last:"), false);
    is("read again: the whole growth lands in the billing month, once", await measure(folder, now), 3600);
    is("the billing month holds all of it", [await watchedIn(folder, billing), await watchedIn(folder, calendar)], [4200, 0]);
  }

  part("measureDue: an unknown window keeps the store in line, to be read again soon");
  {
    await opened(folder, now);
    total = 5000;
    failing = "nl:store:owner:";
    const due = await measureDue(Date.now() + 5_000, now + MEASURE_SOON_MS);
    failing = null;
    is("nothing read or counted", due, { read: 0, seconds: 0 });
    const [score] = (await redis.pipeline([["ZSCORE", "nl:watch:due", folder]])) as [string | null];
    is("still in line", score !== null, true);
    is("nothing landed in the calendar month", await watchedIn(folder, calendar), 0);
  }

  part("measure: a folder known to belong to no store still counts in the calendar month");
  {
    const orphan = "aaaabbbbccccdddd0000111122226666";
    await redis.pipeline([["SET", `nl:stream:col:${orphan}`, COLLECTION]]);
    total = 300;
    is("a first reading", await measure(orphan, now), 300);
    is("under the calendar month", await watchedIn(orphan, calendar), 300);
  }

  console.error = realError;
  done();
}

void main();
