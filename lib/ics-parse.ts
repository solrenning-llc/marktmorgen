/**
 * Reading a calendar file for the times its owner is busy.
 *
 * A creator's calendar reaches us as a published iCalendar file: Google's
 * "secret address in iCal format", Outlook's published ICS, an iCloud public
 * calendar. We need one thing from it — when they are busy over the next few
 * months — so this reads that and nothing more, and never keeps a title, a
 * guest or a place. It is written here rather than taken from a package
 * because the packages that do this well are large, and the part we need is
 * small enough to read in one sitting:
 *
 *   - events (VEVENT) with a start and an end or a length; all-day events
 *     cover whole days in the calendar's own time zone;
 *   - times in UTC, in a named IANA zone, in a Windows zone name (Outlook),
 *     in a zone the file defines itself (VTIMEZONE, with its yearly rules),
 *     or floating, which is read in the calendar's zone;
 *   - repeats that are daily, weekly (on chosen days), monthly on the same
 *     date or yearly on the same day, with an interval, an end date (UNTIL)
 *     or a number of times (COUNT), extra dates (RDATE), dates taken out
 *     (EXDATE), and single times moved or cancelled (RECURRENCE-ID);
 *   - an event marked free (TRANSP:TRANSPARENT) or cancelled blocks nothing,
 *     and neither does one of our own bookings, which the creator's calendar
 *     may hold from the booking email (their ids end in @marktmorgen.com).
 *
 * A repeat written with rules beyond those (the second Tuesday of a month,
 * every hour) is counted by its first time only, and the number of such
 * events is reported, so the studio can say so rather than pretend.
 *
 * The work one file may cost is bounded (R27, 9 November 2026): a repeat that
 * began long ago starts close to the window, with the times skipped counted
 * exactly so COUNT ends where it would have; one repeat takes at most
 * MAX_STEPS steps and the whole file at most ICS_MAX_WORK units. A file that
 * needs more is refused whole (CalendarTooComplex), never read in part: a
 * reading cut short would show times as free that the calendar holds busy.
 *
 * The busy stretches kept are capped too (maxIntervals, 2,000), and that cut is
 * by time, never by the order of the file: every stretch before a cutoff is
 * kept exactly, and everything from the cutoff to the end of the window is
 * returned as one busy stretch, so no time whose busy state was not kept is
 * ever offered for booking.
 */
import { isTimeZone, partsIn } from "@/lib/call-setup";

export type Interval = { start: number; end: number };

export type ParsedCalendar = {
  /** Busy stretches inside the window, merged where they touch, soonest first. */
  busy: Interval[];
  /** Events read, counting each repeating event once. */
  events: number;
  /** Repeating events whose rule is beyond what is read here. */
  unsupported: number;
  /**
   * True when there were more busy stretches (after merging) than are kept:
   * the earliest are kept exactly, and the last stretch then runs from the
   * first one left out to the end of the window (or past it), so a time whose
   * busy state was not kept reads as busy, never as free.
   */
  truncated: boolean;
  /** The calendar's own zone, when it names one. */
  zone: string | null;
  /** Units of work the reading cost, at most ICS_MAX_WORK. */
  work: number;
};

type Prop = { name: string; params: Record<string, string>; value: string };

/** How many times one repeating event is stepped through, at most. */
const MAX_STEPS = 5000;

/**
 * The work one whole file may cost, in units: one for each event with a start,
 * each step of a repeat, each date listed in EXDATE, RDATE or RECURRENCE-ID and
 * each conversion of a local time to an instant (one more for each rule of a
 * zone the file defines itself), and four for each zone name looked up. A
 * history of 6,000 single events costs about 12,000; at one formatter per zone
 * (lib/call-setup.ts partsIn) the whole budget is well under two seconds of CPU.
 */
export const ICS_MAX_WORK = 100_000;

/**
 * A calendar file that needs more work than ICS_MAX_WORK, or a repeat that
 * cannot reach the end of the window within MAX_STEPS steps. The file is
 * unreadable, as one that does not answer: lib/calendar-sync.ts readFeed
 * throws it, adding the calendar is refused with its sentence, and a saved
 * calendar keeps its last good reading.
 */
