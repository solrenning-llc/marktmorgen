/**
 * The public status page (247 [SP4] unit 2, app/status/page.tsx): only what
 * the site measures itself, never a result it does not have.
 *
 *   - The daily mail check (app/api/cron/mail-check, lib/verify-mail.ts) and
 *     the daily Stripe check in test mode (app/api/cron/stripe-check,
 *     lib/verify-stripe.ts) each keep their runs here, after their own save
 *     and notice: a time and a pass, a fail or "tested nothing", nothing of
 *     what failed or why, the last STATUS_RUNS_KEPT, for STATUS_RUNS_SECONDS.
 *     A mail run passes only when at least one email service's delivery loop
 *     ran and everything passed (statusRunResult); with no loop run it tested
 *     nothing, and the page never says Passed for it.
 *   - Whether the database answered when the results were read.
 *
 * A check with no result in the last STATUS_STALE_HOURS is Unknown. A reply
 * is read only in exactly the shape asked for (statusReplyValues, parseRuns):
 * a missing or extra field, a value of another kind, a history longer than
 * asked for or a run that cannot be read makes the whole reading unknown,
 * never an empty or shorter history (CX-123 rule 24). When the database did
 * not answer, answered in another shape or is not set up, the page says the
 * results were not read rather than that there were none.
 *
 * Its cost is the company's (MR item 2). The page is drawn for each request,
 * with no host page cache (no source in this repository prices one), and:
 *
 *   - each server instance keeps the last reading for STATUS_MEMORY_MS and
 *     answers from it without the database;
 *   - otherwise a request counts itself in its hour (STATUS_COUNT_COMMANDS),
 *     and only the first STATUS_VIEWS_PER_HOUR of the hour read the runs
 *     (STATUS_READ_COMMANDS more); an instance that finds the hour used up
 *     marks it and sends nothing more until the hour turns;
 *   - one address may make an instance count at most
 *     STATUS_COUNTS_PER_ADDRESS_PER_HOUR times an hour (lib/local-limit.ts),
 *     so one client cannot use up the hour for everybody from one instance.
 *
 * So the database work is bounded per instance (one round a minute at the
 * most), and reading the runs is bounded for the whole site. Every request,
 * whatever it does, is a function call; their number is the host firewall's
 * to stop, as for every page drawn per request on this site. All of it is
 * priced in tests/status-page.test.ts.
 *
 *   nl:mail-check:runs       list    {"at":<ms>,"ok":<true|false|null>}, newest first
 *   nl:stripe-check:runs     list    the same, for the Stripe check
 *   nl:status:views:<hour>   string  the hour's counted requests, kept two hours
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLocalLimit } from "@/lib/local-limit";

type Command = (string | number)[];

/** The checks the page shows, in its order, with the list each keeps its runs in and what a run that tested nothing means. */
export const STATUS_CHECKS = [
  { id: "mail", key: "nl:mail-check:runs", name: "Email delivery", untested: "no email service was checked" },
  { id: "checkout", key: "nl:stripe-check:runs", name: "Checkout (Stripe test mode)", untested: "nothing was checked" },
] as const;

/** Runs kept per check: two months of daily runs, more than the window shown. */
export const STATUS_RUNS_KEPT = 60;
/** How long the runs are kept after the last one: 70 days. */
export const STATUS_RUNS_SECONDS = 70 * 86_400;
/** The days the page counts runs over. */
export const STATUS_WINDOW_DAYS = 30;
/** A result older than this is not today's: the check is Unknown. Daily runs, with half a day of room. */
export const STATUS_STALE_HOURS = 36;
/** Requests in an hour (UTC), for the whole site, that read the runs. */
export const STATUS_VIEWS_PER_HOUR = 60;
/** How long an hour's count is kept: past its hour, so a late request still finds it. */
export const STATUS_VIEW_KEY_SECONDS = 2 * 3600;
/** Commands a counted request sends: INCR and EXPIRE, in one pipeline. */
export const STATUS_COUNT_COMMANDS = 2;
/** Commands a reading request sends after that: one read of each check's runs, in one pipeline. */
export const STATUS_READ_COMMANDS = STATUS_CHECKS.length;
/** How long an instance answers from its last reading without the database. */
export const STATUS_MEMORY_MS = 60_000;
/**
 * How long an instance's last reading may stand in when the hour's reads are
 * used up (Revisor 1's light on #2545): shown with its own time, so the page
 * says when it was read, never as a reading made now. Older than this, the
 * page says it did not read.
 */
