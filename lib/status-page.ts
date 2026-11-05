/**
 * The public status page (247 [SP4] unit 2, app/status/page.tsx): only what
 * the site measures itself, never a result it does not have.
 *
 *   - The daily mail check (app/api/cron/mail-check, lib/verify-mail.ts) and
 *     the daily Stripe check in test mode (app/api/cron/stripe-check,
 *     lib/verify-stripe.ts) each keep their runs here, in the same save as
 *     their last result: a time and a pass or fail, nothing of what failed
 *     or why, the last STATUS_RUNS_KEPT, for STATUS_RUNS_SECONDS.
 *   - Whether the database answered when the page was put together: the
 *     page's one read of those runs is that answer.
 *
 * A check with no result in the last STATUS_STALE_HOURS is Unknown, a run
 * that cannot be read is dropped (never counted as a pass), and a database
 * that does not answer makes every check Unknown.
 *
 * Its cost is the company's (MR item 2). The page is drawn for each request,
 * with no host page cache (no source in this repository prices one). Each
 * request first counts itself in its hour (STATUS_COUNT_COMMANDS); only the
 * first STATUS_VIEWS_PER_HOUR of an hour read the runs
 * (STATUS_READ_COMMANDS more). Past that, a request reads nothing more and
 * the page says the results were not read and from when they are read
 * again. tests/status-page.test.ts prices both kinds of request at the
 * rates of lib/spend-cost-table.ts and tests/traffic-cost.ts: the reading
 * ones are bounded by the hour's count, the counted-only ones cost a fixed
 * amount each, and their number past that is the host firewall's to stop,
 * as for every store page (lib/traffic-rules.ts, clientDayShare).
 *
 *   nl:mail-check:runs       list    {"at":<ms>,"ok":<bool>}, newest first
 *   nl:stripe-check:runs     list    the same, for the Stripe check
 *   nl:status:views:<hour>   string  the hour's requests, kept two hours
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

type Command = (string | number)[];

/** The checks the page shows, in its order, with the list each keeps its runs in. */
export const STATUS_CHECKS = [
  { id: "mail", key: "nl:mail-check:runs", name: "Email delivery" },
  { id: "checkout", key: "nl:stripe-check:runs", name: "Checkout (Stripe test mode)" },
] as const;

/** Runs kept per check: two months of daily runs, more than the window shown. */
export const STATUS_RUNS_KEPT = 60;
/** How long the runs are kept after the last one: 70 days. */
export const STATUS_RUNS_SECONDS = 70 * 86_400;
/** The days the page counts runs over. */
export const STATUS_WINDOW_DAYS = 30;
/** A result older than this is not today's: the check is Unknown. Daily runs, with half a day of room. */
export const STATUS_STALE_HOURS = 36;
/** Requests in an hour (UTC) that read the runs; past it, a request is counted and reads nothing more. */
export const STATUS_VIEWS_PER_HOUR = 60;
/** How long an hour's count is kept: past its hour, so a late request still finds it. */
export const STATUS_VIEW_KEY_SECONDS = 2 * 3600;
/** Commands every request sends to count itself: INCR and EXPIRE, in one pipeline. */
export const STATUS_COUNT_COMMANDS = 2;
/** Commands a reading request sends after that: one read of each check's runs, in one pipeline. */
export const STATUS_READ_COMMANDS = STATUS_CHECKS.length;

const HOUR_MS = 3_600_000;
/** The key an hour's requests are counted in. */
export const statusViewKey = (now: number) => `nl:status:views:${Math.floor(now / HOUR_MS)}`;

export type StatusRun = { at: number; ok: boolean };

/** What a check run adds to the save it already sends: its time and result, the list cut, and its life. */
export function statusRunCommands(key: string, at: number, ok: boolean): Command[] {
  return [
    ["LPUSH", key, JSON.stringify({ at, ok })],
    ["LTRIM", key, 0, STATUS_RUNS_KEPT - 1],
    ["EXPIRE", key, STATUS_RUNS_SECONDS],
  ];
}

/** The runs read back, newest first; anything that is not exactly a time and a true or false is dropped. */
export function parseRuns(raw: unknown): StatusRun[] {
  if (!Array.isArray(raw)) return [];
  const runs: StatusRun[] = [];
  for (const item of raw.slice(0, STATUS_RUNS_KEPT)) {
    if (typeof item !== "string") continue;
    try {
      const value: unknown = JSON.parse(item);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const { at, ok } = value as { at?: unknown; ok?: unknown };
      if (typeof at === "number" && Number.isFinite(at) && at > 0 && typeof ok === "boolean") runs.push({ at, ok });
    } catch {
      /* A run that cannot be read is not a result. */
    }
  }
  return runs.sort((a, b) => b.at - a.at);
}

