/**
 * A recurring series of one call (637 [GL5], unit 5a; added 3 November
 * 2026): the rules, on synthetic setups and dates only.
 */
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { MAX_SERIES, SERIES_PROBLEMS, chargeable, conflictWords, readSeries, seriesConflicts, seriesStarts, toCancel } from "@/lib/call-series-rules";
import { done, is, part } from "./check";

const NY = "America/New_York";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const setup = readSetup({ kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 12, horizonDays: 7, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] }) as CallSetup;
// Monday 26 October 2026, 10:00 in New York (summer time, UTC-4); the clocks go back on Sunday 1 November.
const FIRST = Date.UTC(2026, 9, 26, 14, 0);
const NOW = Date.UTC(2026, 9, 20, 12, 0);

part("Asked for");
is("every week or every two weeks, from two to twelve sessions", [readSeries({ cadence: "weekly", count: 4 }, setup), readSeries({ cadence: "biweekly", count: "12" }, setup)], [{ ok: true, cadence: "weekly", count: 4 }, { ok: true, cadence: "biweekly", count: 12 }]);
is("refused: another cadence, one session, more than twelve, a decimal, a group, dated sessions", [readSeries({ cadence: "daily", count: 4 }, setup), readSeries({ cadence: "weekly", count: 1 }, setup), readSeries({ cadence: "weekly", count: MAX_SERIES + 1 }, setup), readSeries({ cadence: "weekly", count: 2.5 }, setup), readSeries({ cadence: "weekly", count: 4 }, { ...setup, seats: 3 }), readSeries({ cadence: "weekly", count: 4 }, { ...setup, kind: "live" })].map((r) => (r.ok ? "ok" : r.why)), ["cadence", "count", "count", "count", "kind", "kind"]);
is("each problem says how to fix it", SERIES_PROBLEMS.count, "Pick how many sessions the series has, from 2 to 12.");

part("The dates");
const weekly = seriesStarts(FIRST, NY, "weekly", 3);
is("the same clock time each week, across the change of the clocks", weekly, [FIRST, FIRST + 7 * DAY + HOUR, FIRST + 14 * DAY + HOUR]);
is("every two weeks", seriesStarts(FIRST, NY, "biweekly", 2), [FIRST, FIRST + 14 * DAY + HOUR]);
// Sunday 1 March 2026, 2:30 in New York; on Sunday 8 March 2:30 does not exist (the clocks go forward at 2:00).
const early = Date.UTC(2026, 2, 1, 7, 30);
is("a clock time skipped that day is said as missing, never moved", seriesStarts(early, NY, "weekly", 3).map((s) => (s === null ? null : "ok")), ["ok", null, "ok"]);

part("Every date free, or the series is refused");
is("free: the booking window is stretched for the series' own later dates", seriesConflicts(setup, NOW, [], seriesStarts(FIRST, NY, "weekly", 4), "p1"), []);
const busy = [{ start: FIRST + 7 * DAY + HOUR, end: FIRST + 7 * DAY + 2 * HOUR }];
is("a date somebody holds, or a synced calendar's busy time, is named", seriesConflicts(setup, NOW, busy, seriesStarts(FIRST, NY, "weekly", 4), "p1"), [1]);
is("the first date must be inside the booking window, which is never stretched for it", seriesConflicts(setup, NOW, [], seriesStarts(FIRST + 14 * DAY + HOUR, NY, "weekly", 2), "p1"), [0]);
is("a date outside the creator's hours is named", seriesConflicts(setup, NOW, [], [FIRST, FIRST + 5 * DAY], "p1"), [1]);
is("a missing clock time is a conflict too", seriesConflicts(setup, NOW, [], [FIRST, null], "p1"), [1]);
is("said with each date, in the creator's time zone", conflictWords(seriesStarts(FIRST, NY, "weekly", 4), [1, 3], NY), "These times are not free, so the series cannot be booked: Monday, November 2 at 10:00 AM and Monday, November 16 at 10:00 AM. Pick another first time, or fewer sessions.");

part("Ended early: the rest cancelled, never charged");
const starts = seriesStarts(FIRST, NY, "weekly", 4) as number[];
const cancelled = toCancel(starts, FIRST + 8 * DAY);
is("every session still to come is cancelled", cancelled, starts.slice(2));
is("and only what took place is charged", chargeable(starts, cancelled), starts.slice(0, 2));

done();