export const STATUS_HOLD_MS = 2 * 3_600_000;
/** Times one address may make one instance count in an hour (lib/local-limit.ts). */
export const STATUS_COUNTS_PER_ADDRESS_PER_HOUR = 5;

const HOUR_MS = 3_600_000;
const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
/** The key an hour's requests are counted in. */
export const statusViewKey = (now: number) => `nl:status:views:${hourOf(now)}`;

/** A run: when, and whether it passed, failed, or tested nothing (null). */
export type StatusRun = { at: number; ok: boolean | null };

/** What a check run sends, after its own save: its time and result, the list cut, and its life. */
export function statusRunCommands(key: string, at: number, ok: boolean | null): Command[] {
  return [
    ["LPUSH", key, JSON.stringify({ at, ok })],
    ["LTRIM", key, 0, STATUS_RUNS_KEPT - 1],
    ["EXPIRE", key, STATUS_RUNS_SECONDS],
  ];
}

/**
 * A mail run's result for the page: failed when any check failed (or there
 * were none), passed only when at least one delivery loop really ran
 * (lib/verify-mail.ts marks its checks `loop: true`), otherwise null: it
 * tested no delivery, so it is neither a pass nor a fail.
 */
export function statusRunResult(checks: readonly { ok: boolean; loop?: boolean }[]): boolean | null {
  if (checks.length === 0 || checks.some((c) => !c.ok)) return false;
  return checks.some((c) => c.loop === true) ? true : null;
}

/**
 * The values of a reply that is a plain list of `min` to `max` entries, read
 * from its own data fields without running anything it holds (as
 * withinEssentialLimit in lib/request-guard.ts reads its reply); null for
 * anything else: not a list, a length out of range, a hole or a getter.
 */
export function statusReplyValues(reply: unknown, min: number, max: number): unknown[] | null {
  if (!Array.isArray(reply)) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value") || !Number.isSafeInteger(length.value) || length.value < min || length.value > max) return null;
  const values: unknown[] = [];
  for (let i = 0; i < length.value; i += 1) {
    const entry = Object.getOwnPropertyDescriptor(reply, String(i));
    if (!entry || !Object.hasOwn(entry, "value")) return null;
    values.push(entry.value);
  }
  return values;
}

/**
 * One check's runs as read back, newest first: a list of at most
 * STATUS_RUNS_KEPT texts, each exactly {"at":<ms>,"ok":<true|false|null>}.
 * Null when anything in it is not so: a history that cannot be read in full
 * is unknown, never a shorter one (a dropped run could be a failure).
 */
export function parseRuns(raw: unknown): StatusRun[] | null {
  const items = statusReplyValues(raw, 0, STATUS_RUNS_KEPT);
  if (!items) return null;
  const runs: StatusRun[] = [];
  for (const item of items) {
    if (typeof item !== "string") return null;
    let value: unknown;
    try {
      value = JSON.parse(item);
    } catch {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 2 || !Object.hasOwn(value, "at") || !Object.hasOwn(value, "ok")) return null;
    const { at, ok } = value as { at: unknown; ok: unknown };
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || !(typeof ok === "boolean" || ok === null)) return null;
    runs.push({ at, ok });
  }
  return runs.sort((a, b) => b.at - a.at);
}

