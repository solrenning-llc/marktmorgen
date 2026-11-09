/**
 * Live events inside a store's community: a workshop, a Q&A, a coworking
 * hour, put on the community's calendar by the creator for its members.
 *
 * An event has a title, a few words about it, a start in the creator's time
 * zone, a length, and optionally a cap on how many may come and a list of
 * the community's products whose buyers alone it is for. It happens in one of
 * three places:
 *
 *   - a private video room made for it, by the rules of lib/call-rooms.ts: a
 *     Jitsi Meet address with 24 random letters and digits, made when the
 *     event is, and kept by it whatever happens after;
 *   - the creator's own meeting link — Zoom, Google Meet, anything https;
 *   - or, when the store has connected Google Calendar or Zoom
 *     (lib/meet-connect.ts), a Google Meet or Zoom meeting made on that
 *     account for the event (lib/event-meetings.ts), with the same fallback
 *     a call has: when it cannot be made, the event's own private room.
 *
 * Who sees what is decided on every request, never from anything a page was
 * shown earlier:
 *
 *   - the community's own door first (lib/community-access.ts): a membership
 *     that lapsed, a refund, a member taken out, and the events are gone
 *     with the rest of it;
 *   - then, for an event kept for the buyers of some products, whether this
 *     address holds one of those — asked of the creator's Stripe account and
 *     kept five minutes (one while the answer is no), under a key of its own;
 *   - the way in — the room or the link — is written into a page only from
 *     JOIN_EARLY_MINUTES before the start until the end, only to somebody
 *     let into the event, and, when the event has a cap, only to those who
 *     have a place. Emails, calendar files and the feed never carry it: they
 *     point at the event's page, which asks all of this again.
 *
 * A place is taken with one click (RSVP) and given back with another. A cap
 * holds when many press at once: taking a place writes the member down and
 * reads how many are on the list in the same trip to Redis, and a list
 * longer than the cap takes that member back out. Whoever stays saw a list no
 * longer than the cap after writing themselves down, so however the requests
 * interleave, the list can never settle above the cap. The list is its own
 * count: there is no second number to drift from it.
 *
 * Kept under the community's own id, so nothing here reaches another store:
 *
 *   nl:cm:<id>:ev:<event>            one event (JSON)
 *   nl:cm:<id>:evs                   every event kept, by start (sorted set)
 *   nl:cm:<id>:ev:<event>:r          who is coming: member key -> when (hash)
 *   nl:cm:<id>:ev:<event>:n          (older events only) a count kept beside the list; unused now
 *   nl:cm:<id>:ev:<event>:ok:<addr>  Stripe's answer for an event kept for some products
 *   nl:cm:<id>:evlock:<event>        held while the creator changes the event
 *   nl:cm:evq                        reminders and notices due, by when (sorted set;
 *                                    lib/community-event-mail.ts sends them)
 *
 * At most MAX_UPCOMING_EVENTS are coming up at once; the ones that are over
 * are kept, replays and all, up to MAX_KEPT_EVENTS in all, after which the
 * oldest one that is over makes room for a new one. Every limit is in
 * lib/community-text.ts, where the studio reads it too.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, scanPage } from "@/lib/redis-reply";
import { emailKey } from "@/lib/learn";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import { type MeetProvider, cleanRoom, isMeetProvider, isTimeZone, partsIn, readableTime, zoneName, zonedToUtc } from "@/lib/call-setup";
import { isVideoRoom, newVideoRoom } from "@/lib/call-rooms";
import { type Video, parseVideo, readVideo } from "@/lib/sales-page";
import { fold, icsText, icsTime } from "@/lib/ics-write";
import { holdsAnyOf } from "@/lib/community-access";
import { type CommunityConfig, newItemId } from "@/lib/community";
import { LockBusyError, setIfHeld, withLock } from "@/lib/redis-lock";
import { indexEvent, unindexEvent } from "@/lib/community-index";
import { indexBytes } from "@/lib/community-search";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import {
  EVENT_LENGTHS,
  EVENT_WRITES_PER_HOUR,
  ITEM_ID,
  JOIN_EARLY_MINUTES,
  MAX_EVENT_ABOUT,
  MAX_EVENT_AHEAD_DAYS,
  MAX_EVENT_CAP,
  MAX_EVENT_TITLE,
  MAX_KEPT_EVENTS,
  MAX_LINKS_IN_POST,
  MAX_UPCOMING_EVENTS,
  cleanLine,
  cleanText,
  linkCount,
} from "@/lib/community-text";

export type CommunityEvent = {
  id: string;
  title: string;
  about: string;
  /** When it starts, in milliseconds. */
  start: number;
  minutes: number;
  /** The creator's time zone, the one it was put in and is shown in. */
  tz: string;
  /** The most who may come; 0 for anyone let in. */
  cap: number;
  /**
   * Where it happens: the private room made for it, the creator's own link,
   * or a Google Meet or Zoom meeting made on the store's connected account
   * (lib/event-meetings.ts), which falls back to the private room.
   */
  where: "room" | "link" | "meet";
  /** Which of the two, when `where` is "meet"; null otherwise and for every event saved before. */
  meet: MeetProvider | null;
  /** The private room, made with the event and kept whatever `where` says. */
  room: string;
  /** The creator's own meeting link, when `where` is "link". */
  link: string;
  /** Only the buyers of these of the community's products; empty for every member. */
  only: string[];
  replay: Video | null;
  cancelled: boolean;
  /** The announcement made for it in the feed, if one was. */
  post: string;
  /** When it was made, in seconds. */
  at: number;
  /** How many times it was moved: each move is emailed once, and is the calendar file's sequence. */
  moves: number;
  /** Goes up whenever `only` changes, so no answer about it outlives it. */
  v: number;
};