export class CalendarTooComplex extends Error {
  constructor() {
    super("This calendar has too many events or repeating events for us to read. Use a calendar with fewer events, for example one that holds only the times you are busy.");
    this.name = "CalendarTooComplex";
  }
}

const greatestDivisor = (a: number, b: number): number => (b === 0 ? a : greatestDivisor(b, a % b));

/** Whether a year is a leap year, as Date counts them (proleptic Gregorian). */
const leapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The days in month index `m` (year * 12 + month - 1). */
function monthLength(m: number): number {
  const month = m % 12;
  if (month === 1) return leapYear(Math.floor(m / 12)) ? 29 : 28;
  return month === 3 || month === 5 || month === 8 || month === 10 ? 30 : 31;
}

/** How many of y0, y0 + s, ..., y0 + (n - 1) * s are leap years (y0 >= 100, 1 <= s <= 1e6). */
function leapYearsIn(y0: number, s: number, n: number): number {
  if (n <= 0) return 0;
  // How many of them a number m divides: the first one it divides, then one every m / gcd(s, m).
  const divisible = (m: number) => {
    for (let j = 0; j < m && j < n; j += 1) {
      if ((y0 + j * s) % m === 0) return Math.floor((n - 1 - j) / (m / greatestDivisor(s, m))) + 1;
    }
    return 0;
  };
  return divisible(4) - divisible(100) + divisible(400);
}

/**
 * How many of the months m0, m0 + i, ..., m0 + (n - 1) * i have a day `day`
 * (month indexes as in monthLength; m0 >= 1200, 1 <= i <= 1e6).
 */
function monthsWithDay(m0: number, i: number, n: number, day: number): number {
  if (n <= 0) return 0;
  if (day <= 28) return n;
  if (day > 31) return 0;
  if (n <= 64) {
    let with_ = 0;
    for (let k = 0; k < n; k += 1) if (day <= monthLength(m0 + k * i)) with_ += 1;
    return with_;
  }
  // The months of the year that can lack the day, and the grid's months that
  // fall on each: one every q, from the first.
  const q = 12 / greatestDivisor(12, i);
  let without = 0;
  for (const month of day === 31 ? [1, 3, 5, 8, 10] : [1]) {
    let first = -1;
    for (let k = 0; k < q; k += 1) {
      if ((m0 + k * i) % 12 === month) {
        first = k;
        break;
      }
    }
    if (first < 0 || first >= n) continue;
    const hits = Math.floor((n - 1 - first) / q) + 1;
    // The 29th is missing only from February of a year that is not a leap year.
    without += day === 29 ? hits - leapYearsIn(Math.floor((m0 + first * i) / 12), (q * i) / 12, hits) : hits;
  }
  return n - without;
}

/**
 * Our own bookings, which a calendar may hold from the email that confirmed
 * them, and the events we made in the creator's Google Calendar for them
 * (lib/meet-providers.ts, eventId): neither is time the creator is busy for
 * something else, and a group call's event must not hide its seats still free.
 */
const OWN_UID = /(@marktmorgen\.com|@nimbuslabsai\.com|^nimbus[0-9a-v]{26}@google\.com)$/i;

/**
 * Windows time zone names, as Outlook writes them, and the IANA zone each
 * means. Outlook also defines the zone in the file, which is read when a name
 * is not here.
 */
const WINDOWS_ZONES: Record<string, string> = {
  "Dateline Standard Time": "Etc/GMT+12",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time": "America/New_York",
  "US Eastern Standard Time": "America/Indianapolis",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "E. Europe Standard Time": "Europe/Chisinau",
  "GTB Standard Time": "Europe/Bucharest",
  "FLE Standard Time": "Europe/Kiev",
  "Israel Standard Time": "Asia/Jerusalem",
  "Egypt Standard Time": "Africa/Cairo",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Turkey Standard Time": "Europe/Istanbul",
  "Russian Standard Time": "Europe/Moscow",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabian Standard Time": "Asia/Dubai",
  "Iran Standard Time": "Asia/Tehran",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Calcutta",
  "Nepal Standard Time": "Asia/Katmandu",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "SE Asia Standard Time": "Asia/Bangkok",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Taipei Standard Time": "Asia/Taipei",
  "W. Australia Standard Time": "Australia/Perth",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Tasmania Standard Time": "Australia/Hobart",
  "New Zealand Standard Time": "Pacific/Auckland",
};

