/**
 * The booking calendar's open times (lib/call-setup.ts, openSlots) read each
 * slot's clock in the creator's time zone. Building a new Intl.DateTimeFormat
 * for every read made a long window slow (about 2 seconds for a 12-session
 * series over a busy calendar, past 3 under load, which failed
 * tests/call-series-rules.test.ts at random). The zone's formatter is built
 * once and reused: the answers are the same, read the same way.
 * Counted, not timed, so the check never depends on how busy the machine is.
 */
import { openSlots, partsIn, readSetup, zonedToUtc, type CallSetup } from "@/lib/call-setup";
import { done, is, part } from "./check";

const NY = "America/New_York";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const read = readSetup({ kind: "weekly", minutes: 60, tz: NY, weekly: Array.from({ length: 7 }, () => [[480, 1320]]), noticeHours: 12, horizonDays: 7, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] }) as CallSetup;
// Quarter-hour calls, every day from 8:00 to 22:00, as tests/call-series-rules.test.ts reads a busy calendar.
const setup: CallSetup = { ...read, minutes: 15 };

let built = 0;
const Real = Intl.DateTimeFormat;
function Counted(this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
  built += 1;
  return new Real(...args);
}
Counted.prototype = Real.prototype;
(Counted as unknown as { supportedLocalesOf: typeof Real.supportedLocalesOf }).supportedLocalesOf = Real.supportedLocalesOf;

part("A long window reads its zone with one formatter");
Intl.DateTimeFormat = Counted as unknown as typeof Intl.DateTimeFormat;
let days: ReturnType<typeof openSlots>;
try {
  // A series stretches the window this far (lib/call-series-rules.ts, seriesConflicts).
  days = openSlots({ ...setup, horizonDays: 200 }, NOW, [], "p1");
} finally {
  Intl.DateTimeFormat = Real;
}
const slots = days.reduce((n, d) => n + d.starts.length, 0);
is("the window has thousands of slots", slots > 10_000, true);
is("a few formatters for the whole window, never one per slot", built <= 4, true);

part("The same answers");
is("a date and time read in the zone", partsIn(Date.UTC(2026, 10, 1, 5, 30), NY), { year: 2026, month: 11, day: 1, hour: 1, minute: 30, weekday: 0 });
is("the hour skipped when the clocks go forward does not exist", zonedToUtc(2026, 3, 8, 150, NY), null);
is("10:00 in New York in summer is 14:00 UTC", zonedToUtc(2026, 10, 26, 600, NY), Date.UTC(2026, 9, 26, 14, 0));
is("and in winter 15:00 UTC", zonedToUtc(2026, 11, 2, 600, NY), Date.UTC(2026, 10, 2, 15, 0));
is("each day's first slot is 8:00 there", days.slice(1, 4).map((d) => partsIn(d.starts[0], NY).hour), [8, 8, 8]);
is("over 200 days", days.length >= 199 && days[days.length - 1].starts[0] - days[0].starts[0] > 198 * DAY, true);
done();