const base = (id: string) => `nl:cm:${id}`;
const eventKey = (id: string, event: string) => `${base(id)}:ev:${event}`;
const indexKey = (id: string) => `${base(id)}:evs`;
const rsvpKey = (id: string, event: string) => `${base(id)}:ev:${event}:r`;
const countKey = (id: string, event: string) => `${base(id)}:ev:${event}:n`;
const lockKey = (id: string, event: string) => `${base(id)}:evlock:${event}`;
const accessKey = (id: string, event: string, email: string) => `${base(id)}:ev:${event}:ok:${emailKey(email)}`;
const writesKey = (id: string) => `nl:rl:cm:ev:${id}`;
export const EVENT_QUEUE = "nl:cm:evq";

/** The longest an event lasts, for reading the ones that may still be on. */
const LONGEST_MS = Math.max(...EVENT_LENGTHS) * 60_000;
const JOIN_EARLY_MS = JOIN_EARLY_MINUTES * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The moment a page about events is drawn at: one reading, shared by everything on it. */
export function eventClock(): number {
  return Date.now();
}

export function eventEnd(event: Pick<CommunityEvent, "start" | "minutes">): number {
  return event.start + event.minutes * 60_000;
}

/** Whether it is over: past its end. A cancelled event that has not reached its time is not. */
export function isOver(event: CommunityEvent, now = Date.now()): boolean {
  return eventEnd(event) <= now;
}

/** Whether it counts as coming up: not cancelled and not over. */
export function isUpcoming(event: CommunityEvent, now = Date.now()): boolean {
  return !event.cancelled && !isOver(event, now);
}

// ------------------------------------------------------------------ records

/** An event's product list as the code writes it (ids of 1 to 40 characters), or null for anything else. */
function productList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string" && x.length >= 1 && x.length <= 40)) return null;
  return [...new Set(value as string[])].slice(0, 200);
}

function parseEvent(raw: unknown): CommunityEvent | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CommunityEvent>;
    if (typeof v.id !== "string" || !ITEM_ID.test(v.id)) return null;
    if (typeof v.start !== "number" || !Number.isFinite(v.start)) return null;
    const minutes = (EVENT_LENGTHS as readonly number[]).includes(Number(v.minutes)) ? Number(v.minutes) : 60;
    const link = typeof v.link === "string" ? cleanRoom(v.link) : null;
    const room = typeof v.room === "string" && isVideoRoom(v.room) ? v.room : "";
    const ownLink = typeof link === "string" ? link : "";
    // Who may come, read exactly (CX-123 rule 24): no list is an event for every member, as the code writes one; a
    // list in another shape, or holding an id this code never writes, is not "for everyone", so the record is not
    // read at all and nobody is let in on it (mayAttend), rather than every member.
    const only = v.only === undefined ? [] : productList(v.only);
    if (only === null) return null;
    return {
      id: v.id,
      title: cleanLine(v.title, MAX_EVENT_TITLE) || "Live event",
      about: typeof v.about === "string" ? v.about.slice(0, MAX_EVENT_ABOUT) : "",
      start: v.start,
      minutes,
      tz: isTimeZone(v.tz) ? v.tz : "UTC",
      cap: typeof v.cap === "number" && Number.isInteger(v.cap) && v.cap > 0 ? Math.min(v.cap, MAX_EVENT_CAP) : 0,
      // A room that is somehow missing, or a link that no longer reads, is
      // never replaced by a guess: the event then says it has no way in yet.
      where: v.where === "link" ? "link" : v.where === "meet" && isMeetProvider(v.meet) ? "meet" : "room",
      meet: v.where === "meet" && isMeetProvider(v.meet) ? v.meet : null,
      room,
      link: ownLink,
      only,
      replay: parseVideo(v.replay),
      cancelled: v.cancelled === true,
      post: typeof v.post === "string" && ITEM_ID.test(v.post) ? v.post : "",
      at: typeof v.at === "number" ? v.at : 0,
      moves: typeof v.moves === "number" && Number.isInteger(v.moves) && v.moves >= 0 ? v.moves : 0,
      v: typeof v.v === "number" && Number.isInteger(v.v) && v.v > 0 ? v.v : 1,
    };
  } catch {
    return null;
  }
}

