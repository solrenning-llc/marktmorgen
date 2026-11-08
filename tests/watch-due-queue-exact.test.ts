/**
 * The video measurement queue is read exactly (CX-123 rule 24; audit R24, finding 7.3).
 *
 * measureDue (lib/watch.ts) reads which stores are due to be measured with one ZRANGEBYSCORE on nl:watch:due, then
 * adds what each store's videos grew by to the store's window, which the limited-video admission (lib/learn.ts,
 * watchedForAdmission) reads before it issues a playback token. The reply was read with `Array.isArray(due) ? due
 * : []`, and a member that was not a string was skipped: a reply missing, of another shape, or holding a member
 * nobody understood was read as "nothing to measure", and the run answered { read: 0, seconds: 0 } as success. The
 * watching since the last reading never reached the store's window, so admission read less usage than was real.
 *
 * Now an unreadable queue is unknown: measureDue throws UnknownReplyError, so the video job (app/api/cron/stream)
 * answers 500 rather than "ok", nothing is taken out of the line, and the next run reads the same stores. An empty
 * list stays a confirmed "nobody is due" (ZRANGEBYSCORE answers [] for a missing key).
 */
import { UnknownReplyError } from "@/lib/redis-reply";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measureDue, opened, watchedIn } from "@/lib/watch";
import { calendarWindow } from "@/lib/allowance-window";
import { MEASURE_SOON_MS } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIBRARY = "4246";
const COLLECTION = "00000000-0000-4000-8000-00000000c7a3";
const VIDEO = "00000000-0000-4000-8000-0000000007a3";
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

/** When set, the pipeline that holds the queue's ZRANGEBYSCORE answers this instead of the stub's own reply. */
let queueReply: { replies: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (queueReply && commands.some((c) => c[0] === "ZRANGEBYSCORE" && c[1] === "nl:watch:due")) return queueReply.replies;
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return `answered ${JSON.stringify(await run())}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = "a-stand-in-library-key-for-tests-only";
  process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";
  const realError = console.error;
  console.error = () => {};

  const now = Date.now();
  const calendar = calendarWindow(now).id;
  // A folder known to belong to no store counts in the calendar month (lib/watch.ts, windowOfFolder).
  const folder = "aaaabbbbccccdddd00001111222277a3";
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);

  part("control: nobody due is a confirmed empty list, not unknown");
  is("an empty queue measures nothing, as success", await outcome(() => measureDue(Date.now() + 5_000, now)), 'answered {"read":0,"seconds":0}');

  part("an unreadable queue is unknown, never \"nothing to measure\"");
  await opened(folder, now);
  total = 900;
  const at = now + MEASURE_SOON_MS;
  const shapes: [string, unknown][] = [
    ["no reply for the one command", []],
    ["a null reply", [null]],
    ["a string", ["a folder"]],
    ["an object", [{ 0: folder }]],
    ["a number member", [[42]]],
    ["a null member", [[null]]],
    ["a good member beside a bad one", [[folder, 7]]],
    ["two replies for one command", [[folder], [folder]]],
    ["not a list of replies", "OK"],
  ];
  for (const [label, replies] of shapes) {
    queueReply = { replies };
    is(`${label}: unknown`, await outcome(() => measureDue(Date.now() + 5_000, at)), "unknown");
    queueReply = null;
  }
  const [score] = (await redis.pipeline([["ZSCORE", "nl:watch:due", folder]])) as [string | null];
  is("the store is still in line after every unknown run", score !== null, true);
  is("nothing was added to its window on an unknown run", await watchedIn(folder, calendar), 0);

  part("control: the next readable run measures the whole growth, once");
  is("read once, every second watched counted", await outcome(() => measureDue(Date.now() + 5_000, at)), 'answered {"read":1,"seconds":900}');
  is("in the store's window", await watchedIn(folder, calendar), 900);

  console.error = realError;
  done();
}

void main();
