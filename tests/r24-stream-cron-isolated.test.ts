/**
 * The five-minute video job (app/api/cron/stream/route.ts) runs three parts
 * in turn: the stream sweep (lib/stream.ts), the AI captions sweep
 * (lib/auto-captions.ts) and the hourly watch reading (lib/watch.ts). Since
 * an unreadable list throws UnknownReplyError (CX-123 rule 24,
 * tests/r24-stream-sweeps-unknown.test.ts), one part that throws must not
 * stop the others until the next run, five minutes later:
 *
 *   - every part runs, whatever the one before it did;
 *   - the failure stays visible: logged, and the job answers 500
 *     "server_error" at the end when any part failed;
 *   - each part's list is asked once a run, so nothing is counted twice;
 *   - the job's lock is let go, so the next run is not turned away as busy.
 *
 * The daily usage run (app/api/cron/usage/route.ts) also reads the stores
 * whose video was watched (lib/watch.ts watchedFolders): an unknown list
 * there is said as the video part unread, at the end, never "ok", while
 * visits and orders still run.
 */
import { GET as streamJob } from "@/app/api/cron/stream/route";
import { GET as usageJob } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "stub-token";
process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";
delete process.env.CRON_SECRET;

type Command = (string | number)[];

const STREAM_DUE = "nl:stream:due";
const STREAM_GONE = "nl:stream:gone";
const CAPTIONS_DUE = "nl:stream:autoq";
const WATCH_DUE = "nl:watch:due";
const LOCK = "nl:stream:lock";

/** What a part's list is answered with this run: an unknown shape, or a database that does not answer. */
let inject: { name: string; key: RegExp; reply: unknown[] | "throw" } | null = null;
const sent: Command[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
  const first = commands[0];
  if (inject && commands.length === 1 && first?.[0] === inject.name && inject.key.test(String(first?.[1]))) {
    if (inject.reply === "throw") throw new Error("the database did not answer");
    return inject.reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const errors: unknown[][] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args);
};

/** How many times this run asked for one list. */
const asked = (from: number, name: string, key: string | RegExp) =>
  sent
    .slice(from)
    .flat()
    .filter((c) => c[0] === name && (typeof key === "string" ? c[1] === key : key.test(String(c[1])))).length;

function request(path: string) {
  return { headers: new Headers(), nextUrl: new URL(`https://marktmorgen.com${path}`) } as unknown as Parameters<typeof streamJob>[0];
}

async function run(job: typeof streamJob, path: string): Promise<{ status: number; body: Record<string, unknown>; from: number; logged: number }> {
  const from = sent.length;
  const before = errors.length;
  try {
    const response = await job(request(path));
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, from, logged: errors.length - before };
  } catch {
    return { status: -1, body: {}, from, logged: errors.length - before };
  }
}

async function lockHeld(): Promise<boolean> {
  const [held] = await pipeline([["GET", LOCK]]);
  return held !== null && held !== undefined;
}

async function main(): Promise<void> {
  redis.clear();

  const cases: [string, NonNullable<typeof inject>][] = [
    ["the stream sweep's due list answered in an unknown shape", { name: "ZRANGEBYSCORE", key: new RegExp(`^${STREAM_DUE}$`), reply: ["OK"] }],
    ["the stream sweep's delete list answered in an unknown shape", { name: "SMEMBERS", key: new RegExp(`^${STREAM_GONE}$`), reply: [[7]] }],
    ["the stream sweep's due list could not be asked", { name: "ZRANGEBYSCORE", key: new RegExp(`^${STREAM_DUE}$`), reply: "throw" }],
    ["the captions queue answered in an unknown shape", { name: "ZRANGEBYSCORE", key: new RegExp(`^${CAPTIONS_DUE}$`), reply: [{}] }],
    ["the captions queue could not be asked", { name: "ZRANGEBYSCORE", key: new RegExp(`^${CAPTIONS_DUE}$`), reply: "throw" }],
    ["the watch reading's due list could not be asked", { name: "ZRANGEBYSCORE", key: new RegExp(`^${WATCH_DUE}$`), reply: "throw" }],
  ];

  for (const [label, injected] of cases) {
    part(`video job: ${label}`);
    inject = injected;
    const got = await run(streamJob, "/api/cron/stream");
    inject = null;
    is("the job answers 500 server_error at the end, never throws", [got.status, got.body.ok, got.body.error], [500, false, "server_error"]);
    is("and the failure is logged", got.logged > 0, true);
    is("the stream sweep ran, its due list asked once", asked(got.from, "ZRANGEBYSCORE", STREAM_DUE), 1);
    is("the captions sweep ran, its queue asked once", asked(got.from, "ZRANGEBYSCORE", CAPTIONS_DUE), 1);
    is("the watch reading ran, its due list asked once", asked(got.from, "ZRANGEBYSCORE", WATCH_DUE), 1);
    is("the lock was let go", [asked(got.from, "DEL", LOCK), await lockHeld()], [1, false]);
    const next = await run(streamJob, "/api/cron/stream");
    is("so the next run is not turned away as busy", [next.status, next.body.ok, next.body.busy ?? false], [200, true, false]);
  }

  part("video job: every part read: as before");
  const fine = await run(streamJob, "/api/cron/stream");
  is("ok", [fine.status, fine.body.ok], [200, true]);
  is("every part in the answer", [typeof fine.body.looked, typeof fine.body.captions, typeof fine.body.watched], ["number", "object", "object"]);
  is("nothing logged as failed", fine.logged, 0);

  part("usage run: the stores whose video was watched answered in an unknown shape");
  inject = { name: "SMEMBERS", key: /^nl:watch:folders:/, reply: ["OK"] };
  const usage = await run(usageJob, "/api/cron/usage");
  inject = null;
  is("the run answers an error at the end, never ok, never throws", [usage.status >= 500, usage.body.ok], [true, false]);
  is("and names the video part as unread", usage.body.unread, ["video"]);
  is("and the failure is logged", usage.logged > 0, true);
  is("visits and orders still ran, and are in the answer", [typeof usage.body.visits, typeof usage.body.orders], ["object", "object"]);
  is("the delivery part still ran", asked(usage.from, "SMEMBERS", /^nl:store:delivery:over:/) > 0, true);

  part("usage run: every part read: as before");
  const usageFine = await run(usageJob, "/api/cron/usage");
  is("ok", [usageFine.status, usageFine.body.ok], [200, true]);
  is("nothing named unread", usageFine.body.unread ?? [], []);

  console.error = consoleError;
  done();
}

void main();