export async function readEvent(id: string, event: string): Promise<CommunityEvent | null> {
  if (!ITEM_ID.test(event) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", eventKey(id, event)]]);
  return parseEvent(raw);
}

export async function readEvents(id: string, ids: string[]): Promise<CommunityEvent[]> {
  const wanted = ids.filter((e) => ITEM_ID.test(e));
  if (!wanted.length) return [];
  const rows = await redisPipeline(wanted.map((e) => ["GET", eventKey(id, e)]));
  return rows.map(parseEvent).filter((e): e is CommunityEvent => e !== null);
}

function flatIds(raw: unknown): { ids: string[]; scores: number[] } {
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const ids: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    ids.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  return { ids, scores };
}

/**
 * Every event that may still be on or coming up — cancelled ones too, until
 * their time has passed, so a member who planned on one sees what became of
 * it — soonest first.
 */
export async function upcomingEvents(id: string, now = Date.now()): Promise<CommunityEvent[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", indexKey(id), now - LONGEST_MS, "+inf", "WITHSCORES", "LIMIT", 0, MAX_KEPT_EVENTS]]);
  const { ids } = flatIds(raw);
  const events = await readEvents(id, ids);
  return events.filter((e) => !isOver(e, now)).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * Every event a community holds, soonest first, for the one-time walk that
 * puts what already exists into the search index (lib/community-index.ts).
 * Bounded by what a community keeps, which is what the index holds anyway.
 */
export async function allEvents(id: string): Promise<CommunityEvent[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", indexKey(id), "-inf", "+inf", "WITHSCORES", "LIMIT", 0, MAX_KEPT_EVENTS]]);
  const { ids } = flatIds(raw);
  return readEvents(id, ids);
}

export type PastPage = { events: CommunityEvent[]; next: number | null };

/**
 * One page of the events that are over, the most recent first. `before` is
 * the start of the last one on the page before.
 */
export async function pastEvents(id: string, before: number | null, page: number, now = Date.now()): Promise<PastPage> {
  if (!isRedisConfigured()) return { events: [], next: null };
  const max = before === null ? String(now) : `(${before}`;
  // A few more than a page: an event that started but is still on is read
  // here too, and left out.
  const [raw] = await redisPipeline([["ZREVRANGEBYSCORE", indexKey(id), max, "-inf", "WITHSCORES", "LIMIT", 0, page + MAX_UPCOMING_EVENTS + 1]]);
  const { ids } = flatIds(raw);
  const events = (await readEvents(id, ids)).filter((e) => isOver(e, now)).sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
  const shown = events.slice(0, page);
  return { events: shown, next: events.length > page ? shown[shown.length - 1].start : null };
}

/** How many events are coming up now, cancelled ones not counted. */
export async function upcomingCount(id: string, now = Date.now()): Promise<number> {
  return (await upcomingEvents(id, now)).filter((e) => !e.cancelled).length;
}

// ------------------------------------------------------------------ what the creator sends

export type EventInput = {
  title: string;
  about: string;
  start: number;
  minutes: number;
  tz: string;
  cap: number;
  where: "room" | "link" | "meet";
  link: string;
  meet: MeetProvider | null;
  only: string[];
};

export type InputProblem =
  | "title"
  | "about_links"
  | "when"
  | "no_such_time"
  | "past"
  | "too_far"
  | "length"
  | "cap"
  | "link"
  | "meet"
  | "only";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

/**
 * What the studio sent, checked and cleaned: a date and a time on the clock
 * of the time zone chosen, read as that zone's clock shows them — so an event
 * put at 6 PM in New York is at 6 PM there, summer or winter.
 */
export function readEventInput(
  body: Record<string, unknown>,
  config: CommunityConfig,
  now = Date.now(),
  /** The event being edited: its own start is accepted as it is, even once it has begun. */
  current?: Pick<CommunityEvent, "start" | "minutes"> | null,
): EventInput | InputProblem {
  const title = cleanLine(body.title, MAX_EVENT_TITLE);
  if (!title) return "title";
  const about = cleanText(body.about, MAX_EVENT_ABOUT);
  if (linkCount(`${title}\n${about}`) > MAX_LINKS_IN_POST) return "about_links";
  const tz = typeof body.tz === "string" && isTimeZone(body.tz) ? body.tz : "";
  const date = DATE.exec(typeof body.date === "string" ? body.date : "");
  const time = TIME.exec(typeof body.time === "string" ? body.time : "");
  if (!tz || !date || !time) return "when";
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59) return "when";
  const start = zonedToUtc(Number(date[1]), Number(date[2]), Number(date[3]), hour * 60 + minute, tz);
  if (start === null) return "no_such_time";
  const minutes = Number(body.minutes);
  if (!(EVENT_LENGTHS as readonly number[]).includes(minutes)) return "length";
  const unmoved = Boolean(current && current.start === start && current.minutes === minutes);
  if (!unmoved && start <= now) return "past";
  if (start > now + MAX_EVENT_AHEAD_DAYS * DAY) return "too_far";
  const capText = typeof body.cap === "string" ? body.cap.trim() : typeof body.cap === "number" ? String(body.cap) : "";
  let cap = 0;
  if (capText && capText !== "0") {
    if (!/^\d{1,6}$/.test(capText)) return "cap";
    cap = Number(capText);
    if (cap < 1 || cap > MAX_EVENT_CAP) return "cap";
  }
  const where = body.where === "link" ? "link" : body.where === "meet" ? "meet" : "room";
  let link = "";
  if (where === "link") {
    const cleaned = cleanRoom(body.link);
    if (typeof cleaned !== "string" || cleaned === "bad") return "link";
    link = cleaned;
  }
  // Which account is connected and working is the route's to ask
  // (lib/meet-connect.ts); here only that one of the two was named.
  const meet = where === "meet" ? (isMeetProvider(body.meet) ? body.meet : null) : null;
  if (where === "meet" && !meet) return "meet";
  const asked = Array.isArray(body.only) ? body.only.filter((x): x is string => typeof x === "string") : [];
  const only = [...new Set(asked)];
  // Only a narrower door than the community's own: a product that does not
  // open the community cannot open one of its events.
  if (only.some((p) => !config.access.includes(p))) return "only";
  return { title, about, start, minutes, tz, cap, where, link, meet, only };
}

/**
 * Counts one more change by the creator, and says whether it is allowed.
 * The count is read only in its exact shape (CX-123 rule 24): a reply that
 * is missing, cut short or of another shape throws UnknownReplyError, so
 * nothing is changed and the studio says something went wrong (the route's
 * "server_error"), never that there were too many changes.
 */
export async function withinEventWrites(id: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([
    ["SET", writesKey(id), "0", "EX", 3_600, "NX"],
    ["INCR", writesKey(id)],
  ]), 2);
  const count = replies && (replies[0] === "OK" || replies[0] === null) ? countOf(replies[1]) : null;
  if (count === null || count < 1) throw new UnknownReplyError("a count of changes to live events");
  return count <= EVENT_WRITES_PER_HOUR;
}

