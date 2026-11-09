/**
 * CX-123 rule 24, BAIXA item of the tolerant-reads inventory: lib/stats.ts read
 * a day's HGETALL with `pairs`, which took a reply of any other shape for a day
 * with nothing counted and any count it could not read for 0 (`Number(x) || 0`).
 * readStats and readRange check their replies first (lib/range-traffic-coverage.ts),
 * but today's numbers (readToday, every half minute in the studio), today's
 * channels for the busy-day email (sourcesToday), the views before it
 * (viewsBefore) and the visits download (visitsCsv) did not: an unreadable day
 * became zeros on the screen, in the email's comparison and in the file. Now
 * every one of them reads exactly and throws UnknownReplyError on anything else;
 * the live route already shows "today" as unread on a throw, the export route
 * answers 502 "try again", and the busy-day email is not sent on unread history
 * and names no channel it could not read (rule 30). Synthetic store.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readToday, sourcesToday, viewsBefore, visitsCsv } from "@/lib/stats";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: ((batch: Command[], values: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  return inject ? inject(batch, values) : values;
}) as typeof redis.pipeline;

const NOW = Date.parse("2026-11-09T15:00:00Z");
const TODAY = "2026-11-09";
const outcome = (promise: Promise<unknown>) => promise.then(() => "read", (error) => (error instanceof UnknownReplyError ? "unknown" : `error: ${String(error)}`));

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "stats-today-exact@example.test";
  await claimHandle(OWNER, "todayexact", "Today Exact", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const counts = `nl:stats:${store.statsId}:${TODAY}`;
  const people = `${counts}:u`;
  const before = `nl:stats:${store.statsId}:2026-11-08`;
  await real([
    ["HINCRBY", counts, "v", 5],
    ["HINCRBY", counts, "c", 1],
    ["HINCRBY", counts, "r:google", 4],
    ["HINCRBY", counts, "l:shop", 2],
    ["PFADD", people, "a", "b", "c"],
    ["HINCRBY", before, "v", 7],
  ]);
  /** Replaces the reply of the first command matching `match`, leaving the rest as read. */
  const replace = (match: (c: Command) => boolean, reply: unknown) => (batch: Command[], values: unknown[]) => {
    const at = batch.findIndex(match);
    return at < 0 ? values : values.map((value, i) => (i === at ? reply : value));
  };
  const day = (c: Command) => c[0] === "HGETALL" && c[1] === counts;
  const visitors = (c: Command) => c[0] === "PFCOUNT" && c[1] === people;

  part("Confirmed readings");
  const today = await readToday(store, NOW);
  is("today: visitors, views, checkouts and its channel", [today.visitors, today.views, today.checkouts, today.sources.map((s) => [s.source, s.visits])], [3, 5, 1, [["google", 4]]]);
  is("today's channels for the busy-day email", (await sourcesToday(store, NOW)).map((s) => [s.name, s.visits]), [["google", 4]]);
  is("the views of the days before, an absent day as 0", (await viewsBefore(store, 2, NOW)), [0, 7]);
  const csv = await visitsCsv(store, NOW);
  is("the visits file has today's row", csv.split("\r\n")[1].replace(/"/g, ""), `${TODAY},3,5,1,2,google`);

  const cases: [string, (batch: Command[], values: unknown[]) => unknown[]][] = [
    ["a day's counts answered with a word", replace(day, "OK")],
    ["a day's counts cut short (a field without its count)", replace(day, ["v", "5", "c"])],
    ["a day's count that is not a number", replace(day, ["v", "many"])],
    ["no reply at all", () => []],
  ];
  for (const [name, broken] of cases) {
    part(`Unknown: ${name}`);
    inject = broken;
    is("today's numbers are unknown, never zeros", await outcome(readToday(store, NOW)), "unknown");
    is("today's channels are unknown, never none", await outcome(sourcesToday(store, NOW)), "unknown");
    is("the visits file is refused, never a row of zeros", await outcome(visitsCsv(store, NOW)), "unknown");
    inject = null;
  }

  part("Unknown: today's people count");
  inject = replace(visitors, "many");
  is("today's numbers are unknown, never 0 visitors", await outcome(readToday(store, NOW)), "unknown");
  is("the visits file is refused, never 0 visitors", await outcome(visitsCsv(store, NOW)), "unknown");
  inject = null;

  part("Unknown: the views of the days before");
  inject = replace((c) => c[0] === "HGET" && c[1] === before, "many");
  is("a view count that is not a number is unknown, never 0", await outcome(viewsBefore(store, 2, NOW)), "unknown");
  inject = () => [];
  is("no reply at all is unknown, never days of 0", await outcome(viewsBefore(store, 2, NOW)), "unknown");
  inject = null;

  part("Today's kept sales");
  await real([["SET", `nl:stats:${store.statsId}:today:${TODAY}`, JSON.stringify({ sales: "two", cents: 900 }), "EX", 120]]);
  is("a kept figure out of shape is not shown", (await readToday(store, NOW)).sales, null);
  await real([["SET", `nl:stats:${store.statsId}:today:${TODAY}`, JSON.stringify({ sales: 2, cents: 900 }), "EX", 120]]);
  is("a kept figure in shape is shown", (await readToday(store, NOW)).sales, { sales: 2, cents: 900 });

  part("The busy-day email");
  const report = readFileSync(join(process.cwd(), "lib/stats-report.ts"), "utf8");
  is("an unread channel list leaves the channel out of the email, it does not stop it", /await sourcesToday\(store, now\)\.catch\(/.test(report), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
