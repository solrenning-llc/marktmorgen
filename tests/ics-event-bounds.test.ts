/**
 * Focal return on #3339, findings 1 and 3 (lib/ics-parse.ts, lib/call-setup.ts
 * partsIn), with synthetic files only.
 *
 * A property past MAX_PROPERTY_CHARS (128 KiB) inside one event affects only
 * that event, never toward free time:
 *   - an id (UID) is read as no id: the event blocks its own time, is never
 *     taken for one of our bookings and moves no time of another event;
 *   - an EXDATE list is left out: every time of the repeat blocks;
 *   - an RDATE list, a repeat rule, an end or a length: the event blocks from
 *     its first time to the end of the window and is counted in `unreadable`;
 *   - a STATUS or TRANSP: read as neither cancelled nor free;
 *   - a RECURRENCE-ID: the moved copy blocks its own time and frees none;
 *   - an event's own start (DTSTART), or such a property outside any event,
 *     still refuses the whole file (CalendarTooComplex).
 * The rest of the file is read as before.
 *
 * Zones (memory): a zone written as an offset (+0530, -0800) is read as that
 * fixed offset, with no formatter built for it; one file may use at most
 * MAX_FILE_ZONES named zones, past which it is refused; partsIn keeps its
 * formatters and lets the oldest go one at a time.
 */
