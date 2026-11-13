/**
 * Reading a booking window builds each time zone's formatter once, not once per slot: building an
 * Intl.DateTimeFormat costs far more than using it, and openSlots over months of 15-minute slots made tens of
 * thousands of them, about three seconds on CI's runners (tests/call-series-rules.test.ts, "answers at once").
 * Counted, not timed, so the check does not depend on the machine.
 */
import { readSetup, openSlots, partsIn, type CallSetup } from "@/lib/call-setup";
import { done, is, part } from "./check";

const NY = "America/New_York";
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const setup = readSetup({ kind: "weekly", minutes: 15, tz: NY, weekly: Array.from({ length: 7 }, () => [[480, 1320]]), noticeHours: 12, horizonDays: 7, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] }) as CallSetup;
// Stretched as a series stretches it (lib/call-series-rules.ts seriesConflicts): months of 15-minute slots.
const wide: CallSetup = { ...setup, horizonDays: 200 };

const Real = Intl.DateTimeFormat;
let made = 0;
const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
  made += 1;
  return new Real(...args);
} as unknown as typeof Intl.DateTimeFormat;
Counting.supportedLocalesOf = Real.supportedLocalesOf;
Intl.DateTimeFormat = Counting;

part("Months of slots");
const days = openSlots(wide, NOW, [], "p1");
const slots = days.reduce((n, d) => n + d.starts.length, 0);
is("(control) the window holds thousands of slots", slots > 5_000, true);
is("each time zone's formatter is built a handful of times, never once per slot", made <= 4, true);

part("The same answers");
is("New York's clock read the same way", partsIn(Date.UTC(2026, 10, 1, 5, 30), NY), { year: 2026, month: 11, day: 1, hour: 1, minute: 30, weekday: 0 });
is("another zone is not given New York's formatter", partsIn(Date.UTC(2026, 10, 1, 5, 30), "Asia/Kathmandu").hour, 11);
let refused = false;
try {
  partsIn(0, "Not/AZone");
} catch {
  refused = true;
}
is("a zone the runtime refuses still throws", refused, true);

Intl.DateTimeFormat = Real;
done();
