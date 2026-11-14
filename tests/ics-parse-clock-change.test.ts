/**
 * Reading a creator's busy feed on the days the clocks change (lib/ics-parse.ts
 * localToUtc). A time in the hour skipped when clocks go forward lands just
 * after the jump; a time shown twice when they go back is its first
 * occurrence (RFC 5545 3.3.5). The two-step guess used before gave different
 * answers by the sign of the zone's offset: New York's skipped 02:30 read as
 * 01:30 EST, an hour early, and Berlin's repeated 02:30 as the second one.
 * Synthetic files only.
 */
import { parseIcs } from "@/lib/ics-parse";
import { done, is, part } from "./check";

const iso = (ms: number) => new Date(ms).toISOString();
const cal = (body: string, zone = "") =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...(zone ? [`X-WR-TIMEZONE:${zone}`] : []), body, "END:VCALENDAR"].join("\r\n");
const ev = (start: string, end: string, extra = "") =>
  ["BEGIN:VEVENT", "UID:x1@example.com", start, end, ...(extra ? [extra] : []), "END:VEVENT"].join("\r\n");
const window = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 1, 1), fallbackTz: "UTC" };
const first = (start: string, end: string) => {
  const r = parseIcs(cal(ev(start, end)), window);
  return r.busy[0] ? iso(r.busy[0].start) : "none";
};

part("clocks going forward: a skipped time lands just after the jump");
is("Berlin gap 02:30 on 29 March -> 01:30Z (03:30 CEST)", first("DTSTART;TZID=Europe/Berlin:20260329T023000", "DURATION:PT1H"), "2026-03-29T01:30:00.000Z");
is("New York gap 02:30 on 8 March -> 07:30Z (03:30 EDT), not 06:30Z (01:30 EST)", first("DTSTART;TZID=America/New_York:20260308T023000", "DURATION:PT1H"), "2026-03-08T07:30:00.000Z");
is("Lord Howe gap 02:15 on 4 October -> 15:45Z (02:45 +11)", first("DTSTART;TZID=Australia/Lord_Howe:20261004T021500", "DURATION:PT1H"), "2026-10-03T15:45:00.000Z");

part("clocks going back: a repeated time is its first occurrence");
is("New York 01:30 on 1 November -> 05:30Z (EDT, first)", first("DTSTART;TZID=America/New_York:20261101T013000", "DURATION:PT30M"), "2026-11-01T05:30:00.000Z");
is("Berlin 02:30 on 25 October -> 00:30Z (CEST, first)", first("DTSTART;TZID=Europe/Berlin:20261025T023000", "DURATION:PT30M"), "2026-10-25T00:30:00.000Z");

part("ordinary times on and around a change day");
is("New York 10:00 on 1 November (after the change) -> 15:00Z", first("DTSTART;TZID=America/New_York:20261101T100000", "DURATION:PT1H"), "2026-11-01T15:00:00.000Z");
is("New York 00:30 on 1 November (before the change) -> 04:30Z", first("DTSTART;TZID=America/New_York:20261101T003000", "DURATION:PT1H"), "2026-11-01T04:30:00.000Z");
is("Berlin 01:59 on 29 March (before the jump) -> 00:59Z", first("DTSTART;TZID=Europe/Berlin:20260329T015900", "DURATION:PT1H"), "2026-03-29T00:59:00.000Z");
is("Berlin 03:00 on 29 March (after the jump) -> 01:00Z", first("DTSTART;TZID=Europe/Berlin:20260329T030000", "DURATION:PT1H"), "2026-03-29T01:00:00.000Z");
is("Kolkata across the year end", first("DTSTART;TZID=Asia/Kolkata:20261231T233000", "DTEND;TZID=Asia/Kolkata:20270101T003000"), "2026-12-31T18:00:00.000Z");
{
  const f = parseIcs(cal(ev("DTSTART:20261015T090000", "DTEND:20261015T100000")), { ...window, fallbackTz: "America/Fortaleza" });
  is("floating time in the fallback zone Fortaleza (-03)", f.busy[0] && iso(f.busy[0].start), "2026-10-15T12:00:00.000Z");
  const d = parseIcs(cal(ev("DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261102"), "America/New_York"), window);
  is("all-day on the fall-back day is 25 hours", d.busy[0] && `${iso(d.busy[0].start)} ${iso(d.busy[0].end)}`, "2026-11-01T04:00:00.000Z 2026-11-02T05:00:00.000Z");
  const w = parseIcs(cal(ev("DTSTART;TZID=America/New_York:20261026T090000", "DTEND;TZID=America/New_York:20261026T100000", "RRULE:FREQ=WEEKLY;COUNT=2")), window);
  is("a weekly 9 a.m. keeps 9 a.m. over the change", w.busy.map((x) => iso(x.start)).join(" "), "2026-10-26T13:00:00.000Z 2026-11-02T14:00:00.000Z");
}

done();