export type StatusSummary = {
  state: "passed" | "failed" | "unknown";
  /** The newest run, however old. */
  last: StatusRun | null;
  /** Runs, passes and failures in the window. */
  runs: number;
  passed: number;
  failed: number;
  /** The failed runs' times in the window, newest first. */
  failures: number[];
  /** The UTC day counting starts: the window's first day or the first recorded run's, whichever is later; null with none. */
  since: number | null;
  /** Days from `since` to today with no recorded run; today counts only once it has one. */
  daysWithoutRun: number;
};

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** What the runs say at `now`. */
export function summarizeRuns(all: StatusRun[], now: number): StatusSummary {
  const past = all.filter((r) => r.at <= now).sort((a, b) => b.at - a.at);
  const last = past[0] ?? null;
  const fresh = last && now - last.at <= STATUS_STALE_HOURS * 3_600_000;
  const state = !fresh ? "unknown" : last.ok ? "passed" : "failed";
  const windowStart = dayOf(now) - (STATUS_WINDOW_DAYS - 1) * DAY_MS;
  const inWindow = past.filter((r) => r.at >= windowStart);
  const failures = inWindow.filter((r) => !r.ok).map((r) => r.at);
  const oldest = inWindow[inWindow.length - 1];
  const since = oldest ? dayOf(oldest.at) : null;
  let daysWithoutRun = 0;
  if (since !== null) {
    const days = new Set(inWindow.map((r) => dayOf(r.at)));
    for (let day = since; day < dayOf(now); day += DAY_MS) if (!days.has(day)) daysWithoutRun += 1;
  }
  return { state, last, runs: inWindow.length, passed: inWindow.length - failures.length, failed: failures.length, failures, since, daysWithoutRun };
}

export type StatusReading = {
  builtAt: number;
  /** True when the hour's reads were used up, so the runs were not read. */
  busy: boolean;
  /** Whether the database answered the page's read; "unset" where no database is set up (a build without one). */
  database: "answered" | "no-answer" | "unset";
  checks: { id: (typeof STATUS_CHECKS)[number]["id"]; name: string; summary: StatusSummary }[];
};

/**
 * The request counted in its hour (STATUS_COUNT_COMMANDS), then, for the
 * first STATUS_VIEWS_PER_HOUR of the hour only, one read of every check's
 * runs (STATUS_READ_COMMANDS), each in its own pipeline.
 */
export async function readStatus(now: number = Date.now()): Promise<StatusReading> {
  const empty = (database: StatusReading["database"], busy = false): StatusReading => ({
    builtAt: now,
    busy,
    database,
    checks: STATUS_CHECKS.map((c) => ({ id: c.id, name: c.name, summary: summarizeRuns([], now) })),
  });
  if (!isRedisConfigured()) return empty("unset");
  let answers: unknown[];
  try {
    const key = statusViewKey(now);
    const [count] = await redisPipeline([["INCR", key], ["EXPIRE", key, STATUS_VIEW_KEY_SECONDS]]);
    // A count that cannot be read is not room to read.
    const seen = Number(count);
    if (!Number.isSafeInteger(seen) || seen < 1 || seen > STATUS_VIEWS_PER_HOUR) return empty("answered", true);
    answers = await redisPipeline(STATUS_CHECKS.map((c) => ["LRANGE", c.key, 0, STATUS_RUNS_KEPT - 1]));
  } catch {
    return empty("no-answer");
  }
  return {
    builtAt: now,
    busy: false,
    database: "answered",
    checks: STATUS_CHECKS.map((c, i) => ({ id: c.id, name: c.name, summary: summarizeRuns(parseRuns(answers[i]), now) })),
  };
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
/** "November 5, 2026 at 3:00 PM UTC", put together from two parts so no runtime's joining word changes it. */
export const statusTime = (ms: number) => `${DATE.format(new Date(ms))} at ${CLOCK.format(new Date(ms))} UTC`;
export const statusDate = (ms: number) => DATE.format(new Date(ms));

export type StatusRow = { what: string; result: "Answered" | "Did not answer" | "Passed" | "Failed" | "Unknown"; when: string };

/** The page's words for a reading: a result in words for each row, and when it was measured. */
export function describeStatus(reading: StatusReading): { builtAt: string; rows: StatusRow[] } {
  const builtAt = statusTime(reading.builtAt);
  const database: StatusRow = reading.database === "answered"
    ? { what: "Database", result: "Answered", when: builtAt }
    : reading.database === "no-answer"
      ? { what: "Database", result: "Did not answer", when: builtAt }
      : { what: "Database", result: "Unknown", when: "No database is set up where this page was put together" };
  const nextHour = statusTime((Math.floor(reading.builtAt / HOUR_MS) + 1) * HOUR_MS);
  const rows = reading.checks.map(({ name, summary }): StatusRow => {
    if (reading.busy) {
      return { what: name, result: "Unknown", when: `Not read: this page was opened more than ${STATUS_VIEWS_PER_HOUR} times this hour. It reads the results again from ${nextHour}` };
    }
    if (summary.state === "unknown") {
      return { what: name, result: "Unknown", when: `No result in the last ${STATUS_STALE_HOURS} hours` };
    }
    return { what: name, result: summary.state === "passed" ? "Passed" : "Failed", when: statusTime(summary.last!.at) };
  });
  return { builtAt, rows: [database, ...rows] };
}
