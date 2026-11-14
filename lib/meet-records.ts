/**
 * What was arranged on Google Calendar or Zoom for one call, written down.
 *
 * A creator who connected Google Calendar or Zoom (lib/meet-connect.ts) and
 * chose it for a call gets a meeting made on their own account for every
 * booking, or one per time for a group call or a dated session
 * (lib/meet-links.ts). Each meeting is one record here, found by its
 * "scope": the booking or the time it is for.
 *
 *   nl:meet:r:<scope>   the record below
 *   nl:meet:q           records with something left to do, by when it is due
 *
 * Scopes for calls:
 *
 *   c:<callsId>:b:<checkout session>        a one-to-one call
 *   c:<callsId>:t:<product>:<start>         a group call or a dated session
 *
 * Anything else that wants a meeting later (a community event, say) names
 * its own scope and goes through the same function in lib/meet-links.ts.
 *
 * The record says which link the people booked were given, and that is the
 * link every page, email, reminder and calendar file shows from then on
 * (lib/call-rooms.ts reads it first): the Meet or Zoom link when the meeting
 * was made, or — when it could not be, and the booking could not wait — the
 * creator's own link or a private video room. A link given is never changed
 * behind anybody's back: when a meeting that failed is made later by the
 * five-minute job, the people booked are emailed the new link
 * (lib/call-meetings.ts), and `updates` counts how often that happened, so
 * a calendar file sent afterward replaces the one sent before.
 *
 * Nothing here reaches the network, so the pages that only read a link
 * never wait on Google or Zoom.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type MeetProvider, cleanRoom, isMeetProvider } from "@/lib/call-setup";

/** What is still to be done on the provider's side for a record. */
export type MeetTodo = "" | "create" | "patch" | "delete" | "guests";

export type MeetRecord = {
  provider: MeetProvider;
  scope: string;
  /** The store's statsId, whose connection made (or should make) it. */
  statsId: string;
  /** The store's handle when it was written, and its callsId, for the five-minute job. */
  handle: string;
  callsId: string;
  /** The product, and for a one-to-one call its checkout session. */
  product: string;
  session: string;
  group: boolean;
  /** The event id (Google) or meeting id (Zoom); empty until one was made. */
  id: string;
  /** Which Google or Zoom account made it, so another account never touches it. */
  account: string;
  /** The link the people booked were given. */
  link: string;
  /** Whether `link` is the meeting's own, rather than the fallback. */
  made: boolean;
  /** When it is, as it should be on the provider's side. */
  start: number;
  end: number;
  /** The creator's time zone, for how the event reads in their calendar. */
  tz: string;
  title: string;
  /** Group calls on Google: the buyers who should be on the event's guest list, and those we put there. */
  guests: string[];
  added: string[];
  todo: MeetTodo;
  /** Tries of the current `todo`, and when the next is due (0: none). */
  tries: number;
  next: number;
  /** The last problem, in words a creator can act on; empty when there is none. */
  error: string;
  /** How many times the link given was replaced by the meeting's own after a failure. */
  updates: number;
  /** Cancelled: refunded, so the meeting was removed or is being removed. */
  gone: boolean;
  /**
   * A team booking's host whose own Google Calendar it is on (lib/host-calendar.ts),
   * by host id, and that calendar's id; both empty for the store's own connection
   * and its primary calendar.
   */
  host: string;
  calendar: string;
};

export const MEET_QUEUE = "nl:meet:q";
export const recordKey = (scope: string) => `nl:meet:r:${scope}`;

/** Records are kept this long after the call they are for. */
const KEEP_AFTER_MS = 60 * 86_400_000;

const SCOPE_PATTERN = /^[a-z]:[A-Za-z0-9_:.-]{1,300}$/;

export function isScope(value: unknown): value is string {
  return typeof value === "string" && SCOPE_PATTERN.test(value);
}

/** The scope of a one-to-one call, or of one time of a group call. */
export function callScope(callsId: string, input: { group: boolean; session: string; product: string; start: number }): string {
  return input.group ? `c:${callsId}:t:${input.product}:${input.start}` : `c:${callsId}:b:${input.session}`;
}

const TODOS: MeetTodo[] = ["", "create", "patch", "delete", "guests"];
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 600) : []);