/** Where the reminders for an event stand in the queue: one entry per moment, for this start. */
function queueEntries(community: string, handle: string, event: CommunityEvent, now: number): (string | number)[] {
  const out: (string | number)[] = [];
  const plan = (mark: "24" | "1" | "p", at: number) => {
    if (at > now) out.push(at, `${community}|${handle}|${event.id}|${mark}|${event.start}`);
  };
  plan("24", event.start - DAY);
  plan("1", event.start - HOUR);
  plan("p", event.start - JOIN_EARLY_MS);
  return out;
}

export type CreateResult = { ok: true; event: CommunityEvent } | { ok: false; reason: "full" };

/**
 * The slot an event and everyone coming to it is counted in, in the store's
 * data room (lib/store-data.ts): its record, its place in the calendar, its
 * three reminders in the queue, the words it is found by, and each place
 * taken (RSVP_BYTES).
 */
const EVENT_SLOT = (event: string) => `cm:e:${event}`;
export const RSVP_BYTES = 96;
function eventBytes(event: CommunityEvent): number {
  return dataBytes([JSON.stringify(event)], 5) + indexBytes([event.title, event.about]);
}

/**
 * Puts a new event on the calendar, with its room, and plans its reminders.
 * Refused past MAX_UPCOMING_EVENTS coming up; past MAX_KEPT_EVENTS kept, the
 * oldest that is over is let go to make room.
 */
export async function createEvent(store: Store, input: EventInput, now = Date.now()): Promise<CreateResult> {
  const id = store.community?.id as string;
  if ((await upcomingCount(id, now)) >= MAX_UPCOMING_EVENTS) return { ok: false, reason: "full" };
  const [kept] = await redisPipeline([["ZCARD", indexKey(id)]]);
  if (Number(kept) >= MAX_KEPT_EVENTS) {
    const [raw] = await redisPipeline([["ZRANGEBYSCORE", indexKey(id), "-inf", now - LONGEST_MS, "LIMIT", 0, Number(kept) - MAX_KEPT_EVENTS + 1]]);
    const oldest = (Array.isArray(raw) ? (raw as string[]) : []).filter((e) => ITEM_ID.test(e));
    if (!oldest.length) return { ok: false, reason: "full" };
    for (const gone of await readEvents(id, oldest)) await forgetEvent(id, gone, store);
  }
  const event: CommunityEvent = {
    id: newItemId(),
    ...input,
    link: input.where === "link" ? input.link : "",
    meet: input.where === "meet" ? input.meet : null,
    room: newVideoRoom(),
    replay: null,
    cancelled: false,
    post: "",
    at: Math.floor(now / 1000),
    moves: 0,
    v: 1,
  };
  const entries = queueEntries(id, store.handle, event, now);
  // Its room first (DataRoomError when it does not fit): nothing is written without it.
  await needData(store, [{ slot: EVENT_SLOT(event.id), bytes: eventBytes(event), set: true }]);
  await redisPipeline([
    ["SET", eventKey(id, event.id), JSON.stringify(event)],
    ["ZADD", indexKey(id), event.start, event.id],
    ...(entries.length ? [["ZADD", EVENT_QUEUE, ...entries]] : []),
  ]);
  // Findable from the search box as soon as it exists. Never allowed to stop
  // an event being made.
  await indexEvent(id, event).catch(() => {});
  return { ok: true, event };
}