import * as ics from "@/lib/ics-parse";
import { CalendarTooComplex, parseIcs } from "@/lib/ics-parse";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};
const calendar = (events: string[], head = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//event-bounds//EN\r\n${head}${events.join("")}END:VCALENDAR\r\n`;
const vevent = (lines: string[]) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;

// Monday 9 November 2026, noon UTC; the window of lib/calendar-sync.ts readFeed.
const now0 = Date.UTC(2026, 10, 9, 12);
const window = { from: now0 - DAY, to: now0 + 120 * DAY, fallbackTz: "UTC" };
const ownHour = Date.UTC(2026, 10, 11, 15);
const outsideFirst = Date.UTC(2026, 10, 20, 10);
const own = vevent(["UID:own-hour@example.com", `DTSTART:${stamp(ownHour)}`, `DTEND:${stamp(ownHour + HOUR)}`]);
const LONG = 140_000;

const read = (text: string) => {
  try {
    return parseIcs(text, window);
  } catch (error) {
    if (error instanceof CalendarTooComplex) return "refused" as const;
    throw error;
  }
};
const covers = (busy: { start: number; end: number }[], start: number, end: number) => busy.some((b) => b.start <= start && b.end >= end);

// Counts of the formatters partsIn builds (the only ones made with hourCycle "h23").
const Original = Intl.DateTimeFormat;
let clockFormatters = 0;
class Counting extends Original {
  constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    super(locales, options);
    if (options?.hourCycle === "h23") clockFormatters += 1;
  }
}
(Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Counting;

/** The most named zones one file may use (read through the module, so a missing figure fails its check below). */
const MAX_FILE_ZONES = Number((ics as Record<string, unknown>).MAX_FILE_ZONES);

function main(): void {
  is("setup: lib/ics-parse.ts names its zone cap, a whole number under partsIn's 512 formatters", Number.isInteger(MAX_FILE_ZONES) && MAX_FILE_ZONES > 0 && MAX_FILE_ZONES < 512, true);
  part("Control: a file with no property past the cap");
  const plain = read(calendar([own, vevent(["UID:out@example.org", `DTSTART:${stamp(outsideFirst)}`, "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=3"])]));
  is("control: read, both events' times busy", plain !== "refused" && [covers(plain.busy, ownHour, ownHour + HOUR), covers(plain.busy, outsideFirst + 7 * DAY, outsideFirst + 7 * DAY + HOUR), plain.unreadable], [true, true, 0]);

  part("A UID past the cap: the event is read with no id");
  {
    const longUid = `UID:${"u".repeat(LONG)}@marktmorgen.com`;
    const file = calendar([own, vevent([longUid, `DTSTART:${stamp(outsideFirst)}`, "DURATION:PT1H"])]);
    const got = read(file);
    is("setup: the file is over 128 KiB", file.length > 131_072, true);
    is("the file is read, not refused", got === "refused" ? "refused" : "read", "read");
    if (got !== "refused") {
      is("the creator's own hour is busy", covers(got.busy, ownHour, ownHour + HOUR), true);
      is("the event blocks its own time (never taken for one of our bookings by its id's ending)", covers(got.busy, outsideFirst, outsideFirst + HOUR), true);
      is("and nothing else of the window", covers(got.busy, outsideFirst + 2 * HOUR, outsideFirst + 3 * HOUR), false);
    }
    // A moved copy with a long id frees no time of a repeat whose id is short, and the reverse.
    const series = vevent(["UID:series@example.org", `DTSTART:${stamp(outsideFirst)}`, "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=5"]);
    const movedLong = vevent([`UID:${"s".repeat(LONG)}`, `RECURRENCE-ID:${stamp(outsideFirst + DAY)}`, `DTSTART:${stamp(outsideFirst + DAY + 5 * HOUR)}`, "DURATION:PT1H"]);
    const both = read(calendar([series, movedLong]));
    is("a moved copy with a long id: the repeat's own time stays busy, and so does the copy", both !== "refused" && [covers(both.busy, outsideFirst + DAY, outsideFirst + DAY + HOUR), covers(both.busy, outsideFirst + DAY + 5 * HOUR, outsideFirst + DAY + 6 * HOUR)], [true, true]);
  }

  part("An EXDATE list past the cap: left out, every time of the repeat blocks");
  {
    const dates = Array.from({ length: 8_500 }, (_, i) => stamp(outsideFirst + i * DAY)).join(",");
    const file = calendar([own, vevent(["UID:ex@example.org", `DTSTART:${stamp(outsideFirst)}`, "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=10", `EXDATE:${dates}`])]);
    const got = read(file);
    is("setup: the EXDATE line is over the cap", dates.length > 131_072, true);
    is("the file is read, not refused", got === "refused" ? "refused" : "read", "read");
    if (got !== "refused") {
      is("every time of the repeat blocks (none taken out)", [0, 3, 9].map((d) => covers(got.busy, outsideFirst + d * DAY, outsideFirst + d * DAY + HOUR)), [true, true, true]);
      is("the creator's own hour is busy, and a time between is free", [covers(got.busy, ownHour, ownHour + HOUR), covers(got.busy, outsideFirst + 2 * HOUR, outsideFirst + 3 * HOUR)], [true, false]);
    }
  }

  for (const [label, line] of [
    ["an RDATE list", `RDATE:${Array.from({ length: 8_500 }, (_, i) => stamp(outsideFirst + (i + 1) * DAY)).join(",")}`],
    ["a repeat rule", `RRULE:FREQ=DAILY;BYHOUR=${Array.from({ length: 70_000 }, () => "1").join(",")}`],
    ["an end", `DTEND:${stamp(outsideFirst + HOUR)}${" ".repeat(LONG)}`],
    ["a length", `DURATION:PT1H${" ".repeat(LONG)}`],
  ] as const) {
    part(`${label[0].toUpperCase()}${label.slice(1)} past the cap: the event blocks from its first time to the end of the window`);
    const file = calendar([own, vevent(["UID:big@example.org", `DTSTART:${stamp(outsideFirst)}`, ...(label === "an end" || label === "a length" ? [] : ["DURATION:PT1H"]), line])]);
    const got = read(file);
    is("setup: the line is over the cap", line.length > 131_072, true);
    is("the file is read, not refused", got === "refused" ? "refused" : "read", "read");
    if (got !== "refused") {
      is("counted unreadable", got.unreadable, 1);
      is("busy from its first time to the end of the window", covers(got.busy, outsideFirst, window.to), true);
      is("a time before its first time is free, and the creator's own hour busy", [covers(got.busy, outsideFirst - 3 * HOUR, outsideFirst - 2 * HOUR), covers(got.busy, ownHour, ownHour + HOUR)], [false, true]);
    }
  }

  for (const [label, line] of [
    ["STATUS", `STATUS:CANCELLED${" ".repeat(LONG)}`],
    ["TRANSP", `TRANSP:TRANSPARENT${" ".repeat(LONG)}`],
  ] as const) {
    part(`A ${label} past the cap: read as neither cancelled nor free`);
    const got = read(calendar([own, vevent(["UID:st@example.org", `DTSTART:${stamp(outsideFirst)}`, "DURATION:PT1H", line])]));
    is("the file is read, and the event's time is busy", got !== "refused" && covers(got.busy, outsideFirst, outsideFirst + HOUR), true);
  }

  part("A RECURRENCE-ID past the cap: the moved copy frees no time");
  {
    const series = vevent(["UID:series2@example.org", `DTSTART:${stamp(outsideFirst)}`, "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=5"]);
    const moved = vevent(["UID:series2@example.org", `RECURRENCE-ID:${stamp(outsideFirst + DAY)}${" ".repeat(LONG)}`, `DTSTART:${stamp(outsideFirst + DAY + 5 * HOUR)}`, "DURATION:PT1H"]);
    const got = read(calendar([own, series, moved]));
    is("the file is read", got === "refused" ? "refused" : "read", "read");
    if (got !== "refused") {
      is("the repeat's time stays busy, and the copy blocks its own", [covers(got.busy, outsideFirst + DAY, outsideFirst + DAY + HOUR), covers(got.busy, outsideFirst + DAY + 5 * HOUR, outsideFirst + DAY + 6 * HOUR)], [true, true]);
    }
  }

  part("Still refused whole: an event's own start past the cap, or such a property outside any event");
  is("a DTSTART past the cap", read(calendar([own, vevent(["UID:ds@example.org", `DTSTART:${stamp(outsideFirst)}${" ".repeat(LONG)}`, "DURATION:PT1H"])])), "refused");
  is("an X-WR-TIMEZONE past the cap", read(calendar([own], `X-WR-TIMEZONE:${"Z".repeat(LONG)}\r\n`)), "refused");
  is("a TZID past the cap, inside a zone", read(calendar([own], `BEGIN:VTIMEZONE\r\nTZID:${"Z".repeat(LONG)}\r\nEND:VTIMEZONE\r\n`)), "refused");
  is("a BEGIN past the cap", read(calendar([own, `BEGIN:VEVENT${" ".repeat(LONG)}\r\nDTSTART:${stamp(outsideFirst)}\r\nEND:VEVENT\r\n`])), "refused");

  part("Zones written as offsets: read as fixed offsets, with no formatter built");
  {
    const offsets: string[] = [];
    for (let h = 0; offsets.length < 700; h += 1) for (let m = 0; m < 60 && offsets.length < 700; m += 1) offsets.push(`+${pad(h)}${pad(m)}`);
    const day = (i: number) => {
      const d = new Date(Date.UTC(2026, 10, 10) + (i % 100) * DAY);
      return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    };
    const events = Array.from({ length: 3_000 }, (_, i) => vevent([`UID:o${i}@example.org`, `DTSTART;TZID=${offsets[i % 700]}:${day(i)}T${pad(8 + (i % 9))}0000`, `DTEND;TZID=${offsets[(i + 350) % 700]}:${day(i)}T${pad(9 + (i % 9))}0000`]));
    clockFormatters = 0;
    const got = read(calendar(events));
    console.log(`        700 offset zones, 3,000 events: formatters built for local times ${clockFormatters}`);
    is("the file is read", got === "refused" ? "refused" : "read", "read");
    is("no formatter built for a local time in an offset zone", clockFormatters, 0);
    const exact = read(calendar([
      vevent(["UID:a@example.org", "DTSTART;TZID=+0530:20261116T100000", "DURATION:PT1H"]),
      vevent(["UID:b@example.org", "DTSTART;TZID=-0800:20261117T090000", "DURATION:PT1H"]),
    ]));
    is("+0530 10:00 is 04:30 UTC, and -0800 09:00 is 17:00 UTC", exact !== "refused" && [covers(exact.busy, Date.UTC(2026, 10, 16, 4, 30), Date.UTC(2026, 10, 16, 5, 30)), covers(exact.busy, Date.UTC(2026, 10, 17, 17), Date.UTC(2026, 10, 17, 18))], [true, true]);
  }

  part(`Named zones: at most MAX_FILE_ZONES (${MAX_FILE_ZONES}) in one file`);
  {
    const zones = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone").filter((z) => z.includes("/"));
    const file = (count: number) => calendar(Array.from({ length: count }, (_, i) => vevent([`UID:z${i}@example.org`, `DTSTART;TZID=${zones[i]}:20261116T100000`, "DURATION:PT1H"])));
    is("setup: enough zone names", zones.length > MAX_FILE_ZONES + 1, true);
    is("at the cap: read", read(file(MAX_FILE_ZONES)) === "refused" ? "refused" : "read", "read");
    is("one past the cap: refused whole", read(file(MAX_FILE_ZONES + 1)), "refused");
    clockFormatters = 0;
    for (let i = 0; i < 3; i += 1) read(file(MAX_FILE_ZONES));
    is("the same zones read again build no formatter (kept, none emptied)", clockFormatters, 0);
  }

  (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Original;
}

main();
done();
