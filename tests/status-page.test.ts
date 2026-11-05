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
 * that does not answer makes every check Unknown. The page is put together
 * at most once every STATUS_REVALIDATE_SECONDS, so its reads do not grow
 * with its visitors: its month is priced below from lib/spend-cost-table.ts.
 */
import { readFileSync } from "node:fs";
import {
  STATUS_CHECKS, STATUS_READ_COMMANDS, STATUS_REBUILDS_MONTH_MAX, STATUS_REVALIDATE_SECONDS, STATUS_RUNS_KEPT, STATUS_RUNS_SECONDS,
  STATUS_STALE_HOURS, STATUS_WINDOW_DAYS, describeStatus, parseRuns, readStatus, statusRunCommands, summarizeRuns,
} from "@/lib/status-page";
import {
  UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";
import { REDIS_TIMEOUT_MS } from "@/lib/fetch-timeout";
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
  is("one pipeline, the fixed commands, each list read no further than kept",
    seen, [[["LRANGE", MAIL.key, 0, STATUS_RUNS_KEPT - 1], ["LRANGE", CHECKOUT.key, 0, STATUS_RUNS_KEPT - 1]]]);
  is("the commands counted for the price are the commands sent", seen[0].length, STATUS_READ_COMMANDS);
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
  const words = JSON.stringify(describeStatus({ builtAt: NOW, database: "no-answer", checks: (await readStatus(NOW)).checks.map((c) => ({ ...c, summary: summarizeRuns([], NOW) })) }));
  is("a database that did not answer is said plainly", words.includes("Did not answer"), true);
  const page = readFileSync("app/status/page.tsx", "utf8");
  is("put together ahead of time, again at most once an hour", [page.includes('export const dynamic = "force-static";'), page.includes(`export const revalidate = ${STATUS_REVALIDATE_SECONDS};`), STATUS_REVALIDATE_SECONDS], [true, true, 3600]);
  const all = page + readFileSync("lib/status-page.ts", "utf8");
  for (const banned of [/operational/i, /all systems/i, /\d+(\.\d+)?\s*%/, /99\.9/, /uptime of/i, /guarantee/i, /always (up|on)/i]) {
    is(`no claim that is not measured: ${banned}`, banned.test(all), false);
  }
  for (const said of ["No outside service watches it", "if the site is down, this page is down too", "We do not show an uptime percentage", "Stripe's test mode", "No real card is charged"]) {
    is(`it says what it does not measure: ${said}`, page.includes(said), true);
  }
  is("reached from every page's footer", readFileSync("components/site-footer.tsx", "utf8").includes('{ label: "Status", href: "/status" }'), true);

  part("What the page costs, a company fixed cost: bounded by its schedule, not by its visitors");
  is("rebuilds a month at most: one an hour", STATUS_REBUILDS_MONTH_MAX, 31 * 24);
  const micro = (n: number) => n / 1_000_000;
  // Each rebuild at its worst: the Redis wait whole and as long again to draw, at the function's memory and a full CPU.
  const seconds = (2 * REDIS_TIMEOUT_MS) / 1000;
  const bytes = STATUS_READ_COMMANDS * STATUS_RUNS_KEPT * 64;
  const rebuild = STATUS_READ_COMMANDS * micro(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6
    + bytes * micro(UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e9
    + micro(VERCEL_CALL_MICRO_USD_PER_MILLION) / 1e6
    + seconds * micro(VERCEL_CPU_MICRO_USD_PER_HOUR) / 3600
    + seconds * VERCEL_FUNCTION_GB * micro(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) / 3600;
  const month = rebuild * STATUS_REBUILDS_MONTH_MAX;
  // The checks' own runs: three more commands each in a save they already send, every day.
  const runs = 2 * 31 * 3 * micro(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6;
  is(`the month's rebuilds and kept runs stay under 40 cents ($${(month + runs).toFixed(4)}; Vercel's own page cache is priced outside lib/spend-cost-table.ts)`, month + runs < 0.4, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
