/**
 * 247 [SP4] unit 2: the public status page (/status), against the in-memory
 * Redis double only. It shows only what the site measures itself:
 *
 *   - the daily mail check and the daily Stripe check (test mode), each run
 *     kept as a time and a pass or fail, nothing else, the last
 *     STATUS_RUNS_KEPT of them;
 *   - whether the database answered when the page was put together.
 *
 * A check with no result in the last STATUS_STALE_HOURS is Unknown, never
 * Passed; a malformed run is dropped, never counted as a pass; a database
 * that does not answer makes every check Unknown.
 *
 * The page is drawn for each request (no host page cache, whose price no
 * source in this repository gives). Each request first counts itself in the
 * hour, two commands; only the first STATUS_VIEWS_PER_HOUR of an hour read
 * the runs, two commands more. Both kinds of request are priced below at
 * the rates of lib/spend-cost-table.ts and tests/traffic-cost.ts (read 7
 * October 2026): the reading ones bounded by the hour's count, the
 * counted-only ones a fixed price each, whose number past that is the host
 * firewall's, as for every store page (lib/traffic-rules.ts).
 */
import { readFileSync } from "node:fs";
import {
  STATUS_CHECKS, STATUS_COUNT_COMMANDS, STATUS_READ_COMMANDS, STATUS_RUNS_KEPT, STATUS_RUNS_SECONDS, STATUS_STALE_HOURS, STATUS_VIEWS_PER_HOUR,
  STATUS_VIEW_KEY_SECONDS, STATUS_WINDOW_DAYS, describeStatus, parseRuns, readStatus, statusRunCommands, statusViewKey, summarizeRuns,
} from "@/lib/status-page";
import {
  UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";
import { REDIS_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { CDN_PER_REQUEST, ORIGIN_PER_BYTE } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 5, 15, 0, 0);
const MAIL = STATUS_CHECKS.find((c) => c.id === "mail")!;
const CHECKOUT = STATUS_CHECKS.find((c) => c.id === "checkout")!;
const run = (at: number, ok: boolean) => JSON.stringify({ at, ok });
const oldPipeline = redis.pipeline;

async function main(): Promise<void> {
  part("What a check run keeps: a time and a pass or fail, the last few, for a while");
  const commands = statusRunCommands(MAIL.key, NOW, true);
  is("one entry pushed, the list cut to the runs kept, and the list given a life",
    commands, [["LPUSH", MAIL.key, run(NOW, true)], ["LTRIM", MAIL.key, 0, STATUS_RUNS_KEPT - 1], ["EXPIRE", MAIL.key, STATUS_RUNS_SECONDS]]);
  is("the runs kept cover the window shown, and outlive it", [STATUS_RUNS_KEPT >= STATUS_WINDOW_DAYS * 2, STATUS_RUNS_SECONDS > STATUS_WINDOW_DAYS * 86_400], [true, true]);
  is("the two keys are the checks' own, one each", STATUS_CHECKS.map((c) => c.key), ["nl:mail-check:runs", "nl:stripe-check:runs"]);
  for (const [file, check] of [["app/api/cron/mail-check/route.ts", MAIL], ["app/api/cron/stripe-check/route.ts", CHECKOUT]] as const) {
    const route = readFileSync(file, "utf8");
    const save = route.slice(route.indexOf("await redisPipeline([[\"SET\", LAST"));
    is(`${file}: the run is kept in the same save as its last result, with no detail`,
      /^await redisPipeline\(\[\["SET", LAST, [^\n]*\.\.\.statusRunCommands\(STATUS_CHECKS\[\d\]\.key, [a-zA-Z.]+, ok\)\]\);/.test(save), true);
    is(`${file}: the right list`, route.includes(`STATUS_CHECKS[${STATUS_CHECKS.indexOf(check)}].key`), true);
  }

  part("Nothing recorded: the database answered, every check Unknown");
  redis.clear();
  let reading = await readStatus(NOW);
  is("database answered, checks unknown", [reading.database, reading.checks.map((c) => c.summary.state)], ["answered", ["unknown", "unknown"]]);
  is("no run is invented", reading.checks.map((c) => c.summary.runs), [0, 0]);

  part("A pass within the last day and a half is a pass; older is Unknown");
  redis.clear();
  const seen: (string | number)[][][] = [];
  redis.pipeline = async (batch) => { seen.push(batch.map((c) => [...c])); return oldPipeline.call(redis, batch); };
  redis.run(["LPUSH", MAIL.key, run(NOW - 2 * HOUR, true)]);
  redis.run(["LPUSH", CHECKOUT.key, run(NOW - (STATUS_STALE_HOURS + 1) * HOUR, true)]);
  reading = await readStatus(NOW);
  is("mail passed, checkout unknown", reading.checks.map((c) => c.summary.state), ["passed", "unknown"]);
  is("the old checkout result is still shown as the last one", reading.checks[1].summary.last?.at, NOW - (STATUS_STALE_HOURS + 1) * HOUR);
  const hour = statusViewKey(NOW);
  is("the request counted in its hour first, then each list read no further than kept",
    seen, [[["INCR", hour], ["EXPIRE", hour, STATUS_VIEW_KEY_SECONDS]], [["LRANGE", MAIL.key, 0, STATUS_RUNS_KEPT - 1], ["LRANGE", CHECKOUT.key, 0, STATUS_RUNS_KEPT - 1]]]);
  is("the commands counted for the price are the commands sent", [seen[0].length, seen[1].length], [STATUS_COUNT_COMMANDS, STATUS_READ_COMMANDS]);
  is("the hour's key is the hour's, and outlives it", [hour, STATUS_VIEW_KEY_SECONDS > 3600], [`nl:status:views:${Math.floor(NOW / HOUR)}`, true]);
  redis.pipeline = oldPipeline;

  part("A failed last run is Failed, and every failure in the window is listed");
  redis.clear();
  for (const [at, ok] of [[NOW - 3 * DAY, true], [NOW - 2 * DAY, false], [NOW - DAY, true], [NOW - HOUR, false]] as const) redis.run(["LPUSH", MAIL.key, run(at, ok)]);
  redis.run(["LPUSH", MAIL.key, run(NOW - (STATUS_WINDOW_DAYS + 2) * DAY, false)]);
  reading = await readStatus(NOW);
  const mail = reading.checks[0].summary;
  is("failed now", mail.state, "failed");
  is("runs, passes and failures in the window, never the older one", [mail.runs, mail.passed, mail.failed], [4, 2, 2]);
  is("the failures, newest first", mail.failures, [NOW - HOUR, NOW - 2 * DAY]);

  part("A run that cannot be read is dropped, never taken for a pass");
  is("malformed runs dropped", parseRuns(["{broken", JSON.stringify({ at: "x", ok: true }), JSON.stringify({ at: 1, ok: "true" }), JSON.stringify([1]), 7, null, run(NOW, false)]), [{ at: NOW, ok: false }]);
  is("not a list: nothing", parseRuns("nope"), []);
  is("no more than kept are read", parseRuns(Array.from({ length: STATUS_RUNS_KEPT + 5 }, (_, i) => run(NOW - i * HOUR, true))).length, STATUS_RUNS_KEPT);
  is("a run from the future is not a pass now", summarizeRuns([{ at: NOW + HOUR, ok: true }], NOW).state, "unknown");

  part("Days with no recorded run: counted from the first recorded day, never before");
  const gaps = summarizeRuns([{ at: NOW - 4 * DAY, ok: true }, { at: NOW - 2 * DAY, ok: true }, { at: NOW - HOUR, ok: true }], NOW);
  is("from the first run's day to today, the days with none", [gaps.since, gaps.daysWithoutRun], [Date.UTC(2026, 10, 1), 2]);
  const notYet = summarizeRuns([{ at: NOW - DAY, ok: true }], Date.UTC(2026, 10, 5, 3));
  is("today before its run is not counted as a day without one", notYet.daysWithoutRun, 0);
  is("nothing recorded: no days counted", summarizeRuns([], NOW).daysWithoutRun, 0);

  part("Past the hour's reads, a request is counted and reads nothing more; the next hour reads again");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - 2 * HOUR, true)]);
  for (let i = 0; i < STATUS_VIEWS_PER_HOUR; i += 1) await readStatus(NOW);
  const busySeen: (string | number)[][][] = [];
  redis.pipeline = async (batch) => { busySeen.push(batch.map((c) => [...c])); return oldPipeline.call(redis, batch); };
  reading = await readStatus(NOW + 1000);
  redis.pipeline = oldPipeline;
  is("one request too many: counted, no list read", busySeen.map((b) => b.map((c) => c[0])), [["INCR", "EXPIRE"]]);
  is("it says it did not read, never a pass", [reading.busy, reading.checks.map((c) => c.summary.state)], [true, ["unknown", "unknown"]]);
  const busyView = describeStatus(reading);
  is("in words, with when it reads again", busyView.rows[1].when, `Not read: this page was opened more than ${STATUS_VIEWS_PER_HOUR} times this hour. It reads the results again from November 5, 2026 at 4:00 PM UTC`);
  is("the next hour reads again", (await readStatus(NOW + HOUR)).checks[0].summary.state, "passed");

  part("The database does not answer: it says so, and every check is Unknown");
  redis.pipeline = async () => { throw new Error("synthetic outage"); };
  reading = await readStatus(NOW);
  redis.pipeline = oldPipeline;
  is("did not answer, all unknown", [reading.database, reading.checks.map((c) => c.summary.state)], ["no-answer", ["unknown", "unknown"]]);

  part("What the page says");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - 2 * HOUR, true)]);
  const view = describeStatus(await readStatus(NOW));
  is("built time in plain words, with the time zone", view.builtAt, "November 5, 2026 at 3:00 PM UTC");
  is("results in words, never a color alone", view.rows.map((r) => r.result), ["Answered", "Passed", "Unknown"]);
  is("when a check has no result, it says why", view.rows[2].when, `No result in the last ${STATUS_STALE_HOURS} hours`);
  const words = JSON.stringify(describeStatus({ builtAt: NOW, database: "no-answer", busy: false, checks: (await readStatus(NOW)).checks.map((c) => ({ ...c, summary: summarizeRuns([], NOW) })) }));
  is("a database that did not answer is said plainly", words.includes("Did not answer"), true);
  const page = readFileSync("app/status/page.tsx", "utf8");
  is("drawn for each request, never kept in the host's page cache", [page.includes('export const dynamic = "force-dynamic";'), /revalidate|force-static|unstable_cache|"use cache"/.test(page)], [true, false]);
  const all = page + readFileSync("lib/status-page.ts", "utf8");
  for (const banned of [/operational/i, /all systems/i, /\d+(\.\d+)?\s*%/, /99\.9/, /uptime of/i, /guarantee/i, /always (up|on)/i]) {
    is(`no claim that is not measured: ${banned}`, banned.test(all), false);
  }
  for (const said of ["No outside service watches it", "if the site is down, this page is down too", "We do not show an uptime percentage", "Stripe's test mode", "No real card is charged"]) {
    is(`it says what it does not measure: ${said}`, page.includes(said), true);
  }
  is("reached from every page's footer", readFileSync("components/site-footer.tsx", "utf8").includes('{ label: "Status", href: "/status" }'), true);

  part("What the page costs, a company cost: every request priced, the reading ones bounded by the hour");
  const micro = (n: number) => n / 1_000_000;
  const COMMAND = micro(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6;
  const CALL = micro(VERCEL_CALL_MICRO_USD_PER_MILLION) / 1e6;
  const CPU_SECOND = micro(VERCEL_CPU_MICRO_USD_PER_HOUR) / 3600;
  const MEMORY_SECOND = VERCEL_FUNCTION_GB * micro(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) / 3600;
  const DB_BYTE = micro(UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e9;
  // The page as it travels, compressed: 112 KB measured from next build on 5 November 2026, costed at 128.
  const PAGE_BYTES = 128_000;
  // A request at its worst: the CDN's request, two calls (the proxy and the page, as tests/traffic-cost.ts counts a page),
  // a whole second of CPU (ten times a store page's measured tenth), and memory held through every Redis wait at its
  // timeout plus a second to draw.
  const request = (pipelines: number, commands: number, dbBytes: number) =>
    CDN_PER_REQUEST + 2 * CALL + CPU_SECOND + (pipelines * REDIS_TIMEOUT_MS / 1000 + 1) * MEMORY_SECOND
    + commands * COMMAND + dbBytes * DB_BYTE + PAGE_BYTES * ORIGIN_PER_BYTE;
  const reads = request(2, STATUS_COUNT_COMMANDS + STATUS_READ_COMMANDS, 256 + STATUS_READ_COMMANDS * STATUS_RUNS_KEPT * 64);
  const counted = request(1, STATUS_COUNT_COMMANDS, 256);
  const readMonth = STATUS_VIEWS_PER_HOUR * 31 * 24 * reads;
  const runs = 2 * 31 * 3 * COMMAND + 2 * STATUS_RUNS_KEPT * 64 * DB_BYTE;
  console.log(`  cost  a reading request $${reads.toFixed(6)}, a counted-only request $${counted.toFixed(6)}, the reading month $${readMonth.toFixed(2)}, the checks' runs $${runs.toFixed(5)} a month`);
  is("the reading requests of a month stay under $6", readMonth < 6, true);
  is("a counted-only request stays under a hundredth of a cent", counted < 0.0001, true);
  is("the checks' kept runs add under a tenth of a cent a month", runs < 0.001, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