export type ChangeResult =
  | { ok: true; event: CommunityEvent; before: CommunityEvent; moved: boolean }
  | { ok: false; reason: "gone" | "busy" | "cancelled" | "started" | "over" | "early" };

/**
 * Changes an event, under its lock, so two tabs of the studio saving at once
 * never write back each other's old copy. `change` gets the event as it is
 * now and answers the next one, or a reason to refuse.
 */
async function changeEvent(
  store: Store,
  eventId: string,
  change: (event: CommunityEvent) => CommunityEvent | "cancelled" | "started" | "over" | "early",
  now = Date.now(),
): Promise<ChangeResult> {
  const id = store.community?.id as string;
  try {
    return await withLock(lockKey(id, eventId), 20, 5_000, async (held) => {
      const before = await readEvent(id, eventId);
      if (!before) return { ok: false as const, reason: "gone" as const };
      const next = change(before);
      if (typeof next === "string") return { ok: false as const, reason: next };
      const moved = next.start !== before.start || next.minutes !== before.minutes;
      const event = moved ? { ...next, moves: before.moves + 1 } : next;
      // What it grows by takes room first; what it shrinks by is given back after.
      const grown = eventBytes(event) - eventBytes(before);
      if (grown > 0) await needData(store, [{ slot: EVENT_SLOT(eventId), bytes: grown }]);
      if (!(await setIfHeld(held, eventKey(id, eventId), JSON.stringify(event)))) {
        if (grown > 0) await giveData(store, [{ slot: EVENT_SLOT(eventId), bytes: grown }]);
        return { ok: false as const, reason: "busy" as const };
      }
      if (grown < 0) await giveData(store, [{ slot: EVENT_SLOT(eventId), bytes: -grown }]);
      if (moved) {
        const entries = queueEntries(id, store.handle, event, now);
        await redisPipeline([
          ["ZADD", indexKey(id), event.start, event.id],
          ...(entries.length ? [["ZADD", EVENT_QUEUE, ...entries]] : []),
        ]);
      }
      // Its title and its description can change without it moving an inch,
      // so the index is rewritten on every change rather than only on a move.
      await indexEvent(id, event).catch(() => {});
      return { ok: true as const, event, before, moved };
    });
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    throw error;
  }
}

/**
 * The creator's edit: everything, the time included. An event that has
 * started can still be renamed and described, and have its link or cap
 * changed, but not be moved.
 */
export async function editEvent(store: Store, eventId: string, input: EventInput, now = Date.now()): Promise<ChangeResult> {
  return changeEvent(store, eventId, (event) => {
    if (event.cancelled) return "cancelled";
    if (isOver(event, now)) return "over";
    const moving = input.start !== event.start || input.minutes !== event.minutes;
    if (moving && event.start <= now) return "started";
    const narrowed = input.only.length !== event.only.length || input.only.some((p) => !event.only.includes(p));
    return {
      ...event,
      title: input.title,
      about: input.about,
      start: moving ? input.start : event.start,
      minutes: moving ? input.minutes : event.minutes,
      tz: input.tz,
      cap: input.cap,
      where: input.where,
      link: input.where === "link" ? input.link : event.link,
      meet: input.where === "meet" ? input.meet : null,
      only: input.only,
      v: narrowed ? event.v + 1 : event.v,
    };
  }, now);
}

/** Calls it off. Kept, labelled cancelled, and emailed once to everyone coming. */
export async function cancelEvent(store: Store, eventId: string, now = Date.now()): Promise<ChangeResult> {
  return changeEvent(store, eventId, (event) => {
    if (event.cancelled) return "cancelled";
    if (isOver(event, now)) return "over";
    return { ...event, cancelled: true };
  }, now);
}

/** The recording, after it is over: a YouTube, Vimeo or Loom address, or none. */
export async function setReplay(store: Store, eventId: string, replay: Video | null, now = Date.now()): Promise<ChangeResult> {
  return changeEvent(store, eventId, (event) => {
    if (event.cancelled) return "cancelled";
    if (event.start > now) return "early";
    return { ...event, replay };
  }, now);
}

/** Notes the feed post that announced it. */
export async function setEventPost(store: Store, eventId: string, post: string): Promise<void> {
  await changeEvent(store, eventId, (event) => ({ ...event, post }));
}

