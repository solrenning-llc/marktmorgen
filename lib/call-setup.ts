/**
 * A paid call: what the creator offers, when, and the arithmetic of time.
 *
 * Nothing here touches the network, so the studio can use the same rules in
 * the browser that the server enforces, and the booking page can show exactly
 * the times the server will accept.
 *
 * A call is sold in one of two ways, and both are the same product underneath:
 *
 *   - weekly hours ("weekly"): the creator says when they are free each week
 *     and buyers pick a time inside it. Each time has a number of seats — one
 *     for a one-to-one call, up to MAX_SEATS for a group call — and stays open
 *     until every seat is taken;
 *   - dated live sessions ("live"): a webinar or workshop the creator puts on
 *     particular days. Each session has its own date, time, length, seats (up
 *     to MAX_SESSION_SEATS) and meeting link, and buyers pick one.
 *
 * Either way one payment buys one seat at one start time, so the rest of the
 * booking machinery — holds, the lock, Stripe as the ledger, the emails — has
 * only one thing to count: seats taken at a start time, per product.
 *
 * Time is the hard part, and it is done without a library. The creator's
 * week is written in their own time zone — "Mondays from 9 to 12" — and every
 * slot is turned into one exact instant, in UTC, using the time zone database
 * the platform already carries (Intl). Daylight saving is handled by asking
 * that database, twice, what the offset is at the instant being built, which
 * is the standard way to do it and the only one that survives the two days a
 * year the clocks move.
 */
import { type CallPlace, parsePlace } from "@/lib/call-place";

/** Call lengths a creator may pick, in minutes. */
export const CALL_LENGTHS = [15, 20, 30, 45, 60, 90, 120] as const;

/** Gaps a creator may leave between two calls, in minutes. */
export const BUFFERS = [0, 5, 10, 15, 30, 60] as const;

/** How soon a call may be booked: never closer than this many hours. */
export const NOTICE_CHOICES = [1, 2, 4, 12, 24, 48, 72] as const;

/** How far ahead a call may be booked, in days. */
export const HORIZON_CHOICES = [7, 14, 21, 30, 60, 90] as const;

/** Up to two stretches of time on any one day, e.g. a morning and an evening. */
export const MAX_RANGES_PER_DAY = 2;

/** Seats in one weekly time: 1 is a one-to-one call, more a group call. */
export const MAX_SEATS = 50;

/** Seats in one dated live session. */
export const MAX_SESSION_SEATS = 500;

/** Dated sessions one product may list at once, past ones included. */
export const MAX_SESSIONS = 50;

/** Lengths a dated session may have, in minutes. */
export const SESSION_LENGTHS = [15, 20, 30, 45, 60, 90, 120, 180, 240] as const;

/**
 * How soon before a dated session sales close. 0 keeps it on sale until it
 * starts, which weekly calls do not offer: a creator who put a session on a
 * date is there anyway, while a weekly time needs warning to be kept free.
 */
export const SESSION_NOTICE_CHOICES = [0, 1, 2, 4, 12, 24, 48, 72] as const;

/** How many times a buyer may move one booking to another time themselves. */
export const MAX_MOVES = 2;

/** Dated sessions that ended longer ago than this are let go when saved. */
export const KEEP_PAST_SESSION_DAYS = 30;

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Minutes from midnight, [start, end). */
export type Range = [number, number];

/** One dated live session, fixed by the creator. */
export type LiveSession = {
  /** Its own id, so the studio can tell rows apart while they are edited. */
  id: string;
  /** When it starts, in milliseconds since the epoch. */
  start: number;
  minutes: number;
  /** How many buyers it takes. */
  seats: number;
  room: string | null;
};