export function parseRecord(raw: unknown): MeetRecord | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!isMeetProvider(v.provider) || !isScope(v.scope)) return null;
    const todo = TODOS.includes(v.todo as MeetTodo) ? (v.todo as MeetTodo) : "";
    return {
      provider: v.provider,
      scope: v.scope,
      statsId: text(v.statsId, 64),
      handle: text(v.handle, 64),
      callsId: text(v.callsId, 64),
      product: text(v.product, 64),
      session: text(v.session, 300),
      group: v.group === true,
      id: text(v.id, 1100),
      account: text(v.account, 200),
      link: text(v.link, 600),
      made: v.made === true,
      start: num(v.start),
      end: num(v.end),
      tz: text(v.tz, 64) || "UTC",
      title: text(v.title, 300),
      guests: list(v.guests),
      added: list(v.added),
      todo,
      tries: num(v.tries),
      next: num(v.next),
      error: text(v.error, 300),
      updates: num(v.updates),
      gone: v.gone === true,
      host: typeof v.host === "string" && /^[0-9a-f]{24}$/.test(v.host) ? v.host : "",
      calendar: text(v.calendar, 300),
    };
  } catch {
    return null;
  }
}

/** The records for these scopes, in order; null where there is none. */
export async function readRecords(scopes: string[]): Promise<(MeetRecord | null)[]> {
  if (!scopes.length) return [];
  const unknown = () => new Error("The meeting records could not be confirmed.");
  if (!isRedisConfigured()) throw unknown();
  const replies = await redisPipeline(scopes.map((scope) => ["GET", recordKey(scope)]));
  if (!Array.isArray(replies) || replies.length !== scopes.length) throw unknown();
  const found: (MeetRecord | null)[] = [];
  for (let i = 0; i < scopes.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(replies, String(i));
    if (!slot || !Object.hasOwn(slot, "value")) throw unknown();
    if (slot.value === null) {
      found.push(null);
      continue;
    }
    if (typeof slot.value !== "string") throw unknown();
    try {
      const value = JSON.parse(slot.value) as Record<string, unknown>;
      const record = parseRecord(slot.value);
      if (!record || record.scope !== scopes[i]) throw unknown();
      const strings = ["statsId", "handle", "callsId", "product", "session", "id", "account", "link", "tz", "title", "error"] as const;
      if (strings.some((key) => typeof value[key] !== "string" || value[key] !== record[key])) throw unknown();
      if (["group", "made", "gone"].some((key) => typeof value[key] !== "boolean") || !TODOS.includes(value.todo as MeetTodo)) throw unknown();
      for (const key of ["start", "end", "tries", "next", "updates"] as const) {
        if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) throw unknown();
      }
      for (const key of ["guests", "added"] as const) {
        const entries = value[key];
        if (!Array.isArray(entries) || entries.length !== record[key].length || !entries.every((entry, at) => typeof entry === "string" && entry === record[key][at])) throw unknown();
      }
      // These two fields were added later; absence keeps the original store-owned-calendar default.
      for (const key of ["host", "calendar"] as const) {
        if (Object.hasOwn(value, key) && (typeof value[key] !== "string" || value[key] !== record[key])) throw unknown();
      }
      if (!record.gone && record.link) {
        const room = cleanRoom(record.link);
        if (room === null || room === "bad") throw unknown();
      }
      found.push(record);
    } catch {
      throw unknown();
    }
  }
  return found;
}

export async function readRecord(scope: string): Promise<MeetRecord | null> {
  return (await readRecords([scope]))[0];
}

/** Writes a record, and puts it in the queue when it has something left to do. */
export async function writeRecord(record: MeetRecord): Promise<void> {
  const ttl = Math.max(3600, Math.ceil((record.end + KEEP_AFTER_MS - Date.now()) / 1000));
  await redisPipeline([
    ["SET", recordKey(record.scope), JSON.stringify(record), "EX", ttl],
    record.todo && record.next > 0 ? ["ZADD", MEET_QUEUE, record.next, record.scope] : ["ZREM", MEET_QUEUE, record.scope],
  ]);
}

/** The link the people booked were given, when a record gave one and its meeting was not removed. */
export function givenLink(record: MeetRecord | null): string | null {
  return record && record.link && !record.gone ? record.link : null;
}