/** Reads a replay address; null when it is not one of the three players. */
export function readReplay(raw: unknown): Video | null {
  return typeof raw === "string" ? readVideo(raw) : null;
}

async function forgetEvent(id: string, event: CommunityEvent, room: DataStore): Promise<void> {
  await redisPipeline([
    ["DEL", eventKey(id, event.id), rsvpKey(id, event.id), countKey(id, event.id)],
    ["ZREM", indexKey(id), event.id],
  ]);
  await unindexEvent(id, event.id).catch(() => {});
  await giveData(room, [{ slot: EVENT_SLOT(event.id), bytes: 0, set: true }]);
}

/** Takes an event away for good: only one that is cancelled or over, so nobody coming is left without word. */
export async function deleteEvent(store: Store, eventId: string, now = Date.now()): Promise<"deleted" | "gone" | "upcoming"> {
  const id = store.community?.id as string;
  const event = await readEvent(id, eventId);
  if (!event) return "gone";
  if (!event.cancelled && !isOver(event, now)) return "upcoming";
  await forgetEvent(id, event, store);
  return "deleted";
}

// ------------------------------------------------------------------ who may come

/**
 * Whether somebody the community let in may come to this event: the creator
 * always; a member when the event is for everyone, or when their address
 * holds one of its products — among those that still open the community.
 */
export async function mayAttend(
  store: Store,
  config: CommunityConfig,
  event: CommunityEvent,
  viewer: { owner: boolean; email: string },
): Promise<boolean> {
  if (viewer.owner) return true;
  if (!event.only.length) return true;
  const ids = event.only.filter((p) => config.access.includes(p));
  if (!ids.length) return false;
  const id = store.community?.id as string;
  return holdsAnyOf(store, ids, viewer.email, accessKey(id, event.id, viewer.email), `${config.v}.${event.v}`);
}

export type JoinWindow = {
  /** The way in is showing now. */
  open: boolean;
  opensAt: number;
  closesAt: number;
};

/** When the way in shows: JOIN_EARLY_MINUTES before the start, until the end. Never for a cancelled event. */
export function joinWindow(event: CommunityEvent, now = Date.now()): JoinWindow {
  const opensAt = event.start - JOIN_EARLY_MS;
  const closesAt = eventEnd(event);
  return { open: !event.cancelled && now >= opensAt && now < closesAt, opensAt, closesAt };
}

/**
 * Where to join, as it is written into the page: the room, or the creator's
 * link, or none. For a Google Meet or Zoom event, `meeting` is the link its
 * record says was given (lib/event-meetings.ts) — the meeting's own, or the
 * private room when it could not be made — and the room when there is none.
 */
export function wayIn(event: CommunityEvent, meeting: string | null = null): string | null {
  if (event.where === "link") return event.link || null;
  if (event.where === "meet") return meeting || event.room || null;
  return event.room || null;
}

/**
 * The way in, for this viewer, now, or null: only while the door is open,
 * only to somebody who may come, and for an event with a cap only to those
 * who took a place. The creator sees it whenever the event is not over, to
 * open the room first.
 */
export function wayInFor(
  event: CommunityEvent,
  who: { owner: boolean; mayAttend: boolean; going: boolean },
  now = Date.now(),
  meeting: string | null = null,
): string | null {
  if (event.cancelled || isOver(event, now)) return null;
  if (who.owner) return wayIn(event, meeting);
  if (!who.mayAttend || !joinWindow(event, now).open) return null;
  if (event.cap > 0 && !who.going) return null;
  return wayIn(event, meeting);
}

// ------------------------------------------------------------------ places

export type RsvpResult = "added" | "already" | "full" | "closed";

/**
 * Takes a place for a member. The member is written down and the list's
 * length read in the same trip; a list longer than the cap takes them back
 * out. Two people pressing for the last place at once: both are written, at
 * least one of them reads a list one too long and is taken out again, and
 * the list never stays above the cap. Nothing is counted apart from the list
 * itself, so a request that dies halfway cannot leave a count that says
 * "full" when it is not.
 */
export async function rsvp(id: string, event: CommunityEvent, member: string, room: DataStore, now = Date.now()): Promise<RsvpResult> {
  if (event.cancelled || isOver(event, now)) return "closed";
  const [already] = await redisPipeline([["HEXISTS", rsvpKey(id, event.id), member]]);
  if (Number(already) === 1) return "already";
  // A place takes room first (DataRoomError when it does not fit), and gives it back when it is not kept.
  await needData(room, [{ slot: EVENT_SLOT(event.id), bytes: RSVP_BYTES }], now);
  const [added, length] = await redisPipeline([
    ["HSETNX", rsvpKey(id, event.id), member, String(Math.floor(now / 1000))],
    ["HLEN", rsvpKey(id, event.id)],
  ]);
  if (Number(added) !== 1) {
    await giveData(room, [{ slot: EVENT_SLOT(event.id), bytes: RSVP_BYTES }], now);
    return "already";
  }
  if (event.cap > 0 && Number(length) > event.cap) {
    const [removed] = await redisPipeline([["HDEL", rsvpKey(id, event.id), member]]);
    // Given back only when this took the place away: a deletion of the member in between gave it back already.
    if (Number(removed) === 1) await giveData(room, [{ slot: EVENT_SLOT(event.id), bytes: RSVP_BYTES }], now);
    return "full";
  }
  return "added";
}