export type CallSetup = {
  /** Weekly hours with seats per time, or sessions on fixed dates. */
  kind: "weekly" | "live";
  /** How long one call lasts. For dated sessions each has its own. */
  minutes: number;
  /** The creator's time zone, as the time zone database names it. */
  tz: string;
  /** Seven entries, Sunday first; each holds up to two ranges. */
  weekly: Range[][];
  noticeHours: number;
  horizonDays: number;
  bufferMinutes: number;
  /** Where the call happens: a meeting link the creator already has. */
  room: string | null;
  /**
   * Whether each booking gets a private video room made for it instead
   * (lib/call-rooms.ts): a Jitsi Meet link nobody else knows. False is the
   * creator's own link above, which every setup saved before rooms existed
   * keeps.
   */
  video: boolean;
  /**
   * Whether a Google Meet or Zoom meeting is made for each booking, on the
   * creator's own connected account (lib/meet-links.ts), instead of either of
   * the above. When that cannot be done the booking gets the creator's own
   * link, or a private video room when they have none. Null for every setup
   * saved before the choice existed, and whenever the deployment has neither.
   */
  meet: MeetProvider | null;
  /** Buyers per weekly time: 1 for a one-to-one call, up to MAX_SEATS. */
  seats: number;
  /** The dated sessions, soonest first. Empty for weekly hours. */
  sessions: LiveSession[];
  /**
   * In person, at this address (lib/call-place.ts; 520 [LB1], unit 2): then
   * there is no meeting at all, so the link, the video room and the meeting
   * above are always off. Absent for every setup that is a call, which is
   * every setup saved before it existed.
   */
  place?: CallPlace;
};

export const MAX_ROOM_LENGTH = 500;

/** The two services a meeting can be made on for each booking (lib/meet-links.ts). */
export type MeetProvider = "google" | "zoom";

export function isMeetProvider(value: unknown): value is MeetProvider {
  return value === "google" || value === "zoom";
}

/** What each is called where a creator or a buyer reads it. */
export const MEET_NAMES: Record<MeetProvider, string> = { google: "Google Meet", zoom: "Zoom" };

/** Whether the platform knows this time zone. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A meeting link that is safe to hand a buyer: https, and nothing that runs. */
export function cleanRoom(raw: unknown): string | null | "bad" {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim().slice(0, MAX_ROOM_LENGTH);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return "bad";
    if (!url.hostname.includes(".")) return "bad";
    return url.toString();
  } catch {
    return "bad";
  }
}

export type SetupProblem =
  | "minutes"
  | "tz"
  | "weekly"
  | "notice"
  | "horizon"
  | "buffer"
  | "room"
  | "place"
  | "seats"
  | "sessions"
  | "session_time"
  | "session_seats"
  | "session_room";

const SESSION_ID = /^[a-z0-9]{8,16}$/;

export function newSessionId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

/**
 * Reads one dated session. The studio sends a date and a clock time, read in
 * the creator's zone here, so the instant is worked out once, on the server,
 * with the same daylight-saving rules as everything else; storage sends the
 * instant itself.
 */
function readSession(raw: unknown, tz: string, inPersonHere = false): LiveSession | SetupProblem {
  if (!raw || typeof raw !== "object") return "sessions";
  const value = raw as Record<string, unknown>;
  let start: number | null = null;
  if (typeof value.date === "string" || typeof value.time === "string") {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value.date === "string" ? value.date.trim() : "");
    const time = fromClock(typeof value.time === "string" ? value.time : "");
    if (!date || time === null || time >= 24 * 60) return "session_time";
    start = zonedToUtc(Number(date[1]), Number(date[2]), Number(date[3]), time, tz);
    if (start === null) return "session_time";
  } else {
    const read = Number(value.start);
    if (!Number.isInteger(read) || read <= 0 || read % 60_000 !== 0) return "session_time";
    start = read;
  }
  const minutes = Number(value.minutes);
  if (!(SESSION_LENGTHS as readonly number[]).includes(minutes)) return "session_time";
  const seats = Number(value.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SESSION_SEATS) return "session_seats";
  // In person (lib/call-place.ts): no link, so one left over in the form is not read at all.
  const room = inPersonHere ? null : cleanRoom(value.room);
  if (room === "bad") return "session_room";
  const id = typeof value.id === "string" && SESSION_ID.test(value.id) ? value.id : newSessionId();
  return { id, start, minutes, seats, room };
}

