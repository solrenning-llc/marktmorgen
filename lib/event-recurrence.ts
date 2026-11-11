/**
 * Repeating community events (109 [E2-EVENTS], unit 1): the rules, as plain
 * functions. No Redis, no secrets, nothing sent; the studio's page can import
 * them. Making the events is the next unit; until then nothing calls this.
 *
 * Why: a creator who runs a weekly or monthly call today makes the same
 * event again every time, by hand, and a member cannot see the next ones
 * ahead. The owner's P4 list (E2) asks for recurring events; no competitor
 * claim is made here.
 *
 * The rules:
 *
 *   - Every week, every two weeks, or every month, from MIN_EVENT_SERIES to
 *     MAX_EVENT_SERIES times: the same limits a call series already has
 *     (lib/call-series-rules.ts), so one number means one thing.
 *   - The same clock time in the creator's time zone each time, across the
 *     change of the clocks. Weekly and every two weeks are worked out by the
 *     call series' own seriesStarts, not a copy of it.
 *   - Every month is the same weekday in the same week of the month (the
 *     fourth Tuesday). A fifth weekday is read as the last one, because not
 *     every month has a fifth: no month is skipped without a word.
 *   - A clock time that does not exist on one of the days (the hour the
 *     clocks go forward) is said as missing, never moved; the whole series is
 *     then refused with that date named, so nobody finds an event at a time
 *     they never chose.
 *   - The whole series fits the limits every event already has, or none of
 *     it is made: no date further than MAX_EVENT_AHEAD_DAYS, none in the past,
 *     and no more than MAX_UPCOMING_EVENTS coming up at once. How many are
 *     coming up must be an exact whole number; anything else is unknown, and
 *     unknown is never room.
 *
 * Each date becomes an ordinary event of lib/community-events.ts, so its
 * places, reminders, replay and cancellation stay what they are today.
 */
import { MAX_SERIES, MIN_SERIES, seriesStarts } from "@/lib/call-series-rules";
import { partsIn, zonedToUtc } from "@/lib/call-setup";
import { MAX_EVENT_AHEAD_DAYS, MAX_UPCOMING_EVENTS } from "@/lib/community-text";

export const EVENT_REPEATS = ["weekly", "biweekly", "monthly"] as const;
export type EventRepeat = (typeof EVENT_REPEATS)[number];
export const MIN_EVENT_SERIES = MIN_SERIES;
export const MAX_EVENT_SERIES = MAX_SERIES;

const DAY = 86_400_000;

export type RepeatProblem = "repeat" | "count" | "missing_time" | "order" | "past" | "too_far" | "too_many" | "unknown";

export const REPEAT_PROBLEMS: Record<RepeatProblem, string> = {
  repeat: "Pick how often it repeats: every week, every other week or every month.",
  count: `Pick how many times it happens, from ${MIN_SERIES} to ${MAX_SERIES}.`,
  missing_time: "One of the dates has no such time, because the clocks change that day. Pick another time or another day.",
  order: "The dates must come one after another. Start the series again.",
  past: "One of the dates has already passed. Pick a later start.",
  too_far: `Every date must be within ${MAX_EVENT_AHEAD_DAYS} days. Pick fewer times or an earlier start.`,
  too_many: `A community can have ${MAX_UPCOMING_EVENTS} events coming up at once. Pick fewer times.`,
  unknown: "We could not check how many events are coming up. Nothing was made. Try again in a minute.",
};

export type RepeatAsk = { ok: true; repeat: EventRepeat; count: number } | { ok: false; why: "repeat" | "count" };

/** What the form sent: null when no repeat was asked (one event, as today). */
export function readRepeat(raw: unknown): RepeatAsk | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.repeat === undefined || value.repeat === null || value.repeat === "") return null;
  if (!EVENT_REPEATS.includes(value.repeat as EventRepeat)) return { ok: false, why: "repeat" };
  const count = typeof value.count === "string" && /^\d{1,3}$/.test(value.count) ? Number(value.count) : value.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < MIN_SERIES || count > MAX_SERIES) return { ok: false, why: "count" };
  return { ok: true, repeat: value.repeat as EventRepeat, count };
}