/** Gives a place back. Safe to press twice. */
export async function cancelRsvp(id: string, event: CommunityEvent, member: string, room: DataStore): Promise<boolean> {
  const [removed] = await redisPipeline([["HDEL", rsvpKey(id, event.id), member]]);
  if (Number(removed) === 1) await giveData(room, [{ slot: EVENT_SLOT(event.id), bytes: RSVP_BYTES }]);
  return Number(removed) === 1;
}

/** How many are coming to each event, and whether this member is. */
export async function rsvpNumbers(id: string, events: CommunityEvent[], member: string | null): Promise<Map<string, { going: number; mine: boolean }>> {
  const out = new Map<string, { going: number; mine: boolean }>();
  if (!events.length) return out;
  const rows = await redisPipeline(events.flatMap((e) => [["HLEN", rsvpKey(id, e.id)], ["HEXISTS", rsvpKey(id, e.id), member ?? "-"]]));
  events.forEach((e, i) => {
    out.set(e.id, { going: Number(rows[i * 2]) || 0, mine: Number(rows[i * 2 + 1]) === 1 });
  });
  return out;
}

/** The most pages of who is coming one read takes (a thousand asked for a page). */
const RSVP_PAGES = 200;

/**
 * Everyone coming, as member keys with when they said so (seconds), a page of Redis's at a time.
 *
 * Everyone or not at all (rules 24 and 30, review of #2921): a page that does not read, or a walk not at its end
 * after RSVP_PAGES before `limit` is reached, throws UnknownReplyError, never fewer people coming. A reminder, move
 * or cancellation is then not sent to a short list as if it were everyone (lib/community-event-mail.ts, startJob).
 */
