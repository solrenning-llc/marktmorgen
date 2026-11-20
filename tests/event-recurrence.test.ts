/**
 * Repeating community events (109 [E2-EVENTS], unit 1; added 10 November
 * 2026): the rules, on synthetic dates only. Nothing here reads or writes.
 */
import { MAX_EVENT_AHEAD_DAYS, MAX_UPCOMING_EVENTS } from "@/lib/community-text";
import {
  EVENT_REPEATS,
  MAX_EVENT_SERIES,
  MIN_EVENT_SERIES,
  REPEAT_PROBLEMS,
  checkEventSeries,
  eventSeriesStarts,
  monthlyPlace,
  readRepeat,
  repeatWords,
} from "@/lib/event-recurrence";
import { done, is, part } from "./check";

const NY = "America/New_York";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const clock = (ms: number | null, tz: string) =>
  ms === null ? null : new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);

part("Asked for");
is("no repeat asked: one event, as today", [readRepeat(undefined), readRepeat(null), readRepeat({}), readRepeat({ repeat: "" })], [null, null, null, null]);
is(
  "every week, every two weeks or every month, from two to twelve times",
  [readRepeat({ repeat: "weekly", count: 2 }), readRepeat({ repeat: "biweekly", count: "6" }), readRepeat({ repeat: "monthly", count: MAX_EVENT_SERIES })],
  [{ ok: true, repeat: "weekly", count: 2 }, { ok: true, repeat: "biweekly", count: 6 }, { ok: true, repeat: "monthly", count: 12 }],
);
is(
  "refused, never guessed: another cadence, one time, thirteen, a decimal, a word, a negative number",
  [
    readRepeat({ repeat: "daily", count: 4 }),
    readRepeat({ repeat: "weekly", count: 1 }),
    readRepeat({ repeat: "weekly", count: MAX_EVENT_SERIES + 1 }),
    readRepeat({ repeat: "monthly", count: 2.5 }),
    readRepeat({ repeat: "monthly", count: "many" }),
    readRepeat({ repeat: "weekly", count: -3 }),
    readRepeat({ repeat: "weekly" }),
  ].map((r) => (r && !r.ok ? r.why : r)),
  ["repeat", "count", "count", "count", "count", "count", "count"],
);
is("the limits are the ones a call series already has", [MIN_EVENT_SERIES, MAX_EVENT_SERIES, EVENT_REPEATS], [2, 12, ["weekly", "biweekly", "monthly"]]);
is("each problem says how to fix it", REPEAT_PROBLEMS.count, "Pick how many times it happens, from 2 to 12.");

part("Every week and every two weeks: the same clock time, across the change of the clocks");
// Tuesday 27 October 2026, 6:00 PM in New York (summer time, UTC-4); the clocks go back on Sunday 1 November.
const FIRST = Date.UTC(2026, 9, 27, 22, 0);
is("weekly", eventSeriesStarts(FIRST, NY, "weekly", 3), [FIRST, FIRST + 7 * DAY + HOUR, FIRST + 14 * DAY + HOUR]);
is("every two weeks", eventSeriesStarts(FIRST, NY, "biweekly", 2), [FIRST, FIRST + 14 * DAY + HOUR]);
is("read back on the clock", eventSeriesStarts(FIRST, NY, "weekly", 2).map((s) => clock(s, NY)), ["Tue, Oct 27, 2026, 6:00 PM", "Tue, Nov 3, 2026, 6:00 PM"]);

part("Every month: the same weekday in the same week of the month");
is("Tuesday 27 October is the fourth Tuesday", monthlyPlace(FIRST, NY), { nth: 4, weekday: 2 });
is(
  "the fourth Tuesday of each month, at 6:00 PM",
  eventSeriesStarts(FIRST, NY, "monthly", 4).map((s) => clock(s, NY)),
  ["Tue, Oct 27, 2026, 6:00 PM", "Tue, Nov 24, 2026, 6:00 PM", "Tue, Dec 22, 2026, 6:00 PM", "Tue, Jan 26, 2027, 6:00 PM"],
);
// Thursday 29 October 2026 is the fifth Thursday: not every month has one, so it is the last Thursday.
const FIFTH = Date.UTC(2026, 9, 29, 16, 0);
is("a fifth weekday is read as the last one, so no month is skipped", monthlyPlace(FIFTH, NY), { nth: "last", weekday: 4 });
is(
  "the last Thursday of each month",
  eventSeriesStarts(FIFTH, NY, "monthly", 3).map((s) => clock(s, NY)),
  ["Thu, Oct 29, 2026, 12:00 PM", "Thu, Nov 26, 2026, 12:00 PM", "Thu, Dec 31, 2026, 12:00 PM"],
);
// Sunday 1 February 2026, 10:00 AM in Kathmandu (UTC+5:45): the first Sunday, across the end of a year too.
const KTM = "Asia/Kathmandu";
is(
  "a time zone a quarter of an hour off, the first weekday",
  eventSeriesStarts(Date.UTC(2026, 10, 1, 4, 15), KTM, "monthly", 3).map((s) => clock(s, KTM)),
  ["Sun, Nov 1, 2026, 10:00 AM", "Sun, Dec 6, 2026, 10:00 AM", "Sun, Jan 3, 2027, 10:00 AM"],
);

