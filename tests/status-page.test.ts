/**
 * 247 [SP4] unit 2: the public status page (/status), against the in-memory
 * Redis double only. It shows only what the site measures itself:
 *
 *   - the daily mail check and the daily Stripe check (test mode), each run
 *     kept as a time and a pass, a fail or "tested nothing", nothing else,
 *     the last STATUS_RUNS_KEPT of them; a mail run passes only when a
 *     delivery loop really ran (statusRunResult);
 *   - whether the database answered when the results were read.
 *
 * A check with no result in the last STATUS_STALE_HOURS is Unknown, never
 * Passed; a reply is read only in exactly the shape asked for, and a
 * malformed run, field or history makes the reading unknown, never a shorter
 * or empty history; a database that does not answer, or none set up, makes
 * the page say the results were not read, not that there were none.
 *
 * The page is drawn for each request, with no host page cache (no source in
 * this repository prices one). An instance answers from its last reading for
 * STATUS_MEMORY_MS; otherwise a request counts itself in its hour, and only
 * the first STATUS_VIEWS_PER_HOUR of the hour read the runs; an instance
 * that finds the hour used up sends nothing more until it turns, and one
 * address counts at most STATUS_COUNTS_PER_ADDRESS_PER_HOUR times an hour on
 * an instance. Every kind of request is priced below at the rates of
 * lib/spend-cost-table.ts and tests/traffic-cost.ts (read 7 October 2026).
 */