/** Reads a setup sent from the studio, or says which part is wrong. */
export function readSetup(raw: unknown): CallSetup | SetupProblem {
  if (!raw || typeof raw !== "object") return "minutes";
  const value = raw as Record<string, unknown>;

  if (value.kind === "live") {
    if (!isTimeZone(value.tz)) return "tz";
    const noticeHours = Number(value.noticeHours ?? 0);
    if (!(SESSION_NOTICE_CHOICES as readonly number[]).includes(noticeHours)) return "notice";
    if (!Array.isArray(value.sessions) || value.sessions.length === 0 || value.sessions.length > MAX_SESSIONS) {
      return "sessions";
    }
    const livePlace = parsePlace(value.place);
    if (!livePlace.ok) return "place";
    const sessions: LiveSession[] = [];
    for (const item of value.sessions) {
      const read = readSession(item, value.tz as string, livePlace.place !== null);
      if (typeof read === "string") return read;
      sessions.push(read);
    }
    sessions.sort((a, b) => a.start - b.start);
    // A session is known to buyers and bookings by its start, so two at the
    // same moment would be one session sold twice.
    for (let i = 1; i < sessions.length; i += 1) {
      if (sessions[i].start === sessions[i - 1].start) return "sessions";
    }
    const ids = new Set(sessions.map((s) => s.id));
    if (ids.size !== sessions.length) return "sessions";
    if (livePlace.place) return { ...inPerson(sessions), tz: value.tz as string, noticeHours, minutes: sessions[0].minutes, place: livePlace.place };
    return {
      kind: "live",
      minutes: sessions[0].minutes,
      tz: value.tz as string,
      weekly: [[], [], [], [], [], [], []],
      noticeHours,
      horizonDays: 30,
      bufferMinutes: 0,
      room: null,
      video: value.video === true,
      meet: isMeetProvider(value.meet) ? value.meet : null,
      seats: 1,
      sessions,
    };
  }

  const minutes = Number(value.minutes);
  if (!(CALL_LENGTHS as readonly number[]).includes(minutes)) return "minutes";
  if (!isTimeZone(value.tz)) return "tz";
  const noticeHours = Number(value.noticeHours);
  if (!(NOTICE_CHOICES as readonly number[]).includes(noticeHours)) return "notice";
  const horizonDays = Number(value.horizonDays);
  if (!(HORIZON_CHOICES as readonly number[]).includes(horizonDays)) return "horizon";
  const bufferMinutes = Number(value.bufferMinutes ?? 0);
  if (!(BUFFERS as readonly number[]).includes(bufferMinutes)) return "buffer";

  if (!Array.isArray(value.weekly) || value.weekly.length !== 7) return "weekly";
  const weekly: Range[][] = [];
  let any = false;
  for (const day of value.weekly) {
    if (!Array.isArray(day) || day.length > MAX_RANGES_PER_DAY) return "weekly";
    const ranges: Range[] = [];
    for (const range of day) {
      if (!Array.isArray(range) || range.length !== 2) return "weekly";
      const [start, end] = range.map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return "weekly";
      if (start < 0 || end > 24 * 60 || start % 5 !== 0 || end % 5 !== 0) return "weekly";
      // A stretch has to hold at least one call.
      if (end - start < minutes) return "weekly";
      ranges.push([start, end]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.length === 2 && ranges[1][0] < ranges[0][1]) return "weekly";
    if (ranges.length) any = true;
    weekly.push(ranges);
  }
  if (!any) return "weekly";

  const place = parsePlace(value.place);
  if (!place.ok) return "place";
  // In person: no link, so one left over in the form is not read at all.
  const room = place.place ? null : cleanRoom(value.room);
  if (room === "bad") return "room";

  // A setup saved before group calls existed is a one-to-one call.
  const seats = Number(value.seats ?? 1);
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) return "seats";

  return {
    kind: "weekly",
    minutes,
    tz: value.tz as string,
    weekly,
    noticeHours,
    horizonDays,
    bufferMinutes,
    // In person: no link, no video room, no meeting (lib/call-place.ts).
    room: place.place ? null : room,
    video: place.place ? false : value.video === true,
    meet: place.place ? null : isMeetProvider(value.meet) ? value.meet : null,
    seats,
    sessions: [],
    ...(place.place ? { place: place.place } : {}),
  };
}