export type StatusSummary = {
  state: "passed" | "failed" | "untested" | "unknown";
  /** The newest run, however old. */
  last: StatusRun | null;
  /** Runs in the window: all, passed, failed and those that tested nothing. */
  runs: number;
  passed: number;
  failed: number;
  untested: number;
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
  const fresh = last !== null && now - last.at <= STATUS_STALE_HOURS * HOUR_MS;
  const state = !fresh ? "unknown" : last.ok === true ? "passed" : last.ok === false ? "failed" : "untested";
  const windowStart = dayOf(now) - (STATUS_WINDOW_DAYS - 1) * DAY_MS;
  const inWindow = past.filter((r) => r.at >= windowStart);
  const failures = inWindow.filter((r) => r.ok === false).map((r) => r.at);
  const passed = inWindow.filter((r) => r.ok === true).length;
  const oldest = inWindow[inWindow.length - 1];
  const since = oldest ? dayOf(oldest.at) : null;
  let daysWithoutRun = 0;
  if (since !== null) {
    const days = new Set(inWindow.map((r) => dayOf(r.at)));
    for (let day = since; day < dayOf(now); day += DAY_MS) if (!days.has(day)) daysWithoutRun += 1;
  }
  return {
    state, last, runs: inWindow.length, passed, failed: failures.length, untested: inWindow.length - passed - failures.length,
    failures, since, daysWithoutRun,
  };
}

/**
 * Why the runs were not read, when they were not: the hour's reads used up,
 * this address's counts on this instance used up, or the hour's count
 * unreadable. "none" when they were read, or the database is the reason.
 */
export type StatusLimit = "none" | "hour" | "address" | "count-unread";

export type StatusReading = {
  /** When the results were read (or found not readable). */
  builtAt: number;
  limit: StatusLimit;
  /** Whether the database answered, in exactly the shape asked for; "unset" where no database is set up (a build without one). */
  database: "answered" | "no-answer" | "unset";
  checks: { id: (typeof STATUS_CHECKS)[number]["id"]; name: string; untested: string; summary: StatusSummary }[];
};

/** This instance's memory: its last reading, and the hour it found used up. */
let remembered: StatusReading | null = null;
let usedUpHour = -1;

/** Forgets this instance's memory (the tests, between cases). */
export function forgetStatusMemory(): void {
  remembered = null;
  usedUpHour = -1;
}

/** With the hour used up: this instance's last real reading while it is recent enough, else "not read". */
function heldOrHour(now: number): StatusReading {
  if (remembered && remembered.limit === "none" && remembered.database === "answered" && now >= remembered.builtAt && now - remembered.builtAt <= STATUS_HOLD_MS) return remembered;
  return notRead(now, "answered", "hour");
}

function notRead(now: number, database: StatusReading["database"], limit: StatusLimit): StatusReading {
  return {
    builtAt: now,
    limit,
    database,
    checks: STATUS_CHECKS.map((c) => ({ id: c.id, name: c.name, untested: c.untested, summary: summarizeRuns([], now) })),
  };
}

/**
 * One request's reading. From this instance's memory while it is younger
 * than STATUS_MEMORY_MS; otherwise, unless the hour is marked used up or the
 * address has counted too often here, the request counted in its hour
 * (STATUS_COUNT_COMMANDS) and, for the first STATUS_VIEWS_PER_HOUR of the
 * hour only, one read of every check's runs (STATUS_READ_COMMANDS).
 */