import { readFileSync } from "node:fs";
import {
  STATUS_CHECKS, STATUS_COUNTS_PER_ADDRESS_PER_HOUR, STATUS_COUNT_COMMANDS, STATUS_MEMORY_MS, STATUS_READ_COMMANDS, STATUS_RUNS_KEPT,
  STATUS_HOLD_MS, STATUS_STALE_HOURS, STATUS_VIEWS_PER_HOUR, describeStatus, forgetStatusMemory, notReadReason, parseRuns, readStatus, statusRunCommands,
  statusRunResult, statusViewKey, summarizeRuns,
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
const run = (at: number, ok: boolean | null) => JSON.stringify({ at, ok });
const oldPipeline = redis.pipeline;
let addressN = 0;
/** A fresh reading: this instance's memory forgotten, from a new address. */
async function fresh(now = NOW) {
  forgetStatusMemory();
  addressN += 1;
  return readStatus({ now, address: `192.0.2.${addressN % 250}:${addressN}` });
}
type Batch = (string | number)[][];
function watch(): Batch[] {
  const seen: Batch[] = [];
  redis.pipeline = async (batch) => { seen.push(batch.map((c) => [...c])); return oldPipeline.call(redis, batch); };
  return seen;
}
const unwatch = () => { redis.pipeline = oldPipeline; };

async function main(): Promise<void> {
  part("What a check run keeps: a time and a pass, a fail or nothing tested, the last 60, for 70 days");
  is("one entry pushed, the list cut to 60, kept 70 days", statusRunCommands(MAIL.key, NOW, true),
    [["LPUSH", MAIL.key, run(NOW, true)], ["LTRIM", MAIL.key, 0, 59], ["EXPIRE", MAIL.key, 70 * 86_400]]);
  is("a run that tested nothing is kept as such", statusRunCommands(MAIL.key, NOW, null)[0], ["LPUSH", MAIL.key, run(NOW, null)]);
  is("the two keys are the checks' own, one each", STATUS_CHECKS.map((c) => c.key), ["nl:mail-check:runs", "nl:stripe-check:runs"]);

  part("A mail run passes only when a delivery loop really ran");
  is("no check at all: failed", statusRunResult([]), false);
  is("only skipped loops and account checks, all ok: tested nothing", statusRunResult([{ ok: true }, { ok: true }]), null);
  is("a loop ran and everything passed: passed", statusRunResult([{ ok: true, loop: true }, { ok: true }]), true);
  is("a loop ran and failed: failed", statusRunResult([{ ok: false, loop: true }, { ok: true }]), false);
  is("no loop ran but a check failed: failed", statusRunResult([{ ok: false }, { ok: true }]), false);

  part("Where the runs are kept: after the run's own save and notice, apart, never able to stop them");
  for (const [file, index] of [["app/api/cron/mail-check/route.ts", 0], ["app/api/cron/stripe-check/route.ts", 1]] as const) {
    const route = readFileSync(file, "utf8");
    const save = route.indexOf('await redisPipeline([["SET", LAST');
    const keep = route.indexOf(`await redisPipeline(statusRunCommands(STATUS_CHECKS[${index}].key, at, `);
    const notice = route.lastIndexOf("await sendEmail(");
    is(`${file}: the save holds no status command`, route.slice(save, route.indexOf("\n", save)).includes("statusRunCommands"), false);
    is(`${file}: the run is kept after the save and the notice, its failure caught`,
      [keep > save, keep > notice, /statusRunCommands\([^\n]*\)\)\.catch\(/.test(route.slice(keep, route.indexOf("\n", keep) + 1))], [true, true, true]);
  }
  is("the mail route keeps the delivery result, not the run's ok", readFileSync("app/api/cron/mail-check/route.ts", "utf8").includes("statusRunCommands(STATUS_CHECKS[0].key, at, statusRunResult(checks))"), true);
  is("the Stripe check's every pass is a test-mode answer from Stripe: no check is passed without one",
    /ok:\s*true\b/.test(readFileSync("lib/verify-stripe.ts", "utf8")), false);

  part("Nothing recorded: the database answered, every check Unknown");
  redis.clear();
  let reading = await fresh();
  is("database answered, checks unknown", [reading.database, reading.limit, reading.checks.map((c) => c.summary.state)], ["answered", "none", ["unknown", "unknown"]]);
  is("no run is invented", reading.checks.map((c) => c.summary.runs), [0, 0]);

  part("A pass within 36 hours is a pass; a millisecond more is Unknown");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - 36 * HOUR, true)]);
  redis.run(["LPUSH", CHECKOUT.key, run(NOW - 36 * HOUR - 1, true)]);
  let seen = watch();
  reading = await fresh();
  unwatch();
  is("exactly 36 hours: passed; 36 hours and 1 ms: unknown", reading.checks.map((c) => c.summary.state), ["passed", "unknown"]);
  is("the old checkout result is still the last one", reading.checks[1].summary.last?.at, NOW - 36 * HOUR - 1);
  const hour = statusViewKey(NOW);
  is("the request counted in its hour, then each list read no further than kept",
    seen, [[["INCR", hour], ["EXPIRE", hour, 7200]], [["LRANGE", MAIL.key, 0, 59], ["LRANGE", CHECKOUT.key, 0, 59]]]);
  is("the commands priced are the commands sent", [seen[0].length, seen[1].length], [STATUS_COUNT_COMMANDS, STATUS_READ_COMMANDS]);
  is("the hour's key", hour, `nl:status:views:${Math.floor(NOW / HOUR)}`);

  part("A run that tested nothing is never a pass");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - DAY, true)]);
  redis.run(["LPUSH", MAIL.key, run(NOW - HOUR, null)]);
  reading = await fresh();
  is("state untested, counted apart", [reading.checks[0].summary.state, reading.checks[0].summary.passed, reading.checks[0].summary.untested], ["untested", 1, 1]);
  is("said in words, never Passed", describeStatus(reading).rows[1], { what: "Email delivery", result: "Unknown", when: "November 5, 2026 at 2:00 PM UTC: no email service was checked" });

  part("A failed last run is Failed, and every failure in the window is listed");
  redis.clear();
  for (const [at, ok] of [[NOW - 3 * DAY, true], [NOW - 2 * DAY, false], [NOW - DAY, true], [NOW - HOUR, false]] as const) redis.run(["LPUSH", MAIL.key, run(at, ok)]);
  const firstDay = Date.UTC(2026, 9, 7);
  redis.run(["LPUSH", MAIL.key, run(firstDay, false)]);
  redis.run(["LPUSH", MAIL.key, run(firstDay - 1, false)]);
  reading = await fresh();
  const mail = reading.checks[0].summary;
  is("failed now", mail.state, "failed");
  is("the window's first day (30 days with today) counts, the moment before it does not", [mail.runs, mail.passed, mail.failed, mail.since], [5, 2, 3, firstDay]);
  is("the failures, newest first", mail.failures, [NOW - HOUR, NOW - 2 * DAY, firstDay]);

  part("A history with a run that cannot be read is unknown, never a shorter one; runs come back newest first");
  for (const bad of ["{broken", JSON.stringify({ at: "x", ok: true }), JSON.stringify({ at: 1, ok: "true" }), JSON.stringify([1]), JSON.stringify({ at: 1 }), JSON.stringify({ at: 1, ok: true, more: 1 }), 7, null]) {
    is(`a history holding ${JSON.stringify(bad)} is unknown`, parseRuns([run(NOW, false), bad]), null);
  }
  is("not a list: unknown, not empty", parseRuns("nope"), null);
  is("an empty list is an empty history", parseRuns([]), []);
  is("exactly as many as kept are read", parseRuns(Array.from({ length: STATUS_RUNS_KEPT }, (_, i) => run(NOW - i * HOUR, true)))?.length, STATUS_RUNS_KEPT);
  is("more than kept is not the reply asked for: unknown", parseRuns(Array.from({ length: STATUS_RUNS_KEPT + 1 }, (_, i) => run(NOW - i * HOUR, true))), null);
  is("read in any order, given newest first", parseRuns([run(NOW - 2 * HOUR, true), run(NOW, false), run(NOW - HOUR, null)])?.map((r) => r.at), [NOW, NOW - HOUR, NOW - 2 * HOUR]);
  is("summarized in any order, the newest is the last", summarizeRuns([{ at: NOW - 2 * HOUR, ok: true }, { at: NOW - HOUR, ok: false }], NOW).last, { at: NOW - HOUR, ok: false });
  is("a run from the future is not a pass now", summarizeRuns([{ at: NOW + HOUR, ok: true }], NOW).state, "unknown");

  part("Days with no recorded run: counted from the first recorded day, never before");
  const gaps = summarizeRuns([{ at: NOW - 4 * DAY, ok: true }, { at: NOW - 2 * DAY, ok: true }, { at: NOW - HOUR, ok: true }], NOW);
  is("from the first run's day to today, the days with none", [gaps.since, gaps.daysWithoutRun], [Date.UTC(2026, 10, 1), 2]);
  is("today before its run is not counted as a day without one", summarizeRuns([{ at: NOW - DAY, ok: true }], Date.UTC(2026, 10, 5, 3)).daysWithoutRun, 0);
  is("nothing recorded: no days counted", summarizeRuns([], NOW).daysWithoutRun, 0);

  part("The 60th request of an hour reads; the 61st is counted, reads nothing, and the instance stops counting");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - 2 * HOUR, true)]);
  redis.run(["SET", hour, String(STATUS_VIEWS_PER_HOUR - 1)]);
  reading = await fresh();
  is("the 60th reads", [reading.limit, reading.checks[0].summary.state], ["none", "passed"]);
  seen = watch();
  reading = await fresh();
  is("the 61st: counted, no list read", seen.map((b) => b.map((c) => c[0])), [["INCR", "EXPIRE"]]);
  is("it says it did not read, the database answered, never a pass", [reading.limit, reading.database, reading.checks.map((c) => c.summary.state)], ["hour", "answered", ["unknown", "unknown"]]);
  is("in words, with when it reads again", describeStatus(reading).rows[1].when, `Not read: this page was opened more than ${STATUS_VIEWS_PER_HOUR} times this hour. It reads the results again from November 5, 2026 at 4:00 PM UTC`);
  seen.length = 0;
  addressN += 1;
  reading = await readStatus({ now: NOW + 2 * STATUS_MEMORY_MS, address: `other-${addressN}` });
  unwatch();
  is("the instance that found the hour used up sends nothing more in it", [seen.length, reading.limit], [0, "hour"]);
  reading = await readStatus({ now: NOW + HOUR, address: `other-${addressN}` });
  is("the next hour reads again", [reading.limit, reading.checks[0].summary.state], ["none", "passed"]);

  part("With the hour used up, an instance shows its last reading, with its time, rather than nothing (Revisor 1's light)");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - 2 * HOUR, true)]);
  redis.run(["SET", hour, String(STATUS_VIEWS_PER_HOUR - 1)]);
  const kept = await fresh();
  is("the instance reads, the 60th of the hour", [kept.limit, kept.checks[0].summary.state], ["none", "passed"]);
  addressN += 1;
  const after = await readStatus({ now: NOW + 2 * STATUS_MEMORY_MS, address: `held-${addressN}` });
  is("the 61st, on the same instance: its last reading, read at its own time, never a pass made up now", [after.limit, after.builtAt, after.checks[0].summary.state], ["none", NOW, "passed"]);
  is("and the page says when that reading was made", describeStatus(after).builtAt, describeStatus(kept).builtAt);
  seen = watch();
  addressN += 1;
  const later = await readStatus({ now: NOW + 3 * STATUS_MEMORY_MS, address: `held-${addressN}` });
  unwatch();
  is("the hour marked used up: the same reading again, with no database command", [seen.length, later.builtAt, later.limit], [0, NOW, "none"]);
  addressN += 1;
  const old = await readStatus({ now: NOW + STATUS_HOLD_MS + 1, address: `held-${addressN}` });
  is("a reading older than STATUS_HOLD_MS is not shown in its place", old.builtAt === NOW, false);

  part("Within a minute, an instance answers from memory, with no database command");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - 2 * HOUR, true)]);
  const first = await fresh();
  seen = watch();
  const again = await readStatus({ now: NOW + STATUS_MEMORY_MS - 1, address: "someone-else" });
  unwatch();
  is("the same reading, no command", [again === first, seen.length], [true, 0]);
  seen = watch();
  await readStatus({ now: NOW + STATUS_MEMORY_MS, address: "someone-else" });
  unwatch();
  is("a minute later it counts and reads again", seen.length, 2);

  part("One address cannot use up the hour for everybody from one instance");
  redis.clear();
  forgetStatusMemory();
  const counts: number[] = [];
  for (let i = 0; i < STATUS_COUNTS_PER_ADDRESS_PER_HOUR + 3; i += 1) {
    forgetStatusMemory();
    const r = await readStatus({ now: NOW + i * STATUS_MEMORY_MS, address: "198.51.100.7" });
    counts.push(r.limit === "address" ? 0 : 1);
  }
  is("counted the allowed times, then refused locally", counts, [...Array(STATUS_COUNTS_PER_ADDRESS_PER_HOUR).fill(1), 0, 0, 0]);
  is("the hour's count holds only those", redis.run(["GET", hour]), String(STATUS_COUNTS_PER_ADDRESS_PER_HOUR));
  forgetStatusMemory();
  reading = await readStatus({ now: NOW, address: "198.51.100.7" });
  is("said in words", describeStatus(reading).rows[1].when, "Not read: this page was opened many times from your network this hour. It reads the results again for you from November 5, 2026 at 4:00 PM UTC");

  part("A count that cannot be read is not room to read, and is said as such");
  for (const answer of [null, "x", "0", -1, 1.5]) {
    redis.clear();
    redis.pipeline = async (batch) => (batch[0][0] === "INCR" ? [answer, 1] : oldPipeline.call(redis, batch));
    reading = await fresh();
    unwatch();
    is(`INCR answered ${JSON.stringify(answer)}: not read, the database answered`, [reading.limit, reading.database], ["count-unread", "answered"]);
  }
  is("in true words", describeStatus(reading).rows[1].when, "Not read: the count of visits this hour could not be read");

  part("Only a reply of exactly the shape asked for is read; anything else is unknown, never an empty history");
  async function shaped(alter: (batch: Batch, answers: unknown[]) => unknown) {
    redis.clear();
    redis.run(["LPUSH", MAIL.key, run(NOW - HOUR, false)]);
    redis.run(["LPUSH", CHECKOUT.key, run(NOW - HOUR, true)]);
    redis.pipeline = async (batch) => alter(batch, await oldPipeline.call(redis, batch)) as unknown[];
    try { return await fresh(); } finally { unwatch(); }
  }
  const unread = (r: Awaited<ReturnType<typeof fresh>>) => [r.database, r.checks.map((c) => [c.summary.state, c.summary.runs])];
  const NOTHING = ["no-answer", [["unknown", 0], ["unknown", 0]]];
  is("control: the exact replies are read", unread(await shaped((_b, a) => a)), ["answered", [["failed", 1], ["passed", 1]]]);
  const isCount = (b: Batch) => b[0]?.[0] === "INCR";
  const isRead = (b: Batch) => b[0]?.[0] === "LRANGE";
  is("EXPIRE acknowledged with 0: unknown", unread(await shaped((b, a) => isCount(b) ? [a[0], 0] : a)), NOTHING);
  is("EXPIRE acknowledged with \"1\": unknown", unread(await shaped((b, a) => isCount(b) ? [a[0], "1"] : a)), NOTHING);
  is("a count reply that is not a list: unknown", unread(await shaped((b, a) => isCount(b) ? { 0: a[0], 1: 1, length: 2 } : a)), NOTHING);
  is("a count reply with a hole: unknown", unread(await shaped((b, a) => isCount(b) ? [, 1] : a)), NOTHING);
  is("a count reply whose value is a getter: unknown, never run", unread(await shaped((b, a) => {
    if (!isCount(b)) return a;
    const r: unknown[] = [0, 1];
    Object.defineProperty(r, 0, { get: () => { throw new Error("ran a getter"); } });
    return r;
  })), NOTHING);
  is("an extra history in the reply: unknown", unread(await shaped((b, a) => isRead(b) ? [...a, []] : a)), NOTHING);
  is("a history that is not a list: unknown, never empty", unread(await shaped((b, a) => isRead(b) ? [a[0], null] : a)), NOTHING);
  is("a history longer than asked for: unknown", unread(await shaped((b, a) => isRead(b) ? [a[0], Array.from({ length: STATUS_RUNS_KEPT + 1 }, () => run(NOW - HOUR, true))] : a)), NOTHING);
  is("a run that is not text: unknown, never dropped", unread(await shaped((b, a) => isRead(b) ? [[...(a[0] as unknown[]), 7], a[1]] : a)), NOTHING);
  is("a run that cannot be read: unknown, never dropped from the count", unread(await shaped((b, a) => isRead(b) ? [[...(a[0] as unknown[]), "{broken"], a[1]] : a)), NOTHING);
  is("a run with a field more than kept: unknown", unread(await shaped((b, a) => isRead(b) ? [[JSON.stringify({ at: NOW - HOUR, ok: false, why: "x" })], a[1]] : a)), NOTHING);
  reading = await shaped((b, a) => isRead(b) ? [a[0]] : a);
  is("in words: not read, never \"no failed run\"", [describeStatus(reading).rows.map((r) => r.result), notReadReason(reading)],
    [["Did not answer", "Unknown", "Unknown"], "Not read: the database did not answer, or its answer could not be read"]);

  part("The database does not answer, or none is set up: the results were not read, never \"none recorded\"");
  redis.pipeline = async () => { throw new Error("synthetic outage"); };
  reading = await fresh();
  unwatch();
  is("did not answer", [reading.database, reading.limit], ["no-answer", "none"]);
  const down = describeStatus(reading);
  is("every check row says it was not read", down.rows.slice(1).map((r) => [r.result, r.when]), [["Unknown", "Not read: the database did not answer, or its answer could not be read"], ["Unknown", "Not read: the database did not answer, or its answer could not be read"]]);
  is("and the history says so too", notReadReason(reading), "Not read: the database did not answer, or its answer could not be read");
  const unset = describeStatus({ ...reading, database: "unset" });
  is("no database set up: said as such", unset.rows.slice(1).map((r) => r.when), ["Not read: no database is set up where this page was put together", "Not read: no database is set up where this page was put together"]);

  part("What the page says");
  redis.clear();
  redis.run(["LPUSH", MAIL.key, run(NOW - 2 * HOUR, true)]);
  const view = describeStatus(await fresh());
  is("read time in plain words, with the time zone", view.builtAt, "November 5, 2026 at 3:00 PM UTC");
  is("results in words, never a color alone", view.rows.map((r) => r.result), ["Answered", "Passed", "Unknown"]);
  is("when a check has no result, it says why", view.rows[2].when, `No result in the last ${STATUS_STALE_HOURS} hours`);
  const page = readFileSync("app/status/page.tsx", "utf8");
  is("drawn for each request, never kept in the host's page cache", [page.includes('export const dynamic = "force-dynamic";'), /revalidate|force-static|unstable_cache|"use cache"/.test(page)], [true, false]);
  is("the history says why it was not read, from the same words", page.includes("notReadReason(reading)"), true);
  is("the address is the connection's, as the other paces read it", page.includes("paceAddress(clientAddress("), true);
  const all = page + readFileSync("lib/status-page.ts", "utf8");
  for (const banned of [/operational/i, /all systems/i, /\d+(\.\d+)?\s*%/, /99\.9/, /uptime of/i, /guarantee/i, /always (up|on)/i, /clientDayShare/]) {
    is(`no claim that is not so: ${banned}`, banned.test(all), false);
  }
  for (const said of ["No outside service watches it", "if the site is down, this page is down too", "We do not show an uptime percentage", "Stripe's test mode", "No real card is charged"]) {
    is(`it says what it does not measure: ${said}`, page.includes(said), true);
  }
  is("reached from every page's footer", readFileSync("components/site-footer.tsx", "utf8").includes('{ label: "Status", href: "/status" }'), true);

  part("What the page costs, a company cost: every kind of request priced, the database work bounded");
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
  const fromMemory = request(0, 0, 0);
  const MONTH_HOURS = 31 * 24;
  // The whole site's reads: at most STATUS_VIEWS_PER_HOUR an hour.
  const readMonth = STATUS_VIEWS_PER_HOUR * MONTH_HOURS * reads;
  // One instance's database work beyond them: at most one round a minute (its memory), each a count.
  const instanceMonth = (HOUR / STATUS_MEMORY_MS) * MONTH_HOURS * (counted - fromMemory);
  const runs = 2 * 31 * 3 * COMMAND + 2 * STATUS_RUNS_KEPT * 64 * DB_BYTE;
  console.log(`  cost  reading $${reads.toFixed(6)}, counted-only $${counted.toFixed(6)}, from memory $${fromMemory.toFixed(6)} a request; the site's reads $${readMonth.toFixed(2)} a month; one instance's counts beyond them $${instanceMonth.toFixed(2)} a month; the checks' runs $${runs.toFixed(5)} a month`);
  is("the whole site's reading requests stay under $6 a month", readMonth < 6, true);
  is("one instance's database work beyond them stays under $4 a month", instanceMonth < 4, true);
  is("a request answered from memory stays under six thousandths of a cent", fromMemory < 0.00006, true);
  is("the checks' kept runs add under a tenth of a cent a month", runs < 0.001, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