// ---- Lines and properties ---------------------------------------------------

/** Joins folded lines and splits each into its name, parameters and value. */
function readProps(text: string): Prop[] {
  const raw = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) lines[lines.length - 1] += line.slice(1);
    else if (line) lines.push(line);
  }
  const props: Prop[] = [];
  for (const line of lines) {
    // The value starts after the first colon that is not inside quotes.
    let quoted = false;
    let colon = -1;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      else if (ch === ":" && !quoted) {
        colon = i;
        break;
      }
    }
    if (colon <= 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const parts: string[] = [];
    let current = "";
    quoted = false;
    for (const ch of head) {
      if (ch === '"') quoted = !quoted;
      if (ch === ";" && !quoted) {
        parts.push(current);
        current = "";
      } else current += ch;
    }
    parts.push(current);
    const params: Record<string, string> = {};
    for (const part of parts.slice(1)) {
      const eq = part.indexOf("=");
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
    }
    props.push({ name: parts[0].toUpperCase(), params, value });
  }
  return props;
}

// ---- Time zones -------------------------------------------------------------

type ZoneRule = {
  /** Local start of the first transition, as wall-clock parts. */
  y: number;
  mo: number;
  d: number;
  minute: number;
  from: number;
  to: number;
  rule: Record<string, string> | null;
};

type Zone = { kind: "iana"; tz: string } | { kind: "rules"; rules: ZoneRule[] } | { kind: "utc" };

function ianaFrom(name: string): string | null {
  const clean = name.replace(/^"|"$/g, "").trim();
  if (clean && isTimeZone(clean)) return clean;
  if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean];
  // "(UTC-05:00) Eastern Time (US & Canada)" and "/mozilla.org/.../America/New_York".
  const segments = clean.split("/").filter(Boolean);
  for (let take = Math.min(3, segments.length); take >= 2; take -= 1) {
    const guess = segments.slice(-take).join("/");
    if (isTimeZone(guess)) return guess;
  }
  return null;
}