/** Which weekday of the month the first date is: 1 to 4, or "last" for a fifth. Weekday 0 is Sunday. */
export function monthlyPlace(first: number, tz: string): { nth: 1 | 2 | 3 | 4 | "last"; weekday: number } {
  const p = partsIn(first, tz);
  const nth = Math.ceil(p.day / 7);
  return { nth: nth >= 5 ? "last" : (nth as 1 | 2 | 3 | 4), weekday: p.weekday };
}

/** The day of the month of that weekday, in one month (month 1 is January). */
function dayOfMonth(year: number, month: number, place: ReturnType<typeof monthlyPlace>): number {
  if (place.nth === "last") {
    const last = new Date(Date.UTC(year, month, 0));
    return last.getUTCDate() - ((last.getUTCDay() - place.weekday + 7) % 7);
  }
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((place.weekday - firstWeekday + 7) % 7) + 7 * (place.nth - 1);
}

/**
 * The start of each time, in order; null where the clock time does not exist
 * that day. The first is the event as the creator put it in.
 */
export function eventSeriesStarts(first: number, tz: string, repeat: EventRepeat, count: number): (number | null)[] {
  if (repeat !== "monthly") return seriesStarts(first, tz, repeat, count);
  const p = partsIn(first, tz);
  const minute = p.hour * 60 + p.minute;
  const place = monthlyPlace(first, tz);
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return first;
    const month0 = p.month - 1 + i;
    const year = p.year + Math.floor(month0 / 12);
    const month = (month0 % 12) + 1;
    const at = zonedToUtc(year, month, dayOfMonth(year, month, place), minute, tz);
    if (at === null) return null;
    const back = partsIn(at, tz);
    return back.hour * 60 + back.minute === minute ? at : null;
  });
}

export type SeriesCheck =
  | { ok: true; starts: number[] }
  | { ok: false; why: "count" | "unknown" }
  | { ok: false; why: "missing_time" | "order" | "past" | "too_far"; at: number }
  | { ok: false; why: "too_many"; room: number };

/**
 * Whether the whole series may be made now. `upcoming` is how many of the
 * community's events are coming up, read exactly; anything but a whole
 * number of zero or more is unknown, and nothing is made. `at` is the
 * position of the date at fault (0 is the first).
 */
export function checkEventSeries(starts: readonly (number | null)[], read: { now: number; upcoming: number }): SeriesCheck {
  if (starts.length < MIN_SERIES || starts.length > MAX_SERIES) return { ok: false, why: "count" };
  const { now, upcoming } = read;
  if (typeof upcoming !== "number" || !Number.isInteger(upcoming) || upcoming < 0) return { ok: false, why: "unknown" };
  const missing = starts.findIndex((s) => s === null || !Number.isFinite(s));
  if (missing >= 0) return { ok: false, why: "missing_time", at: missing };
  const dates = starts as number[];
  for (let i = 1; i < dates.length; i += 1) if (dates[i] <= dates[i - 1]) return { ok: false, why: "order", at: i };
  const past = dates.findIndex((s) => s <= now);
  if (past >= 0) return { ok: false, why: "past", at: past };
  const far = dates.findIndex((s) => s > now + MAX_EVENT_AHEAD_DAYS * DAY);
  if (far >= 0) return { ok: false, why: "too_far", at: far };
  const room = Math.max(0, MAX_UPCOMING_EVENTS - upcoming);
  if (dates.length > room) return { ok: false, why: "too_many", room };
  return { ok: true, starts: dates };
}

const ORDINAL = { 1: "first", 2: "second", 3: "third", 4: "fourth", last: "last" } as const;

/** The series in plain words, as the studio and the event page say it. */
export function repeatWords(first: number, tz: string, repeat: EventRepeat, count: number): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(first);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(first);
  const times = `${count} ${count === 1 ? "time" : "times"}`;
  if (repeat === "weekly") return `Every week on ${weekday} at ${time}, ${times}`;
  if (repeat === "biweekly") return `Every other week on ${weekday} at ${time}, ${times}`;
  return `Every month on the ${ORDINAL[monthlyPlace(first, tz).nth]} ${weekday} at ${time}, ${times}`;
}