export async function readStatus({ now = Date.now(), address = "unknown" }: { now?: number; address?: string } = {}): Promise<StatusReading> {
  if (!isRedisConfigured()) return notRead(now, "unset", "none");
  if (remembered && now >= remembered.builtAt && now - remembered.builtAt < STATUS_MEMORY_MS) return remembered;
  if (usedUpHour === hourOf(now)) return heldOrHour(now);
  if (!withinLocalLimit("status-count", address, STATUS_COUNTS_PER_ADDRESS_PER_HOUR, HOUR_MS, now)) return notRead(now, "answered", "address");
  let reading: StatusReading;
  try {
    const key = statusViewKey(now);
    // Exactly the two answers asked for, the second EXPIRE's 1 (the key it was just counted in exists);
    // anything else is not an answer, and the reading is unknown.
    const counted = statusReplyValues(await redisPipeline([["INCR", key], ["EXPIRE", key, STATUS_VIEW_KEY_SECONDS]]), STATUS_COUNT_COMMANDS, STATUS_COUNT_COMMANDS);
    if (!counted || counted[1] !== 1) throw new Error("status: the count's reply is not the one asked for");
    const seen = counted[0];
    if (typeof seen !== "number" || !Number.isSafeInteger(seen) || seen < 1) {
      // A count that cannot be read is not room to read.
      reading = notRead(now, "answered", "count-unread");
    } else if (seen > STATUS_VIEWS_PER_HOUR) {
      usedUpHour = hourOf(now);
      return heldOrHour(now);
    } else {
      // One history for each check, each read in full, or none of them: a missing one is unknown, never empty.
      const histories = statusReplyValues(await redisPipeline(STATUS_CHECKS.map((c) => ["LRANGE", c.key, 0, STATUS_RUNS_KEPT - 1])), STATUS_READ_COMMANDS, STATUS_READ_COMMANDS)?.map(parseRuns);
      if (!histories || histories.some((runs) => runs === null)) throw new Error("status: the histories' reply is not the one asked for");
      reading = {
        builtAt: now,
        limit: "none",
        database: "answered",
        checks: STATUS_CHECKS.map((c, i) => ({ id: c.id, name: c.name, untested: c.untested, summary: summarizeRuns(histories[i]!, now) })),
      };
    }
  } catch {
    reading = notRead(now, "no-answer", "none");
  }
  remembered = reading;
  return reading;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
/** "November 5, 2026 at 3:00 PM UTC", put together from two parts so no runtime's joining word changes it. */
export const statusTime = (ms: number) => `${DATE.format(new Date(ms))} at ${CLOCK.format(new Date(ms))} UTC`;
export const statusDate = (ms: number) => DATE.format(new Date(ms));

export type StatusRow = { what: string; result: "Answered" | "Did not answer" | "Passed" | "Failed" | "Unknown"; when: string };

/** Why the runs were not read, in words, or null when they were. */
export function notReadReason(reading: StatusReading): string | null {
  const nextHour = statusTime((hourOf(reading.builtAt) + 1) * HOUR_MS);
  if (reading.database === "no-answer") return "Not read: the database did not answer, or its answer could not be read";
  if (reading.database === "unset") return "Not read: no database is set up where this page was put together";
  if (reading.limit === "hour") return `Not read: this page was opened more than ${STATUS_VIEWS_PER_HOUR} times this hour. It reads the results again from ${nextHour}`;
  if (reading.limit === "address") return `Not read: this page was opened many times from your network this hour. It reads the results again for you from ${nextHour}`;
  if (reading.limit === "count-unread") return "Not read: the count of visits this hour could not be read";
  return null;
}

/** The page's words for a reading: a result in words for each row, and when it was measured. */
export function describeStatus(reading: StatusReading): { builtAt: string; rows: StatusRow[] } {
  const builtAt = statusTime(reading.builtAt);
  const database: StatusRow = reading.database === "answered"
    ? { what: "Database", result: "Answered", when: builtAt }
    : reading.database === "no-answer"
      ? { what: "Database", result: "Did not answer", when: builtAt }
      : { what: "Database", result: "Unknown", when: "No database is set up where this page was put together" };
  const reason = notReadReason(reading);
  const rows = reading.checks.map(({ name, untested, summary }): StatusRow => {
    if (reason) return { what: name, result: "Unknown", when: reason };
    if (summary.state === "unknown") return { what: name, result: "Unknown", when: `No result in the last ${STATUS_STALE_HOURS} hours` };
    const at = statusTime(summary.last!.at);
    if (summary.state === "untested") return { what: name, result: "Unknown", when: `${at}: ${untested}` };
    return { what: name, result: summary.state === "passed" ? "Passed" : "Failed", when: at };
  });
  return { builtAt, rows: [database, ...rows] };
}
