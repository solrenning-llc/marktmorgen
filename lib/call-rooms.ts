/**
 * A private video room for each booking, with nothing to set up.
 *
 * A creator selling calls either types the meeting link they already use —
 * Zoom, Google Meet, whatever — or asks for a room to be made for every
 * booking. The room is a Jitsi Meet address (https://meet.jit.si/<name>)
 * whose name is 24 random letters and digits, 120 bits drawn from the
 * system's secure random source, so nobody finds it by guessing. Jitsi Meet
 * is a free service run by a third party (8x8), with no account to open and
 * no key for us to hold: a room exists the moment somebody opens its
 * address.
 *
 * One thing about it has to be said wherever it is offered: since August
 * 2023 meet.jit.si asks the first person who opens a room to sign in (with a
 * Google, GitHub or Facebook account, the ones it accepts today) before the
 * meeting starts, and that person becomes its moderator; the others wait
 * until then and need no account. The studio says so, and so does every
 * email that carries a room.
 *
 * Which room a booking has:
 *
 *   - a one-to-one call: one room per booking, filed under its checkout
 *     session, so a booking its buyer moves keeps its room;
 *   - a group call or a dated live session: one room per time, shared by
 *     everyone booked into it — a group has to meet in the same place — so a
 *     booking moved to another time joins the room of that time.
 *
 * A room is made the first time anything asks for it — the booking email,
 * usually — with SET NX, so two buyers of the same group time at the same
 * instant still get the same room. Once made it stays the booking's room even
 * if the creator later switches back to their own link; a booking made
 * before rooms were switched on keeps the link it was given.
 *
 * A call made on Google Meet or Zoom (lib/meet-links.ts) is read here too,
 * first: the link its record says the booking was given wins over anything
 * else, so every page, email and calendar file shows the same one. Until a
 * record exists — a page drawn in the second before the booking is
 * confirmed — such a call shows what it would fall back to: the creator's
 * own link, or a room made here when they have none.
 */
import { whereOf } from "@/lib/call-place";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, listSlots, repliesFor } from "@/lib/redis-reply";
import { type CallSetup, isGroup, roomFor } from "@/lib/call-setup";
import { callScope, givenLink, parseRecord, recordKey } from "@/lib/meet-records";
import { bookingWords } from "@/lib/buyer-words/booking";

export const VIDEO_ROOM_BASE = "https://meet.jit.si/";

/** 32 letters and digits: 256 divides by 32, so each is exactly as likely. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const ROOM_NAME_LENGTH = 24;
const ROOM_PATTERN = /^https:\/\/meet\.jit\.si\/[a-z0-9]{24}$/;

/** How long a room is remembered after its call: long enough for a late look at an old email. */
const KEEP_AFTER_MS = 60 * 86_400_000;