/** Dated sessions held in person: no link, no video room, no meeting, for any of them. */
function inPerson(sessions: LiveSession[]): Omit<CallSetup, "tz" | "noticeHours" | "minutes"> {
  return { kind: "live", weekly: [[], [], [], [], [], [], []], horizonDays: 30, bufferMinutes: 0, room: null, video: false, meet: null, seats: 1, sessions };
}

/** Whatever came back from storage, made safe to use, or null. */
export function parseSetup(raw: unknown): CallSetup | null {
  const read = readSetup(raw);
  return typeof read === "string" ? null : read;
}

/** The parts of a date as a clock in `tz` shows them at instant `ms`. */
export function partsIn(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday,
  };
}

/** How far `tz` is ahead of UTC at instant `ms`, in minutes. */
function offsetAt(ms: number, tz: string): number {
  const p = partsIn(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

/**
 * The instant at which a clock in `tz` shows this date and time.
 *
 * Returns null for a wall-clock time that does not exist there — the hour
 * skipped when the clocks go forward — so no slot is ever offered at a time
 * nobody's clock will show.
 */
export function zonedToUtc(year: number, month: number, day: number, minuteOfDay: number, tz: string): number | null {
  const naive = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  let guess = naive - offsetAt(naive, tz) * 60000;
  guess = naive - offsetAt(guess, tz) * 60000;
  const check = partsIn(guess, tz);
  const wanted = new Date(naive);
  if (
    check.year !== wanted.getUTCFullYear() ||
    check.month !== wanted.getUTCMonth() + 1 ||
    check.day !== wanted.getUTCDate() ||
    check.hour * 60 + check.minute !== wanted.getUTCHours() * 60 + wanted.getUTCMinutes()
  ) {
    return null;
  }
  return guess;
}

/**
 * One seat taken, or one stretch of the creator's time spoken for.
 *
 * `product` and `session` are known for every booking and hold made since
 * group calls: the product says whose seat it is, the checkout session makes
 * the same booking counted once when it is seen both here and at Stripe.
 */
export type Busy = { start: number; end: number; product?: string; session?: string };

/** The dated session that starts at this instant, if there is one. */
export function sessionAt(setup: CallSetup, start: number): LiveSession | null {
  if (setup.kind !== "live") return null;
  return setup.sessions.find((s) => s.start === start) ?? null;
}

/** The meeting link for a booking at this start. */
export function roomFor(setup: CallSetup, start: number): string | null {
  return setup.kind === "live" ? sessionAt(setup, start)?.room ?? null : setup.room;
}

/** Seats at this start: the weekly number, or the session's own. */
export function seatsAt(setup: CallSetup, start: number): number {
  return setup.kind === "live" ? sessionAt(setup, start)?.seats ?? 0 : setup.seats;
}

/** Whether this is a call several buyers share. */
export function isGroup(setup: CallSetup): boolean {
  return setup.kind === "live" || setup.seats > 1;
}

/** Seats of this product already taken, or held, at this start. */
export function seatsTaken(busy: Busy[], productId: string, start: number): number {
  return busy.filter((b) => b.product === productId && b.start === start).length;
}

/**
 * The last moment a booking at `start` may be moved by its buyer: the
 * creator's notice, and never within the hour before it starts.
 */
export function movableUntil(setup: CallSetup, start: number): number {
  return start - Math.max(setup.noticeHours, 1) * 3600_000;
}

export type Day = {
  /** The date on the creator's calendar, YYYY-MM-DD. */
  date: string;
  /** Start instants, in milliseconds since the epoch. */
  starts: number[];
};

/**
 * Every slot a buyer may book right now, grouped by the creator's day.
 *
 * A slot is offered when it starts after the notice period, begins within
 * the horizon, fits inside one of the creator's stretches for that weekday,
 * has a seat left, and does not come within the buffer of anything else
 * already booked or held — anything, that is, but the other seats of this
 * same time, which is what makes a group call.
 */
export function openSlots(setup: CallSetup, now: number, busy: Busy[], productId?: string): Day[] {
  if (setup.kind !== "weekly") return [];
  const earliest = now + setup.noticeHours * 3600_000;
  const latest = now + setup.horizonDays * 86400_000;
  const length = setup.minutes * 60_000;
  const gap = setup.bufferMinutes * 60_000;
  const days: Day[] = [];

  const first = partsIn(now, setup.tz);
  // Walk the creator's calendar one day at a time, from today.
  for (let offset = 0; offset <= setup.horizonDays + 1; offset += 1) {
    const cursor = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const weekday = cursor.getUTCDay();
    const starts: number[] = [];
    for (const [from, to] of setup.weekly[weekday] ?? []) {
      for (let t = from; t + setup.minutes <= to; t += setup.minutes + setup.bufferMinutes) {
        const start = zonedToUtc(y, m, d, t, setup.tz);
        if (start === null) continue;
        if (start < earliest || start > latest) continue;
        const end = start + length;
        const mine = (b: Busy) => productId !== undefined && b.product === productId && b.start === start;
        if (productId !== undefined && seatsTaken(busy, productId, start) >= setup.seats) continue;
        const clash = busy.some((b) => !mine(b) && start < b.end + gap && end + gap > b.start);
        if (!clash) starts.push(start);
      }
    }
    if (starts.length) {
      days.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, starts });
    }
  }
  return days;
}

