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
 * Its cost is the company's (a fixed cost, MR item 2): the page is put
 * together ahead of time and again at most once every
 * STATUS_REVALIDATE_SECONDS, whoever opens it, so its reads are bounded by
 * that schedule (STATUS_REBUILDS_MONTH_MAX a month, STATUS_READ_COMMANDS
 * each), not by its visitors. tests/status-page.test.ts prices the month.
 *
 *   nl:mail-check:runs     list  {"at":<ms>,"ok":<bool>}, newest first
 *   nl:stripe-check:runs   list  the same, for the Stripe check
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
/** The page is put together again at most this often (app/status/page.tsx, revalidate). */
export const STATUS_REVALIDATE_SECONDS = 3600;
/** Rebuilds in a month at the most: one an hour for 31 days. */
export const STATUS_REBUILDS_MONTH_MAX = (31 * 86_400) / STATUS_REVALIDATE_SECONDS;
/** Commands one rebuild sends: one read of each check's runs, in one pipeline. */
export const STATUS_READ_COMMANDS = STATUS_CHECKS.length;

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
  /** Whether the database answered the page's read; "unset" where no database is set up (a build without one). */
  database: "answered" | "no-answer" | "unset";
  checks: { id: (typeof STATUS_CHECKS)[number]["id"]; name: string; summary: StatusSummary }[];
};

/** One read of every check's runs, in one pipeline of STATUS_READ_COMMANDS commands. */
export async function readStatus(now: number = Date.now()): Promise<StatusReading> {
  const empty = (database: StatusReading["database"]): StatusReading => ({
    builtAt: now,
    database,
    checks: STATUS_CHECKS.map((c) => ({ id: c.id, name: c.name, summary: summarizeRuns([], now) })),
  });
  if (!isRedisConfigured()) return empty("unset");
  let answers: unknown[];
  try {
    answers = await redisPipeline(STATUS_CHECKS.map((c) => ["LRANGE", c.key, 0, STATUS_RUNS_KEPT - 1]));
  } catch {
    return empty("no-answer");
  }
  return {
    builtAt: now,
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
  const rows = reading.checks.map(({ name, summary }): StatusRow => {
    if (summary.state === "unknown") {
      return { what: name, result: "Unknown", when: `No result in the last ${STATUS_STALE_HOURS} hours` };
    }
    return { what: name, result: summary.state === "passed" ? "Passed" : "Failed", when: statusTime(summary.last!.at) };
  });
  return { builtAt, rows: [database, ...rows] };
}