/** A new room address nobody else has. */
export function newVideoRoom(): string {
  const bytes = new Uint8Array(ROOM_NAME_LENGTH);
  crypto.getRandomValues(bytes);
  return VIDEO_ROOM_BASE + [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Whether an address is one of the rooms made here. */
export function isVideoRoom(url: string | null | undefined): boolean {
  return typeof url === "string" && ROOM_PATTERN.test(url);
}

const bookingKey = (callsId: string, session: string) => `nl:call:room:${callsId}:b:${session}`;
const timeKey = (callsId: string, product: string, start: number) => `nl:call:room:${callsId}:t:${product}:${start}`;

/**
 * Room keys read at one MGET at the most: a booking's four (its own room, its
 * time's, and its meeting record under both names), so ROOM_KEYS_PER_MGET / 4
 * bookings a command, every MGET of a reading in one trip (calendar-feed room,
 * 10 November 2026). Upstash bills an MGET as one command whatever its keys;
 * the bytes it moves are priced where the reading is (lib/read-ceilings.ts).
 */
export const ROOM_KEYS_PER_MGET = 100;
/** Keys roomsFor reads for each booking asked about. */
export const ROOM_KEYS_PER_BOOKING = 4;
/** The MGETs roomsFor's reads take for this many bookings; a count that is not a number is never priced low. */
export function roomReads(bookings: number): number {
  if (Number.isNaN(bookings) || bookings === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return bookings > 0 ? Math.ceil((bookings * ROOM_KEYS_PER_BOOKING) / ROOM_KEYS_PER_MGET) : 0;
}

/** One booked seat, as much of it as picks its room. */
export type RoomAsk = {
  product: string;
  setup: CallSetup;
  /** The checkout session that paid for it. */
  session: string;
  start: number;
  end: number;
};

/**
 * What a call made on Google Meet or Zoom falls back to when the meeting
 * cannot be made: the creator's own link when they gave one, else a private
 * room made here. Any other setup is itself.
 */
export function fallbackSetup(setup: CallSetup, start: number): CallSetup {
  if (!setup.meet) return setup;
  return { ...setup, meet: null, video: !roomFor(setup, start) };
}

/**
 * The room of each booking asked about, in order: the link a Google Meet or
 * Zoom meeting gave it, else a room already made for it (or for its time, in
 * a group), else a new one when its product makes rooms, else the creator's
 * own link. Two round trips at most, however many.
 */
export async function roomsFor(callsId: string | null, asks: RoomAsk[]): Promise<(string | null)[]> {
  // In person (lib/call-place.ts): no room, not even one kept from when it was online; the others are asked as before.
  if (asks.some((a) => whereOf(a.setup).kind === "place")) {
    const online = asks.map((a, i) => ({ a, i })).filter(({ a }) => whereOf(a.setup).kind !== "place");
    const found = await roomsFor(callsId, online.map(({ a }) => a));
    const out: (string | null)[] = asks.map(() => null);
    online.forEach(({ i }, k) => {
      out[i] = found[k];
    });
    return out;
  }
  if (!callsId || !isRedisConfigured() || asks.length === 0) return asks.map((a) => roomFor(a.setup, a.start));
  const keys = asks.flatMap((a) => [
    bookingKey(callsId, a.session),
    timeKey(callsId, a.product, a.start),
    // Asked for every booking, not only those of a product set to make
    // meetings now, and under both of its possible names, since a call can
    // go from one seat to several: a booking keeps the link it was given.
    recordKey(callScope(callsId, { group: false, session: a.session, product: a.product, start: a.start })),
    recordKey(callScope(callsId, { group: true, session: a.session, product: a.product, start: a.start })),
  ]);
  // ROOM_KEYS_PER_MGET keys at one MGET, every MGET in one trip: a command for each twenty-five bookings, not four a
  // booking. Read only whole (rule 24): one reply per MGET, one value per key, each text or nothing; anything else is
  // unknown and throws, never a booking taken to have no room (and one made in its place).
  const lots: string[][] = [];
  for (let i = 0; i < keys.length; i += ROOM_KEYS_PER_MGET) lots.push(keys.slice(i, i + ROOM_KEYS_PER_MGET));
  const replies = repliesFor(await redisPipeline(lots.map((lot) => ["MGET", ...lot])), lots.length);
  if (!replies) throw new UnknownReplyError("the bookings' rooms");
  const read: (string | null)[] = [];
  lots.forEach((lot, l) => {
    const values = listSlots(replies[l]);
    if (!values || values.length !== lot.length || !values.every((v) => v === null || typeof v === "string")) throw new UnknownReplyError("the bookings' rooms");
    read.push(...(values as (string | null)[]));
  });
  const found: (string | null)[] = asks.map((_, i) => {
    const own = read[i * ROOM_KEYS_PER_BOOKING];
    const shared = read[i * ROOM_KEYS_PER_BOOKING + 1];
    const meeting = givenLink(parseRecord(read[i * ROOM_KEYS_PER_BOOKING + 2])) ?? givenLink(parseRecord(read[i * ROOM_KEYS_PER_BOOKING + 3]));
    if (meeting) return meeting;
    if (isVideoRoom(own)) return own;
    if (isVideoRoom(shared)) return shared;
    return null;
  });
  // A call made on Google Meet or Zoom that has no record yet is shown what it falls back to.
  asks = asks.map((a) => (a.setup.meet ? { ...a, setup: fallbackSetup(a.setup, a.start) } : a));
  // Rooms still to make, one per key, so a group asked about twice gets one.
  const making = new Map<string, { at: number[]; ttl: number }>();
  asks.forEach((a, i) => {
    if (found[i] || !a.setup.video) return;
    const key = isGroup(a.setup) ? timeKey(callsId, a.product, a.start) : bookingKey(callsId, a.session);
    const ttl = Math.max(3600, Math.ceil((a.end + KEEP_AFTER_MS - Date.now()) / 1000));
    const entry = making.get(key) ?? { at: [], ttl };
    entry.at.push(i);
    making.set(key, entry);
  });
  if (making.size) {
    const keys = [...making.keys()];
    const made = await redisPipeline(
      keys.flatMap((key) => [
        ["SET", key, newVideoRoom(), "NX", "EX", making.get(key)!.ttl],
        // Whoever won the race, this is the room.
        ["GET", key],
      ]),
    );
    keys.forEach((key, k) => {
      const room = made[k * 2 + 1];
      for (const i of making.get(key)!.at) found[i] = isVideoRoom(room as string) ? (room as string) : null;
    });
  }
  return asks.map((a, i) => found[i] ?? roomFor(a.setup, a.start));
}

/** Which service a room is on, as far as its address says. */
export function roomKind(room: string | null): "room" | "meet" | "zoom" | "other" {
  if (!room) return "other";
  if (isVideoRoom(room)) return "room";
  try {
    const host = new URL(room).hostname;
    if (host === "meet.google.com") return "meet";
    if (host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoom.com" || host.endsWith(".zoom.com")) return "zoom";
  } catch {
    // Not a web address.
  }
  return "other";
}

/**
 * What a button that opens a room says: where it goes, when that is known.
 * In English unless given the store's language (lib/buyer-words/booking.ts).
 */
export function roomLabel(room: string | null, language: unknown = "en"): string {
  return bookingWords(language).roomLabels[roomKind(room)];
}

/** The room of one booking (roomsFor, for one). */
export async function roomOf(callsId: string | null, ask: RoomAsk): Promise<string | null> {
  return (await roomsFor(callsId, [ask]))[0];
}

/**
 * What a buyer or the creator is told next to a room made here, so nobody
 * is surprised at the door. In English, as the creator is told; a buyer is
 * told in the store's language (videoRoomNote).
 */
export const VIDEO_ROOM_NOTE = bookingWords("en").videoRoomNote;

/** VIDEO_ROOM_NOTE in a store's language (lib/buyer-words/booking.ts), for its buyers. */
export function videoRoomNote(language: unknown): string {
  return bookingWords(language).videoRoomNote;
}
