/**
 * A recurring series of one call (637 [GL5], unit 5a; added 3 November
 * 2026): the rules, browser-safe. Charging it on the creator's Stripe
 * account, holding its dates, the booking page and the studio are the next
 * units.
 *
 *   - Weekly or every two weeks (SERIES_CADENCES), MIN_SERIES to MAX_SERIES
 *     sessions, for weekly hours with one person a time only: a group shares
 *     its times and a dated session has its own.
 *   - Each session is at the same clock time in the creator's time zone as
 *     the first, across a change of daylight saving time; a date whose clock
 *     time does not exist that day (the hour skipped in spring) is said, not
 *     moved to another time.
 *   - Every date must be a time the call offers and nobody holds, read as
 *     the booking page reads it (lib/call-setup.ts, isOpenSlot): the
 *     creator's hours, notice, gap, and the busy times, including the
 *     calendars synced with it (lib/calendar-sync.ts). The booking window
 *     (horizonDays) is stretched for the series' own later dates only, which
 *     the studio must say to the creator. A synced calendar is read only so
 *     far ahead (lib/calendar-limits.ts LOOKAHEAD_DAYS, lib/host-calendar.ts
 *     HOST_LOOKAHEAD_DAYS): the caller passes `knownUntil`, the end of the
 *     busy times it read, and a date past it is not free, since unknown is
 *     never free. A series with any date that is not free is refused, naming
 *     each date; nothing is booked in part, and no time is hidden to look
 *     busy.
 *   - When a series ends early (cancelled by the buyer within the creator's
 *     rules, which the booking unit checks, or by the creator), every
 *     session that has not started yet is cancelled (toCancel), and never
 *     charged (chargeable); one already started at that moment took place.
 *     Sessions are known by their position in the series, never by their
 *     start, so a session moved within the rules keeps its place.
 */
import { type Busy, type CallSetup, openSlots, partsIn, zonedToUtc } from "@/lib/call-setup";

export const SERIES_CADENCES = ["weekly", "biweekly"] as const;
export type SeriesCadence = (typeof SERIES_CADENCES)[number];
export const MIN_SERIES = 2;
export const MAX_SERIES = 12;
const DAY = 86_400_000;

export type SeriesProblem = "cadence" | "count" | "kind";

/** What the studio or the booking page sends, as kept, or why not. */
export function readSeries(
  raw: { cadence?: unknown; count?: unknown },
  setup: Pick<CallSetup, "kind" | "seats">,
): { ok: true; cadence: SeriesCadence; count: number } | { ok: false; why: SeriesProblem } {
  if (setup.kind !== "weekly" || setup.seats !== 1) return { ok: false, why: "kind" };
  const cadence = (SERIES_CADENCES as readonly unknown[]).includes(raw.cadence) ? (raw.cadence as SeriesCadence) : null;
  if (!cadence) return { ok: false, why: "cadence" };
  const count = typeof raw.count === "number" && Number.isInteger(raw.count) ? raw.count : typeof raw.count === "string" && /^\d{1,2}$/.test(raw.count) ? Number(raw.count) : Number.NaN;
  if (!(count >= MIN_SERIES && count <= MAX_SERIES)) return { ok: false, why: "count" };
  return { ok: true, cadence, count };
}

/** What the studio says for each problem, with how to fix it. */
export const SERIES_PROBLEMS: Record<SeriesProblem, string> = {
  cadence: "Pick how often the sessions repeat: every week or every two weeks.",
  count: `Pick how many sessions the series has, from ${MIN_SERIES} to ${MAX_SERIES}.`,
  kind: "A series is for weekly hours with one person at a time. A group or a dated session has its own times.",
};

/**
 * Each session's start, the first included, at the first's clock time in
 * `tz`; null where that clock time does not exist on that day.
 */
export function seriesStarts(first: number, tz: string, cadence: SeriesCadence, count: number): (number | null)[] {
  const p = partsIn(first, tz);
  const minute = p.hour * 60 + p.minute;
  const step = cadence === "weekly" ? 7 : 14;
  return Array.from({ length: count }, (_, i) => {
    // The calendar date i steps on, counted on the date itself, never on instants a clock change would shift.
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i * step));
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), minute, tz);
    // A clock time skipped that day comes back as another time: said as missing, never moved.
    if (at === null) return null;
    const back = partsIn(at, tz);
    return back.hour * 60 + back.minute === minute ? at : null;
  });
}

/**
 * The dates of a series that cannot be booked, by position (0 is the
 * first): a clock time that does not exist that day, or a time the call
 * does not offer or somebody holds. Empty: every date is free.
 */
export function seriesConflicts(setup: CallSetup, now: number, busy: Busy[], starts: (number | null)[], productId: string, knownUntil: number): number[] {
  const last = Math.max(0, ...starts.map((s) => s ?? 0));
  // The booking window, stretched for the series' own later dates only: each is still checked against the hours, notice, gap and busy times.
  const days = Math.max(setup.horizonDays, Math.ceil((last - now) / DAY) + 1);
  // Each window's open times read once, then each date looked up in them.
  const own = new Set(openSlots(setup, now, busy, productId).flatMap((d) => d.starts));
  const wide = days > setup.horizonDays ? new Set(openSlots({ ...setup, horizonDays: days }, now, busy, productId).flatMap((d) => d.starts)) : own;
  const minutes = setup.minutes * 60_000;
  return starts.flatMap((start, i) => {
    if (start === null) return [i];
    // Past the busy times read (a synced calendar's own reach), nothing is known: not free.
    if (start + minutes > knownUntil) return [i];
    return (i === 0 ? own : wide).has(start) ? [] : [i];
  });
}

/** The positions of the sessions not yet started when a series ends at `at`: each is cancelled, and none is charged. */
export function toCancel(starts: readonly number[], at: number): number[] {
  return starts.flatMap((start, i) => (start > at ? [i] : []));
}

/** The positions a series may charge for: every session but the cancelled ones. */
export function chargeable(count: number, cancelled: readonly number[]): number[] {
  const gone = new Set(cancelled);
  return Array.from({ length: count }, (_, i) => i).filter((i) => !gone.has(i));
}

/** The dates that cannot be booked, said to the buyer or the creator, in the creator's time zone. */
export function conflictWords(starts: (number | null)[], conflicts: number[], tz: string, first: number, cadence: SeriesCadence): string {
  if (!conflicts.length) return "";
  const when = (ms: number) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: tz }).format(ms);
  const date = (ms: number) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(ms);
  const step = (cadence === "weekly" ? 7 : 14) * DAY;
  // A clock time that does not exist that day is said with its date, found from the first and the cadence (noon that day, safe from the clock change).
  const said = conflicts.map((i) => (starts[i] === null ? `${date(first + i * step + 12 * 3_600_000)} (that time does not exist that day)` : when(starts[i] as number)));
  const list = new Intl.ListFormat("en-US", { type: "conjunction" }).format(said);
  return `The series cannot be booked, because these times are not open: ${list}. Pick another first time, or fewer sessions.`;
}
