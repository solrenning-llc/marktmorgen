/**
 * Claude 2's review of #3339 (R27 finding 1, still open): ICS_MAX_WORK
 * counted units, but did not bound time. One unit could cost about 18 ms, and
 * the first pass over the file was not charged at all, so hostile files under
 * the 2 MB cap held the function from 11 s to an estimated half hour.
 *
 *   - HIGH 1: every local-time conversion in a zone the file defines re-split
 *     the zone rule's BYMONTH/BYDAY/BYMONTHDAY lists, whatever their size
 *     (a DAYLIGHT rule with 450,000 BYMONTH entries: 7.8 s for one event,
 *     200 s for 30).
 *   - HIGH 2: the first pass was quadratic and free: `stack` had no depth
 *     limit and was scanned on every END (68 s) and every BEGIN:STANDARD
 *     (13.8 s); every X-WR-TIMEZONE line built failing Intl formatters (11 s).
 *   - LOW 4: an INTERVAL above 1e6 left the range of Date and gave NaN
 *     times, or a RangeError in a named zone.
 *
 * Since Claude 2's focal return on #3339 (finding A), one event's own rule
 * past the per-rule caps (an INTERVAL above 1e6, a rule longer than 2,048
 * characters, a BYxxx list of more than 400 items) no longer refuses the
 * file: that event blocks from its first time to the end of the window, and
 * the rest of the file is read. Limits of the whole file still refuse it.
 *
 * Held here, with synthetic files only: each hostile file runs in its own
 * child process (this same bundle, ICS_HOSTILE_PROBE=<name>), killed after
 * PROBE_KILL_MS; it must answer, by a reading or by CalendarTooComplex, within
 * PROBE_BOUND_MS, a bound loose enough for a loaded CI machine and far under
 * the times above. A whole-file budget of lines, a cap on what one property
 * or rule list may hold, a depth cap, rules read once into numbers, a zone
 * name looked up once, and a wall-clock deadline (the backstop) make it so.
 * Normal files, including one with an Outlook-style zone of its own, read
 * exactly as the slow walk (tests/ics-walk-reference.ts) reads them.
 *
 * Network: none.
 */
import { spawnSync } from "node:child_process";
import * as ics from "@/lib/ics-parse";
import { walkIcs } from "./ics-walk-reference";
import { done, is, part } from "./check";

// Read through a plain record so this file also builds against the parser
// before the fix (the RED commit), where some of these names did not exist.
const named = ics as unknown as Record<string, unknown>;
const TooComplex = named.CalendarTooComplex as (new (...args: never[]) => Error) | undefined;
const MAX_WORK = named.ICS_MAX_WORK as number | undefined;
const isTooComplex = (error: unknown) => Boolean(TooComplex) && error instanceof (TooComplex as new () => Error);

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9, 12);
const WINDOW = { from: NOW - DAY, to: NOW + 120 * DAY, fallbackTz: "UTC" };
/** A hostile file must be answered within this, in its own process. */
const PROBE_BOUND_MS = 2_500;
/** And its process is killed after this (the times before the fix were 7.8 s to 30 min). */
const PROBE_KILL_MS = 15_000;
const MB = 1_000_000;

type Options = Parameters<typeof ics.parseIcs>[1];
type Outcome = { ms: number; refused: boolean; error: string | null; work: number | null; busy: number | null; nan: boolean; zone: string | null };

