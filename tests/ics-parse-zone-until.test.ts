/**
 * A time zone the calendar file defines itself (lib/ics-parse.ts offsetAt):
 * a yearly rule that has ended (UNTIL) no longer moves the clock. Outlook
 * writes "Customized Time Zone" with the US rules from before 2007 next to
 * today's; reading the ended October rule in 2026 put every time from 25
 * October to 1 November an hour off, so a creator's busy block moved.
 * Synthetic files only.
 */
import { parseIcs } from "@/lib/ics-parse";
import { done, is, part } from "./check";

const iso = (ms: number) => new Date(ms).toISOString();
const cal = (body: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", body, "END:VCALENDAR"].join("\r\n");
const ev = (start: string, end: string) => ["BEGIN:VEVENT", "UID:x1@example.com", start, end, "END:VEVENT"].join("\r\n");
const window = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 1, 1), fallbackTz: "UTC" };

part("ics-parse: a zone the file defines, with an ended historical rule (UNTIL)");
{
  // An Outlook-style custom zone carrying the US rules before and after 2007.
  // The pre-2007 rules end with UNTIL; in 2026 only the 2007+ ones apply.
  const vtz = [
    "BEGIN:VTIMEZONE",
    "TZID:Customized Time Zone",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "DTSTART:19870405T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=20060402T070000Z",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "DTSTART:19671029T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20061029T060000Z",
    "END:STANDARD",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "DTSTART:20070311T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "DTSTART:20071104T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ].join("\r\n");
  // 2026-10-28 is after the last Sunday of October (old rule, ended 2006) and
  // before the first Sunday of November: still EDT (-04), 10:00 = 14:00Z.
  const c = parseIcs(cal(`${vtz}\r\n${ev('DTSTART;TZID="Customized Time Zone":20261028T100000', 'DTEND;TZID="Customized Time Zone":20261028T110000')}`), window);
  is("custom zone ignores a rule past its UNTIL (2026-10-28 10:00 EDT = 14:00Z)", c.busy[0] && iso(c.busy[0].start), "2026-10-28T14:00:00.000Z");
  const at = (stamp: string) => {
    const r = parseIcs(cal(`${vtz}\r\n${ev(`DTSTART;TZID="Customized Time Zone":${stamp}`, "DURATION:PT1H")}`), window);
    return r.busy[0] ? iso(r.busy[0].start) : "none";
  };
  is("custom zone: 2026-10-24 10:00 (EDT) = 14:00Z", at("20261024T100000"), "2026-10-24T14:00:00.000Z");
  is("custom zone: 2026-11-02 10:00 (EST) = 15:00Z", at("20261102T100000"), "2026-11-02T15:00:00.000Z");
  is("custom zone: 2026-03-10 10:00 (EDT, after the 2007+ March rule) = 14:00Z", at("20260310T100000"), "2026-03-10T14:00:00.000Z");
  is("custom zone: 2026-04-01 10:00 (EDT; the ended April rule changes nothing) = 14:00Z", at("20260401T100000"), "2026-04-01T14:00:00.000Z");
}

done();