/** The offset, in minutes ahead of UTC, that a zone has at instant `ms`. */
function offsetAt(zone: Zone, ms: number): number {
  if (zone.kind === "utc") return 0;
  if (zone.kind === "iana") {
    const p = partsIn(ms, zone.tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
  }
  // A zone the file defines: every transition of the years around this one,
  // and the offset of the latest that has already happened.
  const year = new Date(ms).getUTCFullYear();
  let best: { at: number; to: number } | null = null;
  let earliest: { at: number; from: number } | null = null;
  for (const rule of zone.rules) {
    const starts: number[] = [];
    if (rule.rule && rule.rule.FREQ === "YEARLY") {
      for (let y = Math.max(rule.y, year - 1); y <= year + 1; y += 1) {
        const date = yearlyDate(rule.rule, y, rule.mo, rule.d);
        if (date) starts.push(Date.UTC(y, date.mo - 1, date.d, 0, rule.minute) - rule.from * 60000);
      }
    } else {
      starts.push(Date.UTC(rule.y, rule.mo - 1, rule.d, 0, rule.minute) - rule.from * 60000);
    }
    for (const at of starts) {
      if (at <= ms && (!best || at > best.at)) best = { at, to: rule.to };
      if (!earliest || at < earliest.at) earliest = { at, from: rule.from };
    }
  }
  if (best) return best.to;
  return earliest ? earliest.from : 0;
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The month and day a yearly zone rule lands on in year `y`, e.g. the second Sunday of March. */
function yearlyDate(rule: Record<string, string>, y: number, mo: number, d: number): { mo: number; d: number } | null {
  const month = rule.BYMONTH ? Number(rule.BYMONTH.split(",")[0]) : mo;
  if (!(month >= 1 && month <= 12)) return null;
  const byday = rule.BYDAY?.split(",")[0];
  if (!byday) {
    const day = rule.BYMONTHDAY ? Number(rule.BYMONTHDAY.split(",")[0]) : d;
    return { mo: month, d: day };
  }
  const match = byday.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
  if (!match) return null;
  const nth = match[1] ? Number(match[1]) : 1;
  const weekday = DAY_CODES.indexOf(match[2]);
  const days = new Date(Date.UTC(y, month, 0)).getUTCDate();
  if (nth > 0) {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
    return day <= days ? { mo: month, d: day } : null;
  }
  const last = new Date(Date.UTC(y, month - 1, days)).getUTCDay();
  const day = days - ((last - weekday + 7) % 7) + (nth + 1) * 7;
  return day >= 1 ? { mo: month, d: day } : null;
}

/**
 * The instant at which a clock in `zone` shows this date and time. A time in
 * the hour skipped when clocks go forward lands just after the jump, which is
 * what a calendar app shows for it too.
 */
function localToUtc(zone: Zone, y: number, mo: number, d: number, minute: number, second = 0): number {
  const naive = Date.UTC(y, mo - 1, d, 0, minute, second);
  if (zone.kind === "utc") return naive;
  let guess = naive - offsetAt(zone, naive) * 60000;
  guess = naive - offsetAt(zone, guess) * 60000;
  return guess;
}

// ---- Dates ------------------------------------------------------------------

type Stamp = {
  y: number;
  mo: number;
  d: number;
  /** Minutes and seconds into the day; 0 for a date. */
  minute: number;
  second: number;
  /** A date with no time: an all-day event. */
  date: boolean;
  /** Written in UTC, with a trailing Z. */
  utc: boolean;
  tzid: string | null;
};

function readStamp(value: string, params: Record<string, string>): Stamp | null {
  const text = value.trim();
  const m = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = !m[4] || params.VALUE === "DATE";
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    minute: date ? 0 : Number(m[4]) * 60 + Number(m[5]),
    second: date || !m[6] ? 0 : Number(m[6]),
    date,
    utc: Boolean(m[7]),
    tzid: params.TZID ?? null,
  };
}

/** A length written as P1D, PT1H30M, P1W and the like, in milliseconds; null when unreadable. */
function readDuration(value: string): number | null {
  const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms =
    (Number(m[2] ?? 0) * 7 * 86400 + Number(m[3] ?? 0) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? null : ms;
}

function readRule(value: string): Record<string, string> {
  const rule: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  return rule;
}

// ---- The calendar -----------------------------------------------------------

type EventProps = {
  uid: string;
  start: Prop | null;
  end: Prop | null;
  duration: string | null;
  rrule: string | null;
  rdates: Prop[];
  exdates: Prop[];
  recurrenceId: Prop | null;
  status: string;
  transp: string;
};

/**
 * Every busy stretch in the calendar between `from` and `to`, in
 * milliseconds. `fallbackTz` is the zone for all-day and floating times when
 * the calendar names none of its own.
 */
export function parseIcs(
  text: string,
  options: { from: number; to: number; fallbackTz: string; maxIntervals?: number },
): ParsedCalendar {
  const props = readProps(text);
  const maxIntervals = options.maxIntervals ?? 2000;

  // The whole file's work, counted as it is spent (ICS_MAX_WORK).
  let work = 0;
  const spend = (units: number) => {
    work += units;
    if (work > ICS_MAX_WORK) throw new CalendarTooComplex();
  };
  const toUtc = (zone: Zone, y: number, mo: number, d: number, minute: number, second = 0) => {
    spend(zone.kind === "rules" ? 1 + zone.rules.length : 1);
    return localToUtc(zone, y, mo, d, minute, second);
  };

  // First pass: the calendar's zone, the zones it defines, and its events.
  let calendarZone: string | null = null;
  const defined = new Map<string, ZoneRule[]>();
  const events: EventProps[] = [];
  const stack: string[] = [];
  let tzid = "";
  let rules: ZoneRule[] = [];
  let rulePart: { start: Stamp | null; from: number; to: number; rule: Record<string, string> | null } | null = null;
  let event: EventProps | null = null;

  const offset = (value: string) => {
    const m = value.trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  };

  for (const prop of props) {
    if (prop.name === "BEGIN") {
      const what = prop.value.trim().toUpperCase();
      stack.push(what);
      if (what === "VTIMEZONE") {
        tzid = "";
        rules = [];
      } else if ((what === "STANDARD" || what === "DAYLIGHT") && stack.includes("VTIMEZONE")) {
        rulePart = { start: null, from: 0, to: 0, rule: null };
      } else if (what === "VEVENT") {
        event = { uid: "", start: null, end: null, duration: null, rrule: null, rdates: [], exdates: [], recurrenceId: null, status: "", transp: "" };
      }
      continue;
    }
    if (prop.name === "END") {
      const what = prop.value.trim().toUpperCase();
      // Tolerates a file whose blocks are not closed in order.
      const at = stack.lastIndexOf(what);
      if (at !== -1) stack.length = at;
      if ((what === "STANDARD" || what === "DAYLIGHT") && rulePart) {
        if (rulePart.start) {
          rules.push({ y: rulePart.start.y, mo: rulePart.start.mo, d: rulePart.start.d, minute: rulePart.start.minute, from: rulePart.from, to: rulePart.to, rule: rulePart.rule });
        }
        rulePart = null;
      } else if (what === "VTIMEZONE") {
        if (tzid && rules.length) defined.set(tzid, rules);
      } else if (what === "VEVENT" && event) {
        events.push(event);
        event = null;
      }
      continue;
    }
    const inside = stack[stack.length - 1];
    if (inside === "VCALENDAR" && prop.name === "X-WR-TIMEZONE") calendarZone = ianaFrom(prop.value);
    else if (inside === "VTIMEZONE" && prop.name === "TZID") tzid = prop.value.trim();
    else if ((inside === "STANDARD" || inside === "DAYLIGHT") && rulePart) {
      if (prop.name === "DTSTART") rulePart.start = readStamp(prop.value, {});
      else if (prop.name === "TZOFFSETFROM") rulePart.from = offset(prop.value);
      else if (prop.name === "TZOFFSETTO") rulePart.to = offset(prop.value);
      else if (prop.name === "RRULE") rulePart.rule = readRule(prop.value);
    } else if (inside === "VEVENT" && event) {
      switch (prop.name) {
        case "UID":
          event.uid = prop.value.trim();
          break;
        case "DTSTART":
          event.start = prop;
          break;
        case "DTEND":
          event.end = prop;
          break;
        case "DURATION":
          event.duration = prop.value;
          break;
        case "RRULE":
          event.rrule = prop.value;
          break;
        case "RDATE":
          event.rdates.push(prop);
          break;
        case "EXDATE":
          event.exdates.push(prop);
          break;
        case "RECURRENCE-ID":
          event.recurrenceId = prop;
          break;
        case "STATUS":
          event.status = prop.value.trim().toUpperCase();
          break;
        case "TRANSP":
          event.transp = prop.value.trim().toUpperCase();
          break;
      }
    }
  }

  const home: Zone = (() => {
    const tz = calendarZone ?? (isTimeZone(options.fallbackTz) ? options.fallbackTz : "UTC");
    return tz === "UTC" ? { kind: "utc" } : { kind: "iana", tz };
  })();
  const zoneCache = new Map<string, Zone>();
  const zoneOf = (stamp: Stamp): Zone => {
    if (stamp.utc) return { kind: "utc" };
    if (stamp.date || !stamp.tzid) return home;
    const cached = zoneCache.get(stamp.tzid);
    if (cached) return cached;
    spend(4);
    const iana = ianaFrom(stamp.tzid);
    const found = defined.get(stamp.tzid);
    const zone: Zone = iana ? (iana === "UTC" ? { kind: "utc" } : { kind: "iana", tz: iana }) : found ? { kind: "rules", rules: found } : home;
    zoneCache.set(stamp.tzid, zone);
    return zone;
  };
  const instant = (stamp: Stamp) => toUtc(zoneOf(stamp), stamp.y, stamp.mo, stamp.d, stamp.minute, stamp.second);
  const stampsOf = (prop: Prop): Stamp[] =>
    prop.value
      .split(",")
      .map((v) => {
        spend(1);
        return readStamp(v, prop.params);
      })
      .filter((s): s is Stamp => s !== null);

  // Times of a repeating event that were moved or cancelled on their own,
  // by event id: the repeat leaves them out, and the moved copy stands.
  const replaced = new Map<string, { instants: Set<number>; dates: Set<number> }>();
  for (const e of events) {
    if (!e.recurrenceId || !e.uid) continue;
    const entry = replaced.get(e.uid) ?? { instants: new Set<number>(), dates: new Set<number>() };
    for (const stamp of stampsOf(e.recurrenceId)) {
      if (stamp.date) entry.dates.add(stamp.y * 10000 + stamp.mo * 100 + stamp.d);
      else entry.instants.add(instant(stamp));
    }
    replaced.set(e.uid, entry);
  }

  // Every stretch is kept until the end, then cut by time (keptByTime): how
  // many there can be is bounded by the work budget, one unit at least each.
  const busy: Interval[] = [];
  let unsupported = 0;
  let counted = 0;
  const add = (start: number, end: number) => {
    if (end <= options.from || start >= options.to || end <= start) return;
    busy.push({ start, end });
  };

  for (const e of events) {
    if (!e.start) continue;
    spend(1);
    counted += 1;
    if (e.status === "CANCELLED" || e.transp === "TRANSPARENT") continue;
    if (OWN_UID.test(e.uid)) continue;
    const start = readStamp(e.start.value, e.start.params);
    if (!start) continue;
    const zone = zoneOf(start);

    // How long each time lasts: whole days for an all-day event, otherwise
    // the exact length between start and end.
    let days = 0;
    let length = 0;
    const endStamp = e.end ? readStamp(e.end.value, e.end.params) : null;
    if (start.date) {
      if (endStamp) {
        days = Math.round((Date.UTC(endStamp.y, endStamp.mo - 1, endStamp.d) - Date.UTC(start.y, start.mo - 1, start.d)) / 86400000);
      } else if (e.duration) {
        days = Math.max(1, Math.round((readDuration(e.duration) ?? 86400000) / 86400000));
      } else {
        days = 1;
      }
      if (days <= 0) continue;
    } else {
      if (endStamp) length = instant(endStamp) - instant(start);
      else if (e.duration) length = readDuration(e.duration) ?? 0;
      if (length <= 0) continue;
    }

    const occurrence = (y: number, mo: number, d: number) => {
      if (start.date) {
        const first = toUtc(zone, y, mo, d, 0);
        const end = new Date(Date.UTC(y, mo - 1, d + days));
        return { start: first, end: toUtc(zone, end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate(), 0) };
      }
      const at = toUtc(zone, y, mo, d, start.minute, start.second);
      return { start: at, end: at + length };
    };

    if (!e.rrule || e.recurrenceId) {
      const one = occurrence(start.y, start.mo, start.d);
      add(one.start, one.end);
      continue;
    }

    const rule = readRule(e.rrule);
    const excludedInstants = new Set<number>();
    const excludedDates = new Set<number>();
    for (const prop of e.exdates) {
      for (const stamp of stampsOf(prop)) {
        if (stamp.date) excludedDates.add(stamp.y * 10000 + stamp.mo * 100 + stamp.d);
        else excludedInstants.add(instant(stamp));
      }
    }
    const moved = replaced.get(e.uid);
    const skip = (y: number, mo: number, d: number, at: number) => {
      const key = y * 10000 + mo * 100 + d;
      if (excludedDates.has(key) || excludedInstants.has(at)) return true;
      if (moved && (moved.instants.has(at) || moved.dates.has(key))) return true;
      return false;
    };

    const freq = rule.FREQ;
    // A whole number, as the standard has it (a fraction used to step into the middle of a day).
    const interval = Math.max(1, Math.floor(Number(rule.INTERVAL ?? "1")) || 1);
    const count = rule.COUNT ? Math.max(0, Number(rule.COUNT) || 0) : Infinity;
    let untilInstant = Infinity;
    let untilDate = Infinity;
    if (rule.UNTIL) {
      const until = readStamp(rule.UNTIL, {});
      if (until) {
        if (until.date) untilDate = until.y * 10000 + until.mo * 100 + until.d;
        else untilInstant = until.utc ? Date.UTC(until.y, until.mo - 1, until.d, 0, until.minute, until.second) : toUtc(zone, until.y, until.mo, until.d, until.minute, until.second);
      }
    }
    const byDay = (rule.BYDAY ?? "").split(",").filter(Boolean);
    const plainDays = byDay.every((code) => DAY_CODES.includes(code));
    const others = Object.keys(rule).filter((k) => !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"].includes(k));
    const readable =
      others.length === 0 &&
      plainDays &&
      (freq === "DAILY" || freq === "WEEKLY" || ((freq === "MONTHLY" || freq === "YEARLY") && byDay.length === 0));
    if (!readable) {
      unsupported += 1;
      const one = occurrence(start.y, start.mo, start.d);
      add(one.start, one.end);
      continue;
    }

    // Walks the local calendar, so a weekly 9 a.m. stays at 9 a.m. on both
    // sides of a clock change. A repeat that began long ago starts close to the
    // window rather than at its first date; the times it skips are counted, so
    // COUNT still ends exactly where it would have.
    let made = 0;
    let steps = 0;
    let finished = false;
    const step = () => {
      steps += 1;
      spend(1);
    };
    const take = (y: number, mo: number, d: number): boolean => {
      const at = occurrence(y, mo, d);
      const key = y * 10000 + mo * 100 + d;
      if (key > untilDate || at.start > untilInstant) return false;
      if (made >= count) return false;
      made += 1;
      if (!skip(y, mo, d, at.start)) add(at.start, at.end);
      return at.start < options.to;
    };
    const startDay = Date.UTC(start.y, start.mo - 1, start.d);
    const dateAt = (ms: number) => {
      const date = new Date(ms);
      return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()] as const;
    };
    const wanted = new Set(byDay.map((code) => DAY_CODES.indexOf(code)));

    // A time is skipped only when its whole local day, its length and any
    // offset a zone can have (a file's own zone may say up to 99 hours) all
    // end before the window: its day is earlier than `before`.
    const DAY = 86400000;
    const before = options.from - (start.date ? days * DAY : length) - 11 * DAY;
    const jumps = interval <= 1e6;

    if (freq === "DAILY") {
      const span = interval * DAY;
      const skipped = jumps && before > startDay ? Math.ceil((before - startDay) / span) : 0;
      // With chosen weekdays, which days of the grid land on one repeats every seven.
      const firstWeekday = new Date(startDay).getUTCDay();
      const lands = (k: number) => !wanted.size || wanted.has((firstWeekday + (k % 7) * (interval % 7)) % 7);
      let perWeek = 0;
      for (let k = 0; k < 7; k += 1) if (lands(k)) perWeek += 1;
      if (perWeek === 0) finished = true;
      made = Math.floor(skipped / 7) * perWeek;
      for (let k = Math.floor(skipped / 7) * 7; k < skipped; k += 1) if (lands(k)) made += 1;
      for (let n = skipped * interval; !finished && steps < MAX_STEPS; n += interval, step()) {
        const [y, mo, d] = dateAt(startDay + n * DAY);
        if (wanted.size && !wanted.has(new Date(Date.UTC(y, mo - 1, d)).getUTCDay())) continue;
        if (!take(y, mo, d)) finished = true;
      }
    } else if (freq === "WEEKLY") {
      const weekStart = DAY_CODES.indexOf(rule.WKST ?? "MO");
      const firstWeekday = new Date(startDay).getUTCDay();
      if (!wanted.size) wanted.add(firstWeekday);
      const order = [...wanted].sort((a, b) => ((a - weekStart + 7) % 7) - ((b - weekStart + 7) % 7));
      const weekOf = startDay - ((firstWeekday - weekStart + 7) % 7) * DAY;
      // A week is skipped when its last day is earlier than `before`; the
      // first week holds only its days from the first date on.
      const lastOfFirst = weekOf + 6 * DAY;
      const skipped = jumps && before > lastOfFirst ? Math.ceil((before - lastOfFirst) / (7 * interval * DAY)) : 0;
      if (skipped) made = order.filter((weekday) => weekOf + ((weekday - weekStart + 7) % 7) * DAY >= startDay).length + (skipped - 1) * order.length;
      for (let w = skipped * interval; !finished && steps < MAX_STEPS; w += interval) {
        for (const weekday of order) {
          step();
          const day = weekOf + (w * 7 + ((weekday - weekStart + 7) % 7)) * DAY;
          if (day < startDay) continue;
          const [y, mo, d] = dateAt(day);
          if (!take(y, mo, d)) {
            finished = true;
            break;
          }
        }
      }
    } else if (freq === "MONTHLY") {
      const first = new Date(Date.UTC(start.y, start.mo - 1, 1));
      const startMonth = first.getUTCFullYear() * 12 + first.getUTCMonth();
      // Month indexes from year 100 on: Date reads years 0-99 as 1900-1999.
      const counts = jumps && startMonth >= 1200;
      // A day no month of the grid has (the 30th of every February) never lands.
      if (counts && monthsWithDay(startMonth, interval, 4800 / greatestDivisor(4800, interval), start.d) === 0) finished = true;
      const limit = new Date(before);
      const lastSkipped = limit.getUTCFullYear() * 12 + limit.getUTCMonth() - 1;
      const skipped = counts && lastSkipped >= startMonth ? Math.floor((lastSkipped - startMonth) / interval) + 1 : 0;
      made = monthsWithDay(startMonth, interval, skipped, start.d);
      for (let n = skipped * interval; !finished && steps < MAX_STEPS; n += interval, step()) {
        const month = new Date(Date.UTC(start.y, start.mo - 1 + n, 1));
        const y = month.getUTCFullYear();
        const mo = month.getUTCMonth() + 1;
        // A month without that date (the 31st in April) is skipped, as the standard says.
        if (start.d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) continue;
        if (!take(y, mo, start.d)) finished = true;
      }
    } else {
      const leapDay = start.mo === 2 && start.d === 29;
      const counts = jumps && start.y >= 100;
      if (counts && leapDay && leapYearsIn(start.y, interval, 400) === 0) finished = true;
      // A month or day past the end of the year moves the date on, by under nine years.
      const lastSkipped = new Date(before).getUTCFullYear() - 10;
      const skipped = counts && lastSkipped >= start.y ? Math.floor((lastSkipped - start.y) / interval) + 1 : 0;
      made = leapDay ? leapYearsIn(start.y, interval, skipped) : skipped;
      for (let n = skipped * interval; !finished && steps < MAX_STEPS; n += interval, step()) {
        const y = start.y + n;
        if (leapDay && new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1) continue;
        if (!take(y, start.mo, start.d)) finished = true;
      }
    }
    // A repeat its steps could not walk to the end of the window would leave
    // busy times out: the file is unreadable, not read in part.
    if (!finished) throw new CalendarTooComplex();

    // Extra times named one by one.
    for (const prop of e.rdates) {
      for (const stamp of stampsOf(prop)) {
        const at = stamp.date ? occurrence(stamp.y, stamp.mo, stamp.d) : { start: instant(stamp), end: instant(stamp) + (length || days * 86400000) };
        if (!skip(stamp.y, stamp.mo, stamp.d, at.start)) add(at.start, at.end);
      }
    }
  }

  const kept = keptByTime(mergeIntervals(busy), maxIntervals, options.to);
  return { busy: kept.busy, events: counted, unsupported, truncated: kept.truncated, zone: calendarZone, work };
}

/**
 * At most `max` stretches of a merged list, cut by time: the earliest
 * `max - 1` exactly, then one from the start of the first left out to the end
 * of the window (or the latest end left out, when later). Every time from the
 * cutoff on reads busy, so a slot whose busy state was not kept is never
 * offered; a list within `max` is returned as it is.
 */
function keptByTime(merged: Interval[], max: number, to: number): { busy: Interval[]; truncated: boolean } {
  const cap = Math.max(1, Math.floor(max) || 1);
  if (merged.length <= cap) return { busy: merged, truncated: false };
  const cutoff = merged[cap - 1].start;
  let end = to;
  for (let i = cap - 1; i < merged.length; i += 1) end = Math.max(end, merged[i].end);
  return { busy: [...merged.slice(0, cap - 1), { start: cutoff, end }], truncated: true };
}

/** Joins stretches that overlap or touch, soonest first. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else out.push({ ...item });
  }
  return out;
}

/** Whether a text looks like a calendar file at all. */
export function looksLikeCalendar(text: string): boolean {
  return /^\uFEFF?\s*BEGIN:VCALENDAR/i.test(text.slice(0, 200));
}