part("A clock time that does not exist that day is said as missing, never moved");
// Sunday 1 March 2026, 2:30 AM in New York; on Sunday 8 March 2:30 AM does not exist (the clocks go forward at 2:00).
const EARLY = Date.UTC(2026, 2, 1, 7, 30);
is("weekly", eventSeriesStarts(EARLY, NY, "weekly", 3).map((s) => (s === null ? null : "ok")), ["ok", null, "ok"]);
// Sunday 8 February 2026 is the second Sunday; the second Sunday of March is 8 March.
is("monthly", eventSeriesStarts(Date.UTC(2026, 1, 8, 7, 30), NY, "monthly", 2).map((s) => (s === null ? null : "ok")), ["ok", null]);
// Sunday 25 October 2026, 1:30 AM; on Sunday 1 November 1:30 AM happens twice: it is still 1:30 AM.
is("a clock time that happens twice is still that clock time", eventSeriesStarts(Date.UTC(2026, 9, 25, 5, 30), NY, "weekly", 2).map((s) => clock(s, NY)), ["Sun, Oct 25, 2026, 1:30 AM", "Sun, Nov 1, 2026, 1:30 AM"]);

part("The whole series fits, or none of it is made");
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const starts = eventSeriesStarts(FIRST, NY, "weekly", 4);
is("fits: every date, in order", checkEventSeries(starts, { now: NOW, upcoming: 10 }), { ok: true, starts });
is("a missing clock time names the date it falls on", checkEventSeries(eventSeriesStarts(EARLY, NY, "weekly", 3), { now: EARLY - DAY, upcoming: 0 }), { ok: false, why: "missing_time", at: 1 });
is(
  "the last date further ahead than any event may be",
  checkEventSeries([NOW + DAY, NOW + (MAX_EVENT_AHEAD_DAYS + 1) * DAY], { now: NOW, upcoming: 0 }),
  { ok: false, why: "too_far", at: 1 },
);
is("a date already past", checkEventSeries([NOW - HOUR, NOW + DAY], { now: NOW, upcoming: 0 }), { ok: false, why: "past", at: 0 });
is(
  "more than the events that may be coming up at once",
  [checkEventSeries(starts, { now: NOW, upcoming: MAX_UPCOMING_EVENTS - 4 }).ok, checkEventSeries(starts, { now: NOW, upcoming: MAX_UPCOMING_EVENTS - 3 })],
  [true, { ok: false, why: "too_many", room: 3 }],
);
is(
  "how many are coming up could not be read: unknown, never room",
  [Number.NaN, -1, 1.5, undefined, null, "3"].map((upcoming) => checkEventSeries(starts, { now: NOW, upcoming: upcoming as number })),
  Array(6).fill({ ok: false, why: "unknown" }),
);
is("a series out of order or with a repeated date is refused", [checkEventSeries([FIRST + DAY, FIRST], { now: NOW, upcoming: 0 }), checkEventSeries([FIRST, FIRST], { now: NOW, upcoming: 0 })], [{ ok: false, why: "order", at: 1 }, { ok: false, why: "order", at: 1 }]);
is("fewer than two or more than twelve dates is not a series", [checkEventSeries([FIRST], { now: NOW, upcoming: 0 }), checkEventSeries(Array.from({ length: 13 }, (_, i) => FIRST + i * 7 * DAY), { now: NOW, upcoming: 0 })], [{ ok: false, why: "count" }, { ok: false, why: "count" }]);

part("Said in plain words");
is("weekly", repeatWords(FIRST, NY, "weekly", 6), "Every week on Tuesday at 6:00 PM ET, 6 times");
is("every two weeks", repeatWords(FIRST, NY, "biweekly", 3), "Every other week on Tuesday at 6:00 PM ET, 3 times");
is("monthly, the fourth", repeatWords(FIRST, NY, "monthly", 4), "Every month on the fourth Tuesday at 6:00 PM ET, 4 times");
is("monthly, the last", repeatWords(FIFTH, NY, "monthly", 2), "Every month on the last Thursday at 12:00 PM ET, 2 times");
is("the problems a creator can meet all have words", Object.keys(REPEAT_PROBLEMS).sort(), ["count", "missing_time", "order", "past", "repeat", "too_far", "too_many", "unknown"]);
is("no problem is left without a sentence", Object.values(REPEAT_PROBLEMS).every((w) => w.length > 10 && w.endsWith(".")), true);

part("Inputs that cannot be read are refused, never a throw (Claude 3 and Codex G on #3657, LEVE)");
is("a first time that is not one: no dates", eventSeriesStarts(Number.NaN, NY, "weekly", 3), []);
is("a zone that is not one: no dates", eventSeriesStarts(FIRST, "Mars/Base", "monthly", 3), []);
is("a count outside 2 to 12 is never expanded", [eventSeriesStarts(FIRST, NY, "monthly", 1_000_000), eventSeriesStarts(FIRST, NY, "weekly", 1.5)], [[], []]);
is("and an empty list is not a series", checkEventSeries([], { now: NOW, upcoming: 0 }), { ok: false, why: "count" });
is("a clock that is not a number: unknown, nothing made", checkEventSeries(starts, { now: Number.NaN, upcoming: 0 }), { ok: false, why: "unknown" });
is("words for inputs that cannot be read: null", [repeatWords(Number.NaN, NY, "weekly", 3), repeatWords(FIRST, "Mars/Base", "weekly", 3)], [null, null]);

done();
