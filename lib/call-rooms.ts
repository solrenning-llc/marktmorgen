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
import { UnreadableMget, getsWhole, mgetCommands, mgetLotFor, mgetWhole } from "@/lib/redis-mget";
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
 * The most a room key (a booking's or a time's) holds: its only writer is the
 * SET NX of roomsFor, of a newVideoRoom() address, 44 bytes of letters,
 * digits and ":/.", which no JSON answer escapes.
 */
export const ROOM_VALUE_BYTES = VIDEO_ROOM_BASE.length + ROOM_NAME_LENGTH;
/**
 * Room keys read at one MGET at the most: 400, 200 bookings' two keys (calendar-feed room, 10 November 2026; sized by
 * bytes on 11 November 2026, review of #3079, Codex Z M1). Sized from the most a room key can be written at
 * (ROOM_VALUE_BYTES), doubled for the REST answer's escaping (REPLY_ESCAPE_FACTOR): 35,200 bytes a reply at most,
 * within MGET_REPLY_BYTES (1 MiB), which alone would allow 11,915; 400 keeps the request's keys (a checkout session's
 * id each, under 255 characters) near 130 KB. Upstash bills an MGET as one command whatever its keys; the bytes it
 * moves are priced where the reading is (lib/read-ceilings.ts).
 */
export const ROOM_KEYS_PER_MGET = Math.min(400, mgetLotFor(ROOM_VALUE_BYTES));
/** Room keys roomsFor reads in MGETs for each booking asked about: its own and its time's. */
export const ROOM_KEYS_PER_BOOKING = 2;
/**
 * Meeting records roomsFor reads for each booking, a GET each, under both of the booking's possible names. A record
 * has no byte cap where it is written (lib/meet-records.ts, writeRecord: up to MAX_GUESTS guests' and added
 * addresses, whose length the code does not bound), so no MGET lot could bound its reply, and none is in an MGET.
 */
export const ROOM_RECORDS_PER_BOOKING = 2;
/** The commands roomsFor's reads take for this many bookings; a count that is not a number is never priced low. */
export function roomReads(bookings: number): number {
  if (Number.isNaN(bookings) || bookings === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return bookings > 0 ? mgetCommands(ROOM_KEYS_PER_BOOKING * bookings, ROOM_KEYS_PER_MGET) + ROOM_RECORDS_PER_BOOKING * bookings : 0;
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
 * own link. The room keys' MGETs (MGET_CONCURRENCY trips at a time) and the
 * meeting records' GETs (one trip) are read side by side, then the rooms to
 * make in one trip more.
 */
export async function roomsFor(callsId: string | null, asks: RoomAsk[]): Promise<(string | null)[]> {
  return roomsRead(callsId, asks, false);
}

/**
 * roomsFor, for a reader that may ask about every booking of a store at once
 * (the booking calendar's making, lib/calendar-sync.ts, slotRoomsBatched): the
 * same reads, and a value that is there but is not what its key holds (a room
 * key without a room made here, a meeting record that does not parse or is
 * another call's, review of #3079) throws UnreadableMget: the reading fails,
 * never a room taken for absent (and so never a new one made in its place).
 */
export async function roomsForMany(callsId: string | null, asks: RoomAsk[]): Promise<(string | null)[]> {
  return roomsRead(callsId, asks, true);
}

/** The prefix of a meeting record's key: the rest is its scope (lib/meet-records.ts, recordKey). */
const RECORD_PREFIX = recordKey("");

async function roomsRead(callsId: string | null, asks: RoomAsk[], strict: boolean): Promise<(string | null)[]> {
  // In person (lib/call-place.ts): no room, not even one kept from when it was online; the others are asked as before.
  if (asks.some((a) => whereOf(a.setup).kind === "place")) {
    const online = asks.map((a, i) => ({ a, i })).filter(({ a }) => whereOf(a.setup).kind !== "place");
    const found = await roomsRead(callsId, online.map(({ a }) => a), strict);
    const out: (string | null)[] = asks.map(() => null);
    online.forEach(({ i }, k) => {
      out[i] = found[k];
    });
    return out;
  }
  if (!callsId || !isRedisConfigured() || asks.length === 0) return asks.map((a) => roomFor(a.setup, a.start));
  const roomKeys = asks.flatMap((a) => [bookingKey(callsId, a.session), timeKey(callsId, a.product, a.start)]);
  // Asked for every booking, not only those of a product set to make
  // meetings now, and under both of its possible names, since a call can
  // go from one seat to several: a booking keeps the link it was given.
  const recordKeys = asks.flatMap((a) => [
    recordKey(callScope(callsId, { group: false, session: a.session, product: a.product, start: a.start })),
    recordKey(callScope(callsId, { group: true, session: a.session, product: a.product, start: a.start })),
  ]);
  // The room keys ROOM_KEYS_PER_MGET at one MGET, the meeting records a GET each (no lot could bound their reply).
  // Read only whole (rule 24, lib/redis-mget.ts): one value per key, each text or nothing; anything else is unknown
  // and throws, never a booking taken to have no room (and one made in its place).
  const [rooms, records] = await Promise.all([mgetWhole(roomKeys, ROOM_KEYS_PER_MGET), getsWhole(recordKeys)]);
  if (strict) {
    // Each value there only when it is what its key holds: a room made here under a room key, a meeting record of
    // the key's own scope under a record's key (roomsForMany).
    if (rooms.some((value) => value !== null && !isVideoRoom(value))) throw new UnreadableMget("a room key held something other than a room made here");
    recordKeys.forEach((key, k) => {
      const value = records[k];
      if (value !== null && parseRecord(value)?.scope !== key.slice(RECORD_PREFIX.length)) {
        throw new UnreadableMget("a meeting record's key held something other than its own record");
      }
    });
  }
  const found: (string | null)[] = asks.map((_, i) => {
    const own = rooms[i * ROOM_KEYS_PER_BOOKING];
    const shared = rooms[i * ROOM_KEYS_PER_BOOKING + 1];
    const meeting = givenLink(parseRecord(records[i * ROOM_RECORDS_PER_BOOKING])) ?? givenLink(parseRecord(records[i * ROOM_RECORDS_PER_BOOKING + 1]));
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