function calendar(body: string): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//hostile//EN\r\n${body}END:VCALENDAR\r\n`;
}
function vevent(lines: string[]): string {
  return `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;
}
/** A line repeated until the body reaches `bytes`. */
const filled = (line: string, bytes: number) => line.repeat(Math.floor(bytes / line.length));

/** Claude 2's HIGH 1 file: a zone whose DAYLIGHT rule lists `entries` months, then `events` daily events in it. */
function zoneRuleFile(entries: number, events: number): string {
  const zone = [
    "BEGIN:VTIMEZONE", "TZID:X",
    "BEGIN:STANDARD", "DTSTART:19701101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
    "BEGIN:DAYLIGHT", "DTSTART:19700308T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", `RRULE:FREQ=YEARLY;BYMONTH=${"3,".repeat(entries - 1)}3;BYDAY=2SU`, "END:DAYLIGHT",
    "END:VTIMEZONE",
  ].join("\r\n") + "\r\n";
  const body = Array.from({ length: events }, (_, i) => vevent([`UID:z${i}`, "DTSTART;TZID=X:20261110T090000", "DTEND;TZID=X:20261110T100000", "RRULE:FREQ=DAILY"])).join("");
  return calendar(zone + body);
}

const PROBES: Record<string, () => { text: string; options?: Partial<Options> }> = {
  // HIGH 1, the single-event file (900,331 bytes, 7.8 s) and the 30-event one (803,657 bytes, 199.8 s).
  "zone rule, 450,000 BYMONTH entries, 1 event": () => ({ text: zoneRuleFile(450_000, 1) }),
  "zone rule, 400,000 BYMONTH entries, 30 events": () => ({ text: zoneRuleFile(400_000, 30) }),
  // HIGH 2: 1 MB of BEGIN:A, then 1 MB of END:B (68.2 s).
  "1 MB of BEGIN:A, then 1 MB of END:B": () => ({ text: `BEGIN:VCALENDAR\r\n${filled("BEGIN:A\r\n", MB)}${filled("END:B\r\n", MB)}` }),
  // HIGH 2: 1 MB of BEGIN:A, then 1 MB of BEGIN:STANDARD (13.8 s).
  "1 MB of BEGIN:A, then 1 MB of BEGIN:STANDARD": () => ({ text: `BEGIN:VCALENDAR\r\n${filled("BEGIN:A\r\n", MB)}${filled("BEGIN:STANDARD\r\n", MB)}` }),
  // HIGH 2: 2 MB of X-WR-TIMEZONE lines naming no zone (11.0 s).
  "2 MB of X-WR-TIMEZONE:a/b/c/d": () => ({ text: `BEGIN:VCALENDAR\r\n${filled("X-WR-TIMEZONE:a/b/c/d\r\n", 2 * MB - 40)}END:VCALENDAR\r\n` }),
  // The memory note: 2 MB of two-byte properties, read whole at work 0 (91 MB of heap).
  "2 MB of 'A:' lines": () => ({ text: `BEGIN:VCALENDAR\r\n${filled("A:\r\n", 2 * MB - 40)}END:VCALENDAR\r\n` }),
  // 2 MB of folded continuation lines on one property.
  "2 MB of continuation lines": () => ({ text: `BEGIN:VCALENDAR\r\nRRULE:FREQ=DAILY\r\n${filled(" ;\r\n", 2 * MB - 60)}END:VCALENDAR\r\n` }),
  // Zone names that each cost failing formatter builds, all different (no cache helps).
  "25,000 events, each in a different unknown zone name": () => ({
    text: calendar(Array.from({ length: 25_000 }, (_, i) => `BEGIN:VEVENT\r\nDTSTART;TZID=a/b/c/z${i}:20261110T090000\r\nDURATION:PT1H\r\nEND:VEVENT\r\n`).join("")),
  }),
  // A zone with many short rules: each conversion is charged by its rules, and each rule is now a few numbers.
  "a zone with 3,000 rule parts and 40 daily events": () => {
    const parts = Array.from({ length: 3000 }, (_, i) => `BEGIN:${i % 2 ? "DAYLIGHT" : "STANDARD"}\r\nDTSTART:${1000 + (i >> 1)}0308T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nEND:${i % 2 ? "DAYLIGHT" : "STANDARD"}\r\n`).join("");
    const body = Array.from({ length: 40 }, (_, i) => vevent([`UID:r${i}`, "DTSTART;TZID=X:20261110T090000", "DURATION:PT1H", "RRULE:FREQ=DAILY"])).join("");
    return { text: calendar(`BEGIN:VTIMEZONE\r\nTZID:X\r\n${parts}END:VTIMEZONE\r\n${body}`) };
  },
};

function runProbe(name: string): void {
  const { text, options } = PROBES[name]();
  const t = performance.now();
  let outcome: Omit<Outcome, "ms">;
  try {
    const parsed = ics.parseIcs(text, { ...WINDOW, ...options });
    outcome = { refused: false, error: null, work: parsed.work ?? null, busy: parsed.busy.length, nan: parsed.busy.some((b) => !Number.isFinite(b.start) || !Number.isFinite(b.end)), zone: parsed.zone };
  } catch (error) {
    outcome = { refused: isTooComplex(error), error: String(error).slice(0, 160), work: null, busy: null, nan: false, zone: null };
  }
  const ms = Math.round(performance.now() - t);
  console.log(`PROBE ${JSON.stringify({ bytes: text.length, ms, ...outcome })}`);
}

function probe(name: string): { outcome: (Outcome & { bytes: number }) | null; wallMs: number; killed: boolean } {
  const t = Date.now();
  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, ICS_HOSTILE_PROBE: name },
    timeout: PROBE_KILL_MS,
    encoding: "utf8",
    maxBuffer: 1 << 20,
  });
  const wallMs = Date.now() - t;
  const line = (child.stdout ?? "").split("\n").find((l) => l.startsWith("PROBE "));
  return { outcome: line ? JSON.parse(line.slice(6)) : null, wallMs, killed: child.signal !== null || child.status !== 0 };
}

function tryParse(text: string, options: Options): { parsed: ics.ParsedCalendar | null; error: unknown } {
  try {
    return { parsed: ics.parseIcs(text, options), error: null };
  } catch (error) {
    return { parsed: null, error };
  }
}
const shape = (p: Pick<ics.ParsedCalendar, "busy" | "events" | "unsupported" | "truncated" | "zone">) => ({ busy: p.busy, events: p.events, unsupported: p.unsupported, truncated: p.truncated, zone: p.zone });

function main(): void {
  part(`Hostile files under the 2 MB cap are answered within ${PROBE_BOUND_MS} ms, each in its own process`);
  for (const name of Object.keys(PROBES)) {
    const { outcome, wallMs, killed } = probe(name);
    const summary = outcome ? `${outcome.bytes} bytes, parse ${outcome.ms} ms, ${outcome.refused ? "refused (CalendarTooComplex)" : outcome.error ? `threw ${outcome.error}` : `read, work ${outcome.work}, busy ${outcome.busy}`}` : `no answer (${killed ? `killed after ${wallMs} ms` : "no output"})`;
    console.log(`        ${name}: ${summary}`);
    is(`${name}: answered within the bound, as a reading or as CalendarTooComplex`, outcome !== null && outcome.ms < PROBE_BOUND_MS && (outcome.refused || outcome.error === null), true);
    if (outcome && !outcome.refused && outcome.error === null) {
      is(`${name}: within the work budget, with no NaN time`, [typeof outcome.work === "number" && typeof MAX_WORK === "number" && outcome.work <= MAX_WORK, outcome.nan], [true, false]);
    }
  }

  part("Each over-size shape is refused whole, not read in part");
  {
    const refusedFor = (label: string, text: string) => {
      const { parsed, error } = tryParse(text, WINDOW);
      is(`${label}: refused as too complex`, [parsed === null, isTooComplex(error)], [true, true]);
    };
    refusedFor("2 MB of 'A:' lines (over the file's line budget)", PROBES["2 MB of 'A:' lines"]().text);
    refusedFor("blocks nested 40 deep", calendar(`${"BEGIN:X\r\n".repeat(40)}${vevent(["UID:d", "DTSTART:20261110T090000Z", "DURATION:PT1H"])}`));
    refusedFor("a zone rule with 401 BYMONTH entries", zoneRuleFile(401, 1));
    const firstOn = Date.UTC(2026, 10, 10, 9);
    const blockedFor = (label: string, text: string) => {
      const { parsed, error } = tryParse(text, WINDOW);
      const read = parsed as (ics.ParsedCalendar & { unreadable?: number }) | null;
      is(`${label}: read, the event blocking from its first time to the end of the window`, [error === null, read?.busy, read?.unreadable], [true, [{ start: firstOn, end: WINDOW.to }], 1]);
    };
    blockedFor("an event rule with 401 BYDAY entries", calendar(vevent(["UID:b", "DTSTART:20261110T090000Z", "DURATION:PT1H", `RRULE:FREQ=WEEKLY;BYDAY=${"MO,".repeat(400)}MO`])));
    blockedFor("an event rule longer than 2,048 characters", calendar(vevent(["UID:l", "DTSTART:20261110T090000Z", "DURATION:PT1H", `RRULE:FREQ=DAILY;X-PAD=${"A".repeat(2100)}`])));
    // Since the focal return on #3339: an EXDATE list past the cap is left out, not the file refused, so every
    // time of the repeat blocks, the one it named included (tests/ics-event-bounds.test.ts).
    {
      const { parsed, error } = tryParse(calendar(vevent(["UID:x", "DTSTART:20261110T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY", `EXDATE:${"20261111T090000Z,".repeat(8000)}20261111T090000Z`])), WINDOW);
      const named = Date.UTC(2026, 10, 11, 9);
      is("an EXDATE property longer than 128 KiB: read, left out, the time it named still busy", [error === null, parsed?.busy.some((b) => b.start <= named && b.end >= named + 3_600_000)], [true, true]);
    }
  }

  part("LOW 4: an INTERVAL above 1e6 blocks from the event's first time to the end of the window, never a NaN time or a RangeError");
  for (const [label, start, first] of [["in UTC", "DTSTART:20261110T090000Z", Date.UTC(2026, 10, 10, 9)], ["in a named zone", "DTSTART;TZID=America/New_York:20261110T090000", Date.UTC(2026, 10, 10, 14)]] as const) {
    const { parsed, error } = tryParse(calendar(vevent(["UID:i", start, "DURATION:PT1H", "RRULE:FREQ=DAILY;INTERVAL=1000000000"])), WINDOW);
    console.log(`        ${label}: ${parsed ? `busy ${JSON.stringify(parsed.busy)}` : String(error)}`);
    is(`DAILY;INTERVAL=1000000000 ${label}: read, blocking from its first time to the end of the window`, [error === null, parsed?.busy], [true, [{ start: first, end: WINDOW.to }]]);
  }
  {
    const { parsed, error } = tryParse(calendar(vevent(["UID:w", "DTSTART:20261110T090000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;INTERVAL=5000000"])), WINDOW);
    is("WEEKLY;INTERVAL=5000000: read, blocking from its first time to the end of the window", [error === null, parsed?.busy], [true, [{ start: Date.UTC(2026, 10, 10, 9), end: WINDOW.to }]]);
    const ok = tryParse(calendar(vevent(["UID:k", "DTSTART:20261110T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;INTERVAL=1000000"])), WINDOW);
    is("an INTERVAL of exactly 1e6 is still read (its one time in the window)", [ok.error === null, ok.parsed?.busy.length], [true, 1]);
  }
  {
    const { parsed, error } = tryParse(calendar(vevent(["UID:f", "DTSTART;TZID=America/New_York:20261110T090000", `DURATION:P${"9".repeat(400)}W`])), WINDOW);
    is("a length past every date (DURATION of 400 digits) is refused, not stored as a null end", [parsed === null, isTooComplex(error)], [true, true]);
  }

  part("The wall-clock backstop: a parse past its deadline is refused (maxMs)");
  {
    const crowded = calendar(Array.from({ length: 200 }, (_, i) => vevent([`UID:c${i}`, "DTSTART;TZID=America/New_York:20261101T090000", "DURATION:PT30M", "RRULE:FREQ=DAILY"])).join(""));
    const fine = tryParse(crowded, WINDOW);
    is("setup: the file reads within its budget by default", [fine.error === null, (fine.parsed?.work ?? 0) > 5_000], [true, true]);
    const late = tryParse(crowded, { ...WINDOW, maxMs: 0 } as Options);
    is("with a deadline already past, it is refused as too complex", [late.parsed === null, isTooComplex(late.error)], [true, true]);
    is("the default deadline is a named number, well under the 20-second read lock", typeof named.ICS_MAX_MS === "number" && (named.ICS_MAX_MS as number) >= 1_000 && (named.ICS_MAX_MS as number) <= 8_000, true);
  }

  part("Normal files read exactly as before: an Outlook-style zone of its own, and a mixed calendar");
  {
    const outlook = [
      "BEGIN:VTIMEZONE", "TZID:Eastern Custom",
      "BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3", "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VTIMEZONE", "TZID:Last Sunday Zone",
      "BEGIN:STANDARD", "DTSTART:19961027T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:19810329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
      "BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VTIMEZONE", "TZID:Month Day Zone",
      "BEGIN:STANDARD", "DTSTART:20000415T000000", "TZOFFSETFROM:+0330", "TZOFFSETTO:+0300", "RRULE:FREQ=YEARLY;BYMONTHDAY=15;BYMONTH=4", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:20000922T000000", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0330", "RRULE:FREQ=YEARLY", "END:DAYLIGHT",
      "END:VTIMEZONE",
    ].join("\r\n") + "\r\n";
    const events = [
      vevent(["UID:o1", "DTSTART;TZID=Eastern Custom:20261101T013000", "DTEND;TZID=Eastern Custom:20261101T030000", "RRULE:FREQ=WEEKLY;BYDAY=SU,WE"]),
      vevent(["UID:o2", "DTSTART;TZID=Last Sunday Zone:20240301T090000", "DURATION:PT1H", "RRULE:FREQ=DAILY;INTERVAL=3", "EXDATE;TZID=Last Sunday Zone:20261115T090000"]),
      vevent(["UID:o3", "DTSTART;TZID=Month Day Zone:20260101T120000", "DURATION:PT2H", "RRULE:FREQ=MONTHLY"]),
      vevent(["UID:o4", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261122"]),
      vevent(["UID:o2", "RECURRENCE-ID;TZID=Last Sunday Zone:20261118T090000", "DTSTART;TZID=Last Sunday Zone:20261118T150000", "DURATION:PT1H"]),
      `BEGIN:VEVENT\r\nUID:o5\r\nDTSTART;TZID="Eastern Custom":20261203T100000\r\nDESCRIPTION:a long note, folded\r\n  over two lines; with: colons\r\nDURATION:PT45M\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\n`,
    ].join("");
    const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Europe/Berlin\r\n${outlook}${events}END:VCALENDAR\r\n`;
    const options = { ...WINDOW, maxIntervals: 1_000_000 };
    const { parsed, error } = tryParse(text, options);
    const want = walkIcs(text, options);
    is("setup: the slow walk reads busy times from every zone", want.busy.length > 60, true);
    is("the same reading as the slow walk", parsed ? shape(parsed) : String(error), shape(want));
  }

  part("A normal 500-event calendar is not slower");
  {
    const normal = calendar(Array.from({ length: 500 }, (_, i) => vevent([
      `UID:n${i}@example.com`, `DTSTART;TZID=America/New_York:2026${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T090000`, "DURATION:PT1H", "SUMMARY:Lesson", "DESCRIPTION:Notes for the lesson",
    ])).join(""));
    const t = performance.now();
    const { parsed, error } = tryParse(normal, WINDOW);
    const ms = Math.round(performance.now() - t);
    console.log(`        ${normal.length} bytes: ${ms} ms, work ${parsed?.work}`);
    is("read in under 1,000 ms, with the same reading as the slow walk", [error === null, ms < 1_000, parsed ? shape(parsed) : null], [true, true, shape(walkIcs(normal, WINDOW))]);
  }
}

if (process.env.ICS_HOSTILE_PROBE) runProbe(process.env.ICS_HOSTILE_PROBE);
else {
  main();
  done();
}
