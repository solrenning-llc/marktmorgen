/**
 * Days without automated marketing emails (383 [TB9], unit 1; 7 November
 * 2026).
 *
 * A creator picks days of the week and dates on which automated marketing
 * emails do not go out. An email due on such a day waits for the next day
 * the creator allows, at the same clock time, in the time zone the creator
 * picked. These are the rules only: nothing here reads, writes or sends,
 * so the rule adds no cost. Unit 2 keeps the setting with the automations
 * (lib/flows.ts) and asks `whenToSend` before each step, in the same queue,
 * with no second cron; the step's allowance, opt-out and sender checks still
 * run when it finally goes out.
 *
 * What the rule holds to:
 * - Emails about an order (receipts, access links, anything the law or the
 *   sale requires) are never held: only `purpose: "marketing"` waits.
 * - Never every day: at least one day of the week stays open, and no
 *   stretch of held days is longer than MAX_WAIT_DAYS, so emails never pile
 *   up for weeks and nothing is dropped.
 * - The store's day decides, not the server's: a date is read in the
 *   creator's time zone, across changes of the clocks. A clock time skipped
 *   when the clocks go forward moves an hour later.
 * - A setting that could not be read, or a kept one that breaks these
 *   rules, gives "unknown": the caller sends nothing now and tries again,
 *   never guesses.
 */
import { isTimeZone, partsIn, zonedToUtc } from "@/lib/call-setup";

/** How many dates a creator may pick at once. */
export const MAX_NO_SEND_DATES = 60;
/** The longest stretch of held days in a row, so emails never pile up. */
export const MAX_WAIT_DAYS = 14;
/** How far ahead a date may be picked, in days from today. */
export const NO_SEND_DAYS_AHEAD = 365;

/** Days of the week as Date#getUTCDay numbers them: 0 is Sunday. */
const WEEKDAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
/** The order the studio reads them in: the week from Monday. */
const WEEK_FROM_MONDAY = [1, 2, 3, 4, 5, 6, 0];
const DAY_MS = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** What a creator set. `weekdays` and `dates` are sorted, each once. */
export type NoSendDays = { timeZone: string; weekdays: number[]; dates: string[] };
export type NoSendProblem = "shape" | "time_zone" | "weekdays" | "dates" | "too_many_dates" | "too_long";
export type NoSendRead = { ok: true; rule: NoSendDays } | { ok: false; why: Exclude<NoSendProblem, "too_long"> } | { ok: false; why: "too_long"; from: string };
export type SendDecision = { send: "now" } | { send: "later"; at: number; day: string } | { send: "unknown" };

/** A YYYY-MM-DD key as a calendar day number (days since 1970-01-01), or null when it is not a real date. */
function dayNumber(key: string): number | null {
  const m = DATE_KEY.exec(key);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return at / DAY_MS;
}

/** The YYYY-MM-DD key of a calendar day number. */
function keyOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The weekday (0 is Sunday) of a calendar day number. */
function weekdayOf(day: number): number {
  return new Date(day * DAY_MS).getUTCDay();
}

/** The calendar day a clock in `tz` shows at instant `ms`. */
function localDay(ms: number, tz: string): number {
  const p = partsIn(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day) / DAY_MS;
}

/** The first day of the longest stretch over MAX_WAIT_DAYS held days in a row from `from`, or null when there is none. */
function tooLongFrom(weekdays: readonly number[], dates: ReadonlySet<number>, from: number, last: number): number | null {
  let start = -1;
  let length = 0;
  // A week past the last date, so a stretch that runs on through weekdays is seen whole.
  for (let day = from; day <= last + 7; day += 1) {
    if (weekdays.includes(weekdayOf(day)) || dates.has(day)) {
      if (length === 0) start = day;
      length += 1;
      if (length > MAX_WAIT_DAYS) return start;
    } else {
      length = 0;
    }
  }
  return null;
}

/**
 * What the studio sends, as kept, or why not. Dates already gone in the
 * store's time zone are dropped; the rest are checked against today there.
 */