export async function rsvpList(id: string, eventId: string, limit = 100_000): Promise<{ key: string; at: number }[]> {
  const out: { key: string; at: number }[] = [];
  let cursor = "0";
  for (let page = 0; ; page += 1) {
    if (page === RSVP_PAGES) throw new UnknownReplyError(`an event's HSCAN, not at its end after ${RSVP_PAGES} pages,`);
    const read = scanPage(await redisPipeline([["HSCAN", rsvpKey(id, eventId), cursor, "COUNT", 1000]]));
    // A hash answers field and value: an odd page is not one.
    if (!read || read.items.length % 2 !== 0) throw new UnknownReplyError("an event's HSCAN");
    const flat = read.items;
    for (let i = 0; i + 1 < flat.length; i += 2) out.push({ key: flat[i], at: Number(flat[i + 1]) || 0 });
    cursor = read.next;
    if (cursor === "0" || out.length >= limit) break;
  }
  return out.slice(0, limit).sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** Which of these members are still coming, asked when an email to them goes out. */
export async function stillGoing(id: string, eventId: string, members: string[]): Promise<Set<string>> {
  if (!members.length) return new Set();
  const [raw] = await redisPipeline([["HMGET", rsvpKey(id, eventId), ...members]]);
  const rows = Array.isArray(raw) ? raw : [];
  return new Set(members.filter((_, i) => rows[i] !== null && rows[i] !== undefined));
}

// ------------------------------------------------------------------ words and files

/** Where an event is read, on the address that always works. */
export function eventAddress(store: Pick<Store, "handle">, eventId: string): string {
  return `${SITE_URL}/@${store.handle}/community/events/${eventId}`;
}

/** "Tuesday, October 6, 6:00 PM (EDT)" in the event's own time zone. */
export function eventTime(event: Pick<CommunityEvent, "start" | "tz">): string {
  return `${readableTime(event.start, event.tz)} (${zoneName(event.start, event.tz)})`;
}

/** "Tuesday, October 6 at 3:00 PM (EDT)", in the event's zone and the store's language. */
export function eventTimeIn(store: Pick<Store, "language">, event: Pick<CommunityEvent, "start" | "tz">): string {
  const locale = LANGUAGES[store.language].locale;
  return `${readableTime(event.start, event.tz, locale)} (${zoneName(event.start, event.tz, locale)})`;
}

/** Its length, as people say it: "45 minutes", "1 hour", "1 h 30 min", in the store's language. */
export function lengthIn(store: Pick<Store, "language">, minutes: number): string {
  const w = communityWords(store.language);
  if (minutes < 60) return w.lengthMinutes(minutes);
  if (minutes % 60 === 0) return w.lengthHours(minutes / 60);
  return w.lengthHoursMinutes(Math.floor(minutes / 60), minutes % 60);
}

/** The date and time fields the studio's form starts from, for an event. */
export function eventFields(event: Pick<CommunityEvent, "start" | "tz">): { date: string; time: string } {
  const p = partsIn(event.start, event.tz);
  const two = (n: number) => String(n).padStart(2, "0");
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${two(p.hour)}:${two(p.minute)}` };
}

/** "Starts in 3 days", "Starts in 40 minutes", "On now", "Ended". */
export function eventWhenWords(event: CommunityEvent, now = Date.now()): string {
  if (event.cancelled) return "Canceled";
  if (isOver(event, now)) return "Ended";
  if (event.start <= now) return "On now";
  const ms = event.start - now;
  if (ms < HOUR) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `Starts in ${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `Starts in ${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.round(ms / DAY);
  return `Starts in ${d} ${d === 1 ? "day" : "days"}`;
}

/** Its length, as people say it: "45 minutes", "1 hour", "1 h 30 min". */
export function lengthWords(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The calendar file for an event: the page to join from, never the room —
 * the page asks who is opening it, a calendar cannot. Same UID for every
 * version, and a sequence that goes up with each move, so a calendar that
 * imports it again moves the event rather than adding a second one.
 */
export function eventIcs(store: Pick<Store, "handle" | "name">, event: CommunityEvent, communityName: string): string {
  const page = eventAddress(store, event.id);
  const description = [
    event.about,
    "",
    `Join from the event page: ${page}`,
    `The way in shows there ${JOIN_EARLY_MINUTES} minutes before the start.`,
  ].join("\n").trim();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Marktmorgen//Community events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${createHash("sha256").update(`event|${event.id}`).digest("hex").slice(0, 32)}@marktmorgen.com`,
    `DTSTAMP:${icsTime(Date.now())}`,
    `SEQUENCE:${event.moves + (event.cancelled ? 1 : 0)}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(eventEnd(event))}`,
    `SUMMARY:${icsText(`${event.title} (${communityName})`)}`,
    `DESCRIPTION:${icsText(description)}`,
    `LOCATION:${icsText(page)}`,
    `URL:${page}`,
    `STATUS:${event.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    ...(event.cancelled
      ? []
      : ["BEGIN:VALARM", "TRIGGER:-PT15M", "ACTION:DISPLAY", `DESCRIPTION:${icsText(`${event.title} in 15 minutes`)}`, "END:VALARM"]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** The words for the feed post that announces an event, with the link to it. */
export function announcementText(store: Pick<Store, "handle">, event: CommunityEvent): { title: string; text: string } {
  const about = event.about.length > 600 ? `${event.about.slice(0, 600).replace(/\s+\S*$/, "")}…` : event.about;
  return {
    title: cleanLine(`Live: ${event.title}`, 120),
    text: [
      `${eventTime(event)}, ${lengthWords(event.minutes)}.`,
      about,
      `RSVP, add it to your calendar and join here: ${eventAddress(store, event.id)}`,
    ].filter(Boolean).join("\n\n"),
  };
}

/**
 * Takes one member off every live event of the community they said they
 * were coming to, and forgets each event's answer about whether they may
 * come in (lib/community-erasure.ts).
 */
export async function forgetRsvpsPerson(id: string, who: string, email: string, room?: DataStore): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", indexKey(id), "-inf", "+inf"]]);
  const events = (Array.isArray(raw) ? raw : []).map(String).slice(0, MAX_KEPT_EVENTS);
  if (!events.length) return 0;
  const replies = await redisPipeline([...events.map((e) => ["HDEL", rsvpKey(id, e), who]), ["DEL", ...events.map((e) => accessKey(id, e, email))]]);
  // Each place's room comes back only where this deletion removed it, as cancelRsvp gives it.
  const gone = events.filter((_, i) => Number(replies[i]) === 1);
  if (room && gone.length) await giveData(room, gone.map((e) => ({ slot: EVENT_SLOT(e), bytes: RSVP_BYTES })));
  return gone.length;
}

/** The live events one member said they are coming to, and when they said it, for the copy of their data (619 [SZ3]). Only reads. */
export async function rsvpsOf(id: string, who: string): Promise<{ event: string; at: number }[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", indexKey(id), "-inf", "+inf"]]);
  const events = (Array.isArray(raw) ? raw : []).map(String).slice(0, MAX_KEPT_EVENTS);
  if (!events.length) return [];
  const replies = await redisPipeline(events.map((e) => ["HGET", rsvpKey(id, e), who]));
  return events.flatMap((event, i) => (replies[i] === null || replies[i] === undefined ? [] : [{ event, at: Number(replies[i]) || 0 }]));
}

/** How many live events the community keeps: what deleting a member goes through (lib/community-erasure.ts), and what the walk of its archive reads (lib/community-walk.ts). */
export async function eventCount(id: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["ZCARD", indexKey(id)]]);
  return Math.min(Number(n) || 0, MAX_KEPT_EVENTS);
}