/** Whether one exact instant is a slot a buyer may book right now. */
export function isOpenSlot(setup: CallSetup, now: number, busy: Busy[], start: number, productId?: string): boolean {
  return openSlots(setup, now, busy, productId).some((day) => day.starts.includes(start));
}

export type OpenSession = { start: number; end: number; minutes: number; seats: number; left: number };

/**
 * The dated sessions a buyer may book right now, soonest first: not started,
 * not past the creator's cut-off, and with a seat left. A session is not
 * blocked by the creator's other bookings: they put it on that date
 * themselves.
 */
export function openSessions(setup: CallSetup, now: number, busy: Busy[], productId: string): OpenSession[] {
  if (setup.kind !== "live") return [];
  const closes = setup.noticeHours * 3600_000;
  const open: OpenSession[] = [];
  for (const session of setup.sessions) {
    if (session.start - closes <= now) continue;
    const left = session.seats - seatsTaken(busy, productId, session.start);
    if (left <= 0) continue;
    open.push({
      start: session.start,
      end: session.start + session.minutes * 60_000,
      minutes: session.minutes,
      seats: session.seats,
      left,
    });
  }
  return open;
}

/** Whether a buyer may take a seat at this start right now, for either kind. */
export function isBookable(setup: CallSetup, now: number, busy: Busy[], start: number, productId: string): boolean {
  if (setup.kind === "live") return openSessions(setup, now, busy, productId).some((s) => s.start === start);
  return isOpenSlot(setup, now, busy, start, productId);
}

/** How long a booking at `start` lasts, in milliseconds, for either kind. */
export function lengthAt(setup: CallSetup, start: number): number | null {
  if (setup.kind === "live") {
    const session = sessionAt(setup, start);
    return session ? session.minutes * 60_000 : null;
  }
  return setup.minutes * 60_000;
}

/**
 * A time as a person reads it, in a given zone: "Tuesday, October 6, 9:30 AM".
 * In English unless given a buyer's store's locale (lib/store-language.ts,
 * LANGUAGES[code].locale): "martes, 6 de octubre, 9:30".
 */
export function readableTime(ms: number, tz: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** The zone's short name at that instant, e.g. "EDT" or "GMT+1"; in a store's locale, "MESZ" for German. */
export function zoneName(ms: number, tz: string, locale = "en-US"): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

/** "9:00" style, from minutes past midnight. For the studio's fields. */
export function clock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes past midnight from "09:30". */
export function fromClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

/** A sensible first week for a creator who has not set one: weekdays, 9 to 5. */
export function defaultWeekly(): Range[][] {
  return [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
}