export function readNoSendDays(raw: unknown, now: number): NoSendRead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "shape" };
  const input = raw as { timeZone?: unknown; weekdays?: unknown; dates?: unknown };
  if (!isTimeZone(input.timeZone)) return { ok: false, why: "time_zone" };
  const timeZone = input.timeZone;

  const rawWeekdays = input.weekdays ?? [];
  if (!Array.isArray(rawWeekdays) || !rawWeekdays.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) return { ok: false, why: "weekdays" };
  const weekdays = [...new Set(rawWeekdays as number[])].sort((a, b) => a - b);
  if (weekdays.length >= 7) return { ok: false, why: "weekdays" };

  const rawDates = input.dates ?? [];
  if (!Array.isArray(rawDates) || !rawDates.every((d) => typeof d === "string")) return { ok: false, why: "dates" };
  const today = localDay(now, timeZone);
  const days = new Set<number>();
  for (const key of rawDates as string[]) {
    const day = dayNumber(key);
    if (day === null || day > today + NO_SEND_DAYS_AHEAD) return { ok: false, why: "dates" };
    if (day >= today) days.add(day);
  }
  if (days.size > MAX_NO_SEND_DATES) return { ok: false, why: "too_many_dates" };

  const last = days.size ? Math.max(...days) : today;
  const from = tooLongFrom(weekdays, days, today, last);
  if (from !== null) return { ok: false, why: "too_long", from: keyOf(from) };
  return { ok: true, rule: { timeZone, weekdays, dates: [...days].sort((a, b) => a - b).map(keyOf) } };
}

/** Whether a kept setting still holds to the rules, without dropping anything. */
function wellFormed(rule: NoSendDays): boolean {
  if (!rule || typeof rule !== "object" || !isTimeZone(rule.timeZone)) return false;
  if (!Array.isArray(rule.weekdays) || !Array.isArray(rule.dates) || rule.dates.length > MAX_NO_SEND_DATES) return false;
  if (!rule.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(rule.weekdays).size >= 7) return false;
  return rule.dates.every((key) => typeof key === "string" && dayNumber(key) !== null);
}

/**
 * When an automated email due at `due` goes out.
 *
 * "now" when it is about an order, when nothing is set, or when its day is
 * open in the store's time zone; "later" with the instant on the next open
 * day, at the same clock time (an hour later when the clocks skip that
 * time); "unknown" when the setting could not be read or a kept one breaks
 * the rules, so the caller sends nothing now, drops nothing and tries again.
 */
export function whenToSend(rule: NoSendDays | "none" | "unknown", purpose: "marketing" | "service", due: number): SendDecision {
  if (purpose === "service" || rule === "none") return { send: "now" };
  if (rule === "unknown" || !wellFormed(rule)) return { send: "unknown" };
  const tz = rule.timeZone;
  const held = new Set(rule.dates.map((key) => dayNumber(key) as number));
  const isHeld = (day: number) => rule.weekdays.includes(weekdayOf(day)) || held.has(day);
  const today = localDay(due, tz);
  if (!isHeld(today)) return { send: "now" };
  const p = partsIn(due, tz);
  const minute = p.hour * 60 + p.minute;
  // Seconds are kept, so the wait is whole days of the store's clock.
  const seconds = due % 60_000;
  for (let wait = 1; wait <= MAX_WAIT_DAYS; wait += 1) {
    const day = today + wait;
    if (isHeld(day)) continue;
    const d = new Date(day * DAY_MS);
    const at = (m: number) => zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), m, tz);
    const start = at(minute) ?? at(minute + 60);
    if (start === null) return { send: "unknown" };
    return { send: "later", at: start + seconds, day: keyOf(day) };
  }
  return { send: "unknown" };
}

/** A list in plain English: "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A YYYY-MM-DD key as the studio writes it: "December 19, 2026". */
function dayWords(key: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(Date.parse(`${key}T00:00:00Z`));
}

/** What the studio says about each problem, with how to fix it. */
export const NO_SEND_PROBLEMS = {
  shape: "These settings could not be read. Reload the page and try again.",
  time_zone: "Pick your time zone from the list.",
  weekdays: "Leave at least one day of the week open, so emails can go out.",
  dates: `Type each date as year-month-day, like 2026-12-25, within the next year.`,
  too_many_dates: `Pick at most ${MAX_NO_SEND_DATES} dates.`,
  too_long: (from: string) => `From ${dayWords(from)}, that holds emails for more than ${MAX_WAIT_DAYS} days in a row. Open at least one day in that stretch, so emails do not pile up.`,
};

/** What the studio says a setting does, in plain English. */
export function noSendDaysWords(rule: NoSendDays): string {
  const days = WEEK_FROM_MONDAY.filter((d) => rule.weekdays.includes(d)).map((d) => WEEKDAY_NAMES[d]);
  const dates = rule.dates.length ? [`${rule.dates.length} ${rule.dates.length === 1 ? "date" : "dates"} you picked`] : [];
  if (!days.length && !dates.length) return "Automated marketing emails go out on any day.";
  const on = [days.length ? listed(days) : "", ...dates].filter(Boolean).join(" and on ");
  return `Automated marketing emails wait on ${on}. They go out on the next day you allow, at the same time of day, in your time zone (${rule.timeZone}). Emails about an order, like receipts and access links, are never held.`;
}
