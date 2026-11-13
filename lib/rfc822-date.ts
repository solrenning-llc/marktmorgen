/**
 * RFC 822 dates, as RSS 2.0 requires them (RFC 5322 section 3.3 grammar), read and written strictly.
 *
 * Read: an optional English weekday and a comma, a 1 or 2 digit day, an English month abbreviation, a 4-digit
 * year, HH:MM with optional :SS, and a zone that is required: GMT, UT, Z, a US zone name (EST, EDT, CST, CDT,
 * MST, MDT, PST, PDT) or a numeric offset (+HHMM / -HHMM). The time is computed with Date.UTC minus the zone, so
 * the server's own time zone never takes part, and every field is checked back, so 31 Feb or a weekday that is
 * not the date's is refused. Anything else is unknown (rule 24): no lenient fallback, no guessed year, no guessed
 * zone. Two-digit years and single-letter military zones other than Z are refused as ambiguous (RFC 5322 4.3).
 *
 * Written: "Mon, 09 Nov 2026 10:00:00 GMT", only for a whole positive number of seconds whose year has four
 * digits; anything else has no RFC 822 form and gives null, never "Invalid Date".
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const NAMED_ZONES: Record<string, number> = { GMT: 0, UT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };

const RFC822 =
  /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*,\s*)?([0-9]{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-9]{4})\s+([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?\s+(GMT|UT|Z|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-][0-9]{4})$/i;

/** The latest instant with a four-digit year: Fri, 31 Dec 9999 23:59:59 GMT. */
export const LAST_RFC822_SECOND = Date.UTC(9999, 11, 31, 23, 59, 59) / 1000;

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Seconds since the epoch for a strict RFC 822 date, or null when the text is not one (never a guess). */
export function parseRfc822Date(value: string): number | null {
  const m = RFC822.exec(value.trim());
  if (m === null) return null;
  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText, zoneText] = m;
  const day = Number(dayText);
  const month = MONTHS.indexOf(titleCase(monthText) as (typeof MONTHS)[number]);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (month < 0 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  const zone = zoneText.toUpperCase();
  let offset: number;
  if (zone in NAMED_ZONES) offset = NAMED_ZONES[zone];
  else {
    const hh = Number(zone.slice(1, 3));
    const mm = Number(zone.slice(3, 5));
    if (hh > 23 || mm > 59) return null;
    offset = (zone[0] === "-" ? -1 : 1) * (hh * 60 + mm);
  }

  const local = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day) return null;
  if (weekday !== undefined && DAYS[local.getUTCDay()] !== titleCase(weekday)) return null;
  const ms = local.getTime() - offset * 60_000;
  if (!Number.isFinite(ms) || ms % 1000 !== 0) return null;
  return ms / 1000;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The RFC 822 form of a whole positive number of seconds, or null when it has none. */
export function formatRfc822Date(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > LAST_RFC822_SECOND) return null;
  const d = new Date(seconds * 1000);
  return `${DAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} GMT`;
}
