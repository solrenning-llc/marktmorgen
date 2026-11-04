/**
 * The creator's own calendars, both ways, without connecting any account.
 *
 * In: a creator pastes up to MAX_FEEDS private calendar addresses — Google
 * Calendar's "secret address in iCal format", an Outlook calendar published
 * as ICS, an iCloud public calendar — and the times they are busy there are
 * not offered as call times (lib/calls.ts). No OAuth and no password: the
 * address is the key, it opens a read-only copy of the calendar, and the
 * creator can stop it at any time by removing it here or resetting it in
 * their calendar app.
 *
 * Those addresses are secrets. They are kept in Redis, never sent back to
 * the browser once saved — the studio shows which service and when it was
 * added, never the address — and every fetch of one goes through
 * lib/safe-fetch.ts, so an address pointing inside our network is refused.
 * What is read is kept for ten minutes (CACHE_SECONDS), so a busy booking
 * page asks the calendar at most once in that time; only the busy times are
 * kept, never a title, a guest or a place. A calendar that fails to answer
 * blocks nothing new: the last good reading is used for up to six hours
 * (STALE_SECONDS), after that nothing, and the studio says what went wrong.
 * Bookings never wait on it for more than FEED_TIMEOUT_MS.
 *
 * Out: every store gets a private address of its own,
 * /api/store/calendar/<token>.ics, that lists its upcoming booked calls and
 * dated sessions with the buyers' names, for the creator to subscribe to from
 * Google, Outlook or Apple. The token can be replaced, which turns the old
 * address off at once.
 *
 *   nl:cal:cfg:<statsId>       { handle, feeds, token, tokenAt }
 *   nl:cal:tok:<hash>          statsId, for the subscription address
 *   nl:cal:busy:<feed>         the last reading, ten minutes
 *   nl:cal:good:<feed>         the last good reading, six hours
 *   nl:cal:err:<feed>          the last failure, for the studio
 *   nl:cal:out:<statsId>       the last good copy of the subscription file,
 *                              { at, ics }, CALENDAR_COPY_SECONDS (40 days)
 *   nl:cal:pace:<statsId>:<h>  the feed's answers in hour h, an hour
 *   nl:cal:builds:<statsId>:<d> the file's makings on UTC day d, two days
 *   nl:cal:chg:<handle>        when the bookings last changed, ms (written by
 *                              lib/call-records.ts, bookingsChangedKey)
 */
import { placeIcsLines, placeLine } from "@/lib/call-place";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Busy, isTimeZone, roomFor, seatsAt } from "@/lib/call-setup";
import { SafeFetchError, checkUrl, problemWords, safeFetch } from "@/lib/safe-fetch";
import { type Interval, looksLikeCalendar, parseIcs } from "@/lib/ics-parse";
import { type Listing, type Store, handleLeadsToStore, storeHandleKey } from "@/lib/store";
import { idsOfKind, readListing, recordListings } from "@/lib/catalog";
import { type RoomAsk, VIDEO_ROOM_NOTE, isVideoRoom, roomsFor } from "@/lib/call-rooms";
import { SITE_URL } from "@/lib/site-url";
import { CACHE_SECONDS, LOOKAHEAD_DAYS, MAX_FEEDS, STALE_SECONDS } from "@/lib/calendar-limits";
import { CALENDAR_CREDITS_PER_DAY } from "@/lib/calendar-limits";
import { fold, icsText, icsTime } from "@/lib/ics-write";
import { bookingCreditsKey, bookingsChangedKey } from "@/lib/call-records";

/** Calendars one store may read, and how far ahead (lib/calendar-limits.ts, which the studio and the feature page read too). */
export { CACHE_SECONDS, LOOKAHEAD_DAYS, MAX_FEEDS, STALE_SECONDS };
/** The largest calendar file read. A busy calendar of ten years is well under it. */
export const FEED_MAX_BYTES = 2_000_000;
/** How long a calendar may take to answer, redirects included. */
export const FEED_TIMEOUT_MS = 8_000;
/**
 * Events the subscription file holds at the most (4 November 2026, C4-4): so
 * the file kept, read on every answer and sent on, has a size its feed's
 * ceiling can be priced at (lib/read-ceilings.ts). Those still to come are
 * kept first (keptSlots): past it, the oldest sessions already over (up to a
 * week back) are left out of the file, then the furthest ahead.
 */
export const CALENDAR_MAX_EVENTS = 1_000;
/** How long the last good copy of the subscription file is kept for the calendar app (bookedCalendarFeed). */
export const CALENDAR_COPY_SECONDS = 40 * 86_400;
/**
 * The copy is made again when a booking changed (lib/call-records.ts,
 * bookingsChangedKey: a booking made or moved, a time let go, or a call
 * refunded in full, lib/call-meetings.ts), or once it is this old. What marks
 * nothing yet (a cancellation, a live session the creator adds: their paths
 * are other agents' files) shows at the next making: within this, or up to a
 * day when the UTC day's makings (CALENDAR_BUILDS_PER_DAY) are spent. A
 * booking whose dispute was lost stays in the file: it reads the payment
 * (lib/calls.ts, callFromRow), which a lost dispute does not show refunded.
 */
export const CALENDAR_REFRESH_SECONDS = 12 * 3_600;
/** Times a store's file may be made again in a UTC day, every reason together. */
export const CALENDAR_BUILDS_PER_DAY = 2;
/** More makings a UTC day, one for each booking made, moved or let go (lib/calendar-limits.ts, CALENDAR_CREDITS_PER_DAY). */
export { CALENDAR_CREDITS_PER_DAY };
/**
 * Answers one store's feed gets in an hour: four, two calendar apps (a phone
 * and a computer) each asking every thirty minutes, the file's own
 * REFRESH-INTERVAL. A third app asks more than this and is told to come back.
 */
export const CALENDAR_POLLS_PER_HOUR = 4;
/**
 * The largest copy kept and sent, in bytes: CALENDAR_MAX_EVENTS events at
 * 2 KB and the bookings of five Stripe pages (lib/calls.ts, MAX_PAGES) at
 * 512 bytes each. A review ceiling of the file's lines; larger is refused.
 */
export const CALENDAR_FILE_MAX_BYTES = CALENDAR_MAX_EVENTS * 2_048 + 5 * 100 * 512;
/** The longest address accepted. Google's secret addresses are about 150 characters. */
export const MAX_FEED_URL = 1000;

const TOKEN_PATTERN = /^[0-9a-f]{48}$/;
const FEED_ID_PATTERN = /^[0-9a-f]{16}$/;

type Feed = { id: string; url: string; addedAt: string };
/** `callsId`: the store's id for its calls (lib/store.ts), which its bookings' changed mark is kept by; written with the handle. */
type Config = { handle: string; feeds: Feed[]; token: string | null; tokenAt: string; callsId?: string | null };
export type Reading = { at: number; busy: [number, number][]; events: number; unsupported: number; truncated: boolean };

const cfgKey = (statsId: string) => `nl:cal:cfg:${statsId}`;
const tokenKey = (token: string) => `nl:cal:tok:${createHash("sha256").update(`nimbus-cal:${token}`).digest("hex").slice(0, 40)}`;
const busyKey = (feed: string) => `nl:cal:busy:${feed}`;
const goodKey = (feed: string) => `nl:cal:good:${feed}`;
const errKey = (feed: string) => `nl:cal:err:${feed}`;
const lockKey = (feed: string) => `nl:cal:lock:${feed}`;
/** What a store's calendar keeps beside its settings, from them: for a closed store (lib/closed-store-data.ts). */
export function calendarKeys(raw: unknown): string[] {
  const value = (raw && typeof raw === "object" ? raw : {}) as { token?: unknown; feeds?: unknown };
  const feeds = Array.isArray(value.feeds) ? value.feeds.map((f) => (f && typeof f === "object" ? String((f as { id?: unknown }).id ?? "") : "")).filter((id) => /^[0-9a-f]{8,40}$/.test(id)) : [];
  return [...(typeof value.token === "string" && value.token ? [tokenKey(value.token)] : []), ...feeds.flatMap((id) => [busyKey(id), goodKey(id), errKey(id), lockKey(id)])];
}
const outKey = (statsId: string) => `nl:cal:out:${statsId}`;
/**
 * The feed's answers of the last hour (a sorted set of their times: a sliding
 * hour), the file's makings in one UTC day, and the makings used from its
 * bookings' credits that day, each the store's.
 */
const paceKey = (statsId: string) => `nl:cal:pace:${statsId}`;
const buildsKey = (statsId: string, day: string) => `nl:cal:builds:${statsId}:${day}`;
const creditsUsedKey = (statsId: string, day: string) => `nl:cal:builds:${statsId}:${day}:c`;

function parseConfig(raw: unknown): Config | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Config>;
    const feeds = Array.isArray(value.feeds)
      ? value.feeds.filter(
          (f): f is Feed => Boolean(f) && typeof f.id === "string" && FEED_ID_PATTERN.test(f.id) && typeof f.url === "string" && Boolean(f.url),
        )
      : [];
    return {
      handle: typeof value.handle === "string" ? value.handle : "",
      feeds: feeds.slice(0, MAX_FEEDS),
      token: typeof value.token === "string" && TOKEN_PATTERN.test(value.token) ? value.token : null,
      tokenAt: typeof value.tokenAt === "string" ? value.tokenAt : "",
      callsId: typeof value.callsId === "string" && /^[0-9a-f]{8,40}$/.test(value.callsId) ? value.callsId : null,
    };
  } catch {
    return null;
  }
}

function parseReading(raw: unknown): Reading | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Reading;
    if (!Array.isArray(value.busy) || typeof value.at !== "number") return null;
    return value;
  } catch {
    return null;
  }
}

async function readConfig(store: Store): Promise<Config | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", cfgKey(store.statsId)]]);
  return parseConfig(raw);
}

async function writeConfig(store: Store, config: Config): Promise<void> {
  if (!store.statsId) return;
  await redisPipeline([["SET", cfgKey(store.statsId), JSON.stringify({ ...config, handle: store.handle, callsId: store.callsId ?? null })]]);
}

/** The zone for all-day and floating times, when a calendar names none. */
async function homeZone(store: Store): Promise<string> {
  const first = idsOfKind(store, "call")[0];
  const tz = first ? (await readListing(store, first))?.call?.tz : undefined;
  return tz && isTimeZone(tz) ? tz : "UTC";
}

/** Which service an address belongs to, in the words the creator knows it by. */
export function providerOf(url: string): string {
  let host = "";
  try {
    host = new URL(url.replace(/^webcals?:\/\//i, "https://")).hostname.toLowerCase();
  } catch {
    return "Calendar";
  }
  if (host === "calendar.google.com" || host.endsWith(".google.com")) return "Google Calendar";
  if (host.endsWith("outlook.office365.com") || host.endsWith("outlook.live.com") || host.endsWith("outlook.office.com")) return "Outlook";
  if (host.endsWith("icloud.com")) return "iCloud";
  if (host.endsWith("fastmail.com")) return "Fastmail";
  if (host.endsWith("calendly.com")) return "Calendly";
  return host.replace(/^www\./, "");
}

// ---- Reading a calendar -----------------------------------------------------

/**
 * Fetches and reads one calendar. Throws a SafeFetchError, or an Error with a
 * sentence for the creator, when it cannot be read.
 */
export async function readFeed(url: string, fallbackTz: string, now: number, fetchOptions: FetchHooks = {}): Promise<Reading> {
  const answer = await safeFetch(url, {
    maxBytes: FEED_MAX_BYTES,
    timeoutMs: FEED_TIMEOUT_MS,
    headers: { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1", "User-Agent": "Marktmorgen-Calendar/1.0 (+https://marktmorgen.com)" },
    ...fetchOptions,
  });
  if (answer.status === 401 || answer.status === 403 || answer.status === 404 || answer.status === 410) {
    throw new Error(`The calendar answered ${answer.status}: the address has been reset or is no longer public. Copy it again from your calendar's settings.`);
  }
  if (answer.status < 200 || answer.status >= 300) throw new Error(`The calendar answered ${answer.status}. It is tried again in a few minutes.`);
  const text = answer.body.toString("utf8");
  if (!looksLikeCalendar(text)) {
    throw new Error("That address answers with a web page, not a calendar file. Use the calendar's private iCal (.ics) address (Google calls it the secret address in iCal format).");
  }
  const parsed = parseIcs(text, { from: now - 86_400_000, to: now + LOOKAHEAD_DAYS * 86_400_000, fallbackTz });
  return {
    at: now,
    busy: parsed.busy.map((b) => [b.start, b.end]),
    events: parsed.events,
    unsupported: parsed.unsupported,
    truncated: parsed.truncated,
  };
}

/** Test seams for the fetch; production passes nothing. */
export type FetchHooks = Pick<Parameters<typeof safeFetch>[1], "resolve" | "agent">;

/**
 * The busy times from every calendar the creator added, never throwing. A
 * reading under ten minutes old is used as it is; an older one is refreshed,
 * by one request at a time per calendar.
 */
export async function calendarBusy(
  store: Store,
  now = Date.now(),
  hooks: FetchHooks = {},
): Promise<{ busy: Busy[]; failing: number }> {
  let config: Config | null;
  try {
    config = await readConfig(store);
  } catch {
    return { busy: [], failing: 0 };
  }
  if (!config || !config.feeds.length) return { busy: [], failing: 0 };
  const fallbackTz = await homeZone(store);
  const cached = await redisPipeline(config.feeds.flatMap((f) => [["GET", busyKey(f.id)], ["GET", goodKey(f.id)]])).catch(() => null);
  let failing = 0;
  const lists = await Promise.all(
    config.feeds.map(async (feed, i): Promise<[number, number][]> => {
      const fresh = cached ? parseReading(cached[i * 2]) : null;
      if (fresh) return fresh.busy;
      const good = cached ? parseReading(cached[i * 2 + 1]) : null;
      // Somebody else is reading it right now: the last good reading will do.
      const [mine] = await redisPipeline([["SET", lockKey(feed.id), "1", "NX", "EX", 20]]).catch(() => [null]);
      if (mine === null) return good?.busy ?? [];
      try {
        const reading = await readFeed(feed.url, fallbackTz, now, hooks);
        const text = JSON.stringify(reading);
        await redisPipeline([
          ["SET", busyKey(feed.id), text, "EX", CACHE_SECONDS],
          ["SET", goodKey(feed.id), text, "EX", STALE_SECONDS],
          ["DEL", errKey(feed.id)],
        ]);
        return reading.busy;
      } catch (error) {
        failing += 1;
        const message = error instanceof SafeFetchError ? problemWords(error) : error instanceof Error ? error.message : "The calendar could not be read.";
        // The failure is remembered for the studio, and the calendar is not
        // asked again for two minutes, so a broken one is not hammered.
        await redisPipeline([
          ["SET", errKey(feed.id), JSON.stringify({ at: now, message: message.slice(0, 300) }), "EX", STALE_SECONDS],
          ["SET", busyKey(feed.id), JSON.stringify({ at: now, busy: good?.busy ?? [], events: 0, unsupported: 0, truncated: false }), "EX", 120],
        ]).catch(() => {});
        return good?.busy ?? [];
      } finally {
        await redisPipeline([["DEL", lockKey(feed.id)]]).catch(() => {});
      }
    }),
  );
  const busy: Busy[] = lists.flat().map(([start, end]) => ({ start, end }));
  return { busy, failing };
}

// ---- The studio --------------------------------------------------------------

export type FeedView = {
  id: string;
  provider: string;
  addedAt: string;
  /** "ok" with its reading, "error" with the sentence, or "waiting" before the first reading. */
  state: "ok" | "error" | "waiting";
  checkedAt: number;
  message: string;
  busyTimes: number;
  unsupported: number;
};

export type CalendarView = {
  feeds: FeedView[];
  /** The private subscription address, or null before one is made. */
  subscribeUrl: string | null;
};

/** What the studio shows: the calendars, without their addresses, and how each last went. */
export async function calendarView(store: Store): Promise<CalendarView> {
  const config = await readConfig(store);
  if (!config) return { feeds: [], subscribeUrl: null };
  const replies = config.feeds.length
    ? await redisPipeline(config.feeds.flatMap((f) => [["GET", goodKey(f.id)], ["GET", errKey(f.id)]]))
    : [];
  const feeds = config.feeds.map((feed, i): FeedView => {
    const good = parseReading(replies[i * 2]);
    let failure: { at: number; message: string } | null = null;
    try {
      failure = typeof replies[i * 2 + 1] === "string" ? (JSON.parse(replies[i * 2 + 1] as string) as { at: number; message: string }) : null;
    } catch {
      failure = null;
    }
    const failedLast = failure && (!good || failure.at >= good.at);
    return {
      id: feed.id,
      provider: providerOf(feed.url),
      addedAt: feed.addedAt,
      state: failedLast ? "error" : good ? "ok" : "waiting",
      checkedAt: failedLast && failure ? failure.at : good?.at ?? 0,
      message: failedLast && failure ? failure.message : "",
      busyTimes: good?.busy.length ?? 0,
      unsupported: good?.unsupported ?? 0,
    };
  });
  return { feeds, subscribeUrl: config.token ? subscribeUrl(config.token) : null };
}

export function subscribeUrl(token: string): string {
  return `${SITE_URL}/api/store/calendar/${token}.ics`;
}

export type AddFeedResult =
  | { ok: true; view: CalendarView; busyTimes: number }
  | { ok: false; reason: "full" | "duplicate" | "long" | "invalid" | "unavailable"; message: string };

/**
 * Adds a calendar, after reading it once: an address that cannot be read is
 * refused with the reason, so a creator never leaves the studio believing a
 * calendar is blocking times when it is not.
 */
export async function addFeed(store: Store, raw: string, now = Date.now(), hooks: FetchHooks = {}): Promise<AddFeedResult> {
  if (!store.statsId) return { ok: false, reason: "invalid", message: "Open the studio once more and try again." };
  const text = raw.trim();
  if (text.length > MAX_FEED_URL) return { ok: false, reason: "long", message: "That address is longer than any calendar address we know of." };
  const config = (await readConfig(store)) ?? { handle: store.handle, feeds: [], token: null, tokenAt: "" };
  if (config.feeds.length >= MAX_FEEDS) return { ok: false, reason: "full", message: `A store can read ${MAX_FEEDS} calendars. Remove one first.` };
  let url: string;
  try {
    url = checkUrl(text).toString();
  } catch (error) {
    return { ok: false, reason: "invalid", message: problemWords(error) };
  }
  if (config.feeds.some((f) => f.url === url)) return { ok: false, reason: "duplicate", message: "That calendar is already added." };
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, reason: "unavailable", message: "Calendar changes are temporarily unavailable. Try again later." };
  let reading: Reading;
  try {
    reading = await readFeed(url, await homeZone(store), now, hooks);
  } catch (error) {
    return { ok: false, reason: "invalid", message: error instanceof Error ? error.message : "The calendar could not be read." };
  }
  const feed: Feed = { id: randomBytes(8).toString("hex"), url, addedAt: new Date(now).toISOString() };
  await writeConfig(store, { ...config, feeds: [...config.feeds, feed] });
  const saved = JSON.stringify(reading);
  await redisPipeline([
    ["SET", busyKey(feed.id), saved, "EX", CACHE_SECONDS],
    ["SET", goodKey(feed.id), saved, "EX", STALE_SECONDS],
  ]);
  return { ok: true, view: await calendarView(store), busyTimes: reading.busy.length };
}

/** Stops reading a calendar and forgets its address and everything read from it. */
export async function removeFeed(store: Store, id: string): Promise<CalendarView> {
  const config = await readConfig(store);
  if (config && config.feeds.some((f) => f.id === id)) {
    await writeConfig(store, { ...config, feeds: config.feeds.filter((f) => f.id !== id) });
    await redisPipeline([["DEL", busyKey(id), goodKey(id), errKey(id)]]);
  }
  return calendarView(store);
}

/**
 * Makes the store's subscription address, or a new one in place of the old,
 * which stops answering at once.
 */
export async function newFeedToken(store: Store): Promise<CalendarView> {
  const config = (await readConfig(store)) ?? { handle: store.handle, feeds: [], token: null, tokenAt: "" };
  const token = randomBytes(24).toString("hex");
  const commands: (string | number)[][] = [["SET", tokenKey(token), store.statsId as string]];
  if (config.token) commands.push(["DEL", tokenKey(config.token)]);
  await redisPipeline(commands);
  // The last copy stays, so the new address answers at once even when the day's makings are spent; only a
  // tombstone (the store's handle once led elsewhere) goes, since this store is plainly its handle's own.
  if (store.statsId) {
    const [kept] = await redisPipeline([["GET", outKey(store.statsId)]]);
    if (parseKept(kept).gone) await redisPipeline([["DEL", outKey(store.statsId)]]);
  }
  await writeConfig(store, { ...config, token, tokenAt: new Date().toISOString() });
  return calendarView(store);
}

/** Makes the subscription address the first time the studio needs one. */
export async function ensureFeedToken(store: Store): Promise<void> {
  if (!store.statsId || !isRedisConfigured()) return;
  const config = await readConfig(store);
  if (config?.token) {
    // Renamed, or written before the settings named the store's calls: written again, so the feed reads its marks.
    if (config.handle !== store.handle || (config.callsId ?? null) !== (store.callsId ?? null)) await writeConfig(store, config);
    return;
  }
  await newFeedToken(store);
}

/** The store a subscription address belongs to, or null. */
export async function storeIdForToken(token: string): Promise<{ statsId: string; handle: string; callsId: string | null } | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [statsId] = await redisPipeline([["GET", tokenKey(token)]]);
  if (typeof statsId !== "string" || !statsId) return null;
  const [raw] = await redisPipeline([["GET", cfgKey(statsId)]]);
  const config = parseConfig(raw);
  // A replaced token is deleted, and this second check covers a lookup that
  // raced the replacement.
  if (!config || config.token !== token) return null;
  return { statsId, handle: config.handle, callsId: config.callsId ?? null };
}

// ---- Clashes the studio points out -----------------------------------------

/** The busy stretches that overlap a time, for the dated sessions the studio lists. */
export function overlaps(busy: Interval[], start: number, end: number): boolean {
  return busy.some((b) => b.start < end && b.end > start);
}

// ---- The subscription file ----------------------------------------------------

export type BookedCall = {
  session: string;
  start: number;
  end: number;
  product: string;
  email: string | null;
  name: string | null;
  moves: number;
};

/**
 * Every booked call and dated session still to come (and those of the last
 * week), as a calendar file. A one-to-one call is one event named after its
 * buyer; a group call or a session is one event with everybody booked into it
 * listed. Every event id ends in @marktmorgen.com, which is also how a
 * calendar read back in (above) knows these are ours and not busy time.
 */
export function bookedCalendar(
  store: Store,
  calls: BookedCall[],
  now = Date.now(),
  /** The store's calls, read by the caller (readKind); the store record's own when not given. */
  listings: Listing[] = recordListings(store),
  /** The room of each booked time (slotRooms), by "<product>|<start>". */
  rooms: Map<string, string | null> = new Map(),
): string {
  const since = now - 7 * 86_400_000;
  const slots = new Map<string, { product: string; start: number; end: number; people: BookedCall[] }>();
  for (const call of calls) {
    if (call.end <= since) continue;
    const key = `${call.product}|${call.start}`;
    const slot = slots.get(key) ?? { product: call.product, start: call.start, end: call.end, people: [] };
    slot.people.push(call);
    slots.set(key, slot);
  }
  for (const product of listings) {
    if (product.call?.kind !== "live") continue;
    for (const session of product.call.sessions) {
      const key = `${product.id}|${session.start}`;
      const end = session.start + session.minutes * 60_000;
      if (end > since && !slots.has(key)) slots.set(key, { product: product.id, start: session.start, end, people: [] });
    }
  }
  const who = (c: BookedCall) => (c.name && c.email ? `${c.name} <${c.email}>` : c.name ?? c.email ?? "A buyer who gave no address");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Marktmorgen//Bookings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`${store.name} bookings`)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];
  for (const slot of keptSlots([...slots.values()], now)) {
    const product = listings.find((p) => p.id === slot.product);
    const title = product?.title ?? "A call that is no longer listed";
    const setup = product?.call ?? null;
    const seats = setup ? seatsAt(setup, slot.start) : 1;
    const group = setup !== null && (setup.kind === "live" || seats > 1);
    const key = `${slot.product}|${slot.start}`;
    // A booked time has the room its bookings were given; an empty session
    // that makes rooms gets one when somebody books it.
    // In person (lib/call-place.ts): the address, and no link, not even a room kept from when it was online.
    const place = setup?.place ?? null;
    const room = place ? null : rooms.has(key) ? rooms.get(key) ?? null : setup && !setup.video ? roomFor(setup, slot.start) : null;
    const video = isVideoRoom(room);
    const single = !group && slot.people.length === 1 ? slot.people[0] : null;
    const summary = single
      ? `${title} with ${single.name ?? single.email ?? "a buyer"}`
      : slot.people.length
        ? `${title} (${slot.people.length}${group ? ` of ${seats}` : ""} booked)`
        : `${title} (no one booked yet)`;
    const description = [
      ...(slot.people.length ? [slot.people.length === 1 ? "Booked by:" : "Booked:", ...slot.people.map(who)] : ["Nobody has booked this yet."]),
      ...(place ? ["", `In person, at: ${placeLine(place)}`] : room ? ["", `Join: ${room}`] : []),
      ...(video ? [VIDEO_ROOM_NOTE] : []),
      ...(!room && setup?.video ? ["", "A private video room is made for it when the first person books."] : []),
      "",
      "From your Marktmorgen studio.",
    ].join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${single ? single.session : `${slot.product}-${slot.start}`}@marktmorgen.com`,
      `DTSTAMP:${icsTime(now)}`,
      `SEQUENCE:${single ? single.moves : 0}`,
      `DTSTART:${icsTime(slot.start)}`,
      `DTEND:${icsTime(slot.end)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(description)}`,
      ...(place ? placeIcsLines(place) : room ? [`LOCATION:${icsText(room)}`] : []),
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/**
 * The room of every booked time in a list of bookings, by "<product>|<start>",
 * for bookedCalendar: one question to Redis for all of them (lib/call-rooms.ts).
 */
export async function slotRooms(store: Store, calls: BookedCall[], listings: Listing[]): Promise<Map<string, string | null>> {
  const firsts = new Map<string, BookedCall>();
  for (const call of calls) {
    const key = `${call.product}|${call.start}`;
    if (!firsts.has(key)) firsts.set(key, call);
  }
  const asks: { key: string; ask: RoomAsk }[] = [];
  for (const [key, call] of firsts) {
    const setup = listings.find((p) => p.id === call.product)?.call;
    if (setup) asks.push({ key, ask: { product: call.product, setup, session: call.session, start: call.start, end: call.end } });
  }
  const rooms = await roomsFor(store.callsId, asks.map((a) => a.ask));
  return new Map(asks.map((a, i) => [a.key, rooms[i]]));
}

/**
 * The CALENDAR_MAX_EVENTS events the file holds, in time order: those still to
 * come first, the soonest first, then the latest of those over. A store past
 * it leaves out its oldest past sessions (up to a week back) before anything
 * still to come, and only then the furthest ahead.
 */
export function keptSlots<T extends { start: number; end: number }>(slots: T[], now: number): T[] {
  const ahead = slots.filter((s) => s.end > now).sort((a, b) => a.start - b.start);
  const over = slots.filter((s) => s.end <= now).sort((a, b) => b.start - a.start);
  return [...ahead, ...over].slice(0, CALENDAR_MAX_EVENTS).sort((a, b) => a.start - b.start);
}

/** The last good copy of a store's file, and when it was begun. */
/**
 * The last good copy of a store's file: when it was begun, the file, and what
 * the store's handle led to when it was made (`ref`, the handle's key as read),
 * so a copy is answered only while the handle still leads to the store that
 * made it. Or, once the handle was found to lead to another store, a
 * tombstone (`gone: true`, nothing of either store in it), so the feed
 * answers 404 at once without making anything again.
 */
type Copy = { at: number; ics: string; ref: string; sid: string };
type Kept = { copy: Copy | null; gone: boolean };
function parseKept(raw: unknown): Kept {
  if (typeof raw !== "string" || !raw) return { copy: null, gone: false };
  try {
    const value = JSON.parse(raw) as Partial<Copy> & { gone?: unknown };
    if (value.gone === true || typeof value.gone === "string") return { copy: null, gone: true };
    const copy = typeof value.at === "number" && typeof value.ics === "string" && value.ics
      ? { at: value.at, ics: value.ics, ref: typeof value.ref === "string" ? value.ref : "", sid: typeof value.sid === "string" ? value.sid : "" }
      : null;
    return { copy, gone: false };
  } catch {
    return { copy: null, gone: false };
  }
}

/**
 * A count with a ceiling, taken whole or not at all: SET NX with its expiry,
 * INCRBY, EXPIRE NX, and DECRBY when over. A count that cannot be made is a refusal.
 */
async function takeCounted(key: string, ceiling: number, seconds: number): Promise<boolean> {
  try {
    // The expiry is set after the count too (NX: only where there is none), so a count that lost it gets it back.
    const [, raw] = await redisPipeline([["SET", key, "0", "NX", "EX", seconds], ["INCRBY", key, 1], ["EXPIRE", key, seconds, "NX"]]);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) return false;
    if (n <= ceiling) return true;
    await redisPipeline([["DECRBY", key, 1]]).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

/**
 * The copy written only while the store's calendar settings exist, in one step:
 * EXISTS, then SET with its expiry (lib/redis-memory.ts runs it the same way).
 */
export const KEEP_COPY = `-- marktmorgen:calendar-copy:v1
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[2])
return 1`;

/** Thrown by a feed's `make` when the store behind its token is not the one that kept it. */
export class FeedGone extends Error {}

/**
 * One more answer within the last sixty minutes, a sliding hour: its time
 * added to the store's set (ZADD), the older ones let go (ZREMRANGEBYSCORE),
 * the rest counted (ZCARD) and the set's expiry (EXPIRE); taken back (ZREM)
 * when past CALENDAR_POLLS_PER_HOUR. Never more than the pace, however late in
 * an hour an app asks. A count that cannot be made is a refusal.
 */
async function withinPace(statsId: string, now: number): Promise<boolean> {
  const key = paceKey(statsId);
  // One answer's mark: its time and a few random bytes, nothing about who asked.
  const mark = `${now}:${randomBytes(4).toString("hex")}`;
  try {
    const [, , n] = await redisPipeline([
      ["ZADD", key, now, mark],
      ["ZREMRANGEBYSCORE", key, "-inf", now - 3_600_000],
      ["ZCARD", key],
      ["EXPIRE", key, 3_600],
    ]);
    const count = Number(n);
    if (!Number.isSafeInteger(count)) return false;
    if (count <= CALENDAR_POLLS_PER_HOUR) return true;
    await redisPipeline([["ZREM", key, mark]]).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

export type FeedAnswer = { state: "copy" | "made"; ics: string } | { state: "paced" | "none" | "gone" };

/**
 * What a store's private feed answers a calendar app (4 November 2026, C4-4;
 * owner's rule MR). An app asks on its own (every thirty minutes, as the file says), so asking
 * must never spend anything the creator sees counted (their studio's
 * requests): it is answered from the last good copy of the file, kept
 * CALENDAR_COPY_SECONDS, and the file is made again (`make`, which reads the
 * store and its Stripe account) only when a booking was made or moved, or a
 * time let go, since the copy was begun (lib/call-records.ts,
 * bookingsChangedKey), or the copy is CALENDAR_REFRESH_SECONDS old; at most
 * CALENDAR_BUILDS_PER_DAY times a store a UTC day, counted before it is made.
 * Past that, or when making it fails, the copy is answered as it is. One
 * feed is answered CALENDAR_POLLS_PER_HOUR times an hour, counted before its
 * copy is read; past them it is asked to come back ("paced"). A store
 * deleted or closed is "gone" at once, with the same read as its copy (its
 * handle is let go: lib/store.ts, handleLeadsToStore): its copy, which names
 * buyers, is never answered again. A file larger than CALENDAR_FILE_MAX_BYTES
 * is neither kept nor sent. All of it is one cost line of its own
 * (tests/plan-cost-registry.ts, calendar-feed). "none" when there is no copy
 * and none could be made.
 */
/**
 * Forgets a deleted store's feed at once (app/api/store/stores, its delete):
 * its settings, its subscription address, its feeds' readings and the last
 * copy of its file, which names its buyers, as a closed store's are
 * (lib/closed-store-data.ts, calendarKeys).
 */
export async function forgetStoreCalendar(statsId: string | null | undefined): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const [raw] = await redisPipeline([["GET", cfgKey(statsId)]]);
  let parsed: unknown = null;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  await redisPipeline([["DEL", cfgKey(statsId), outKey(statsId), ...calendarKeys(parsed)]]);
}

export async function bookedCalendarFeed(owner: { statsId: string; handle: string; callsId?: string | null }, make: () => Promise<string>, now = Date.now()): Promise<FeedAnswer> {
  if (!(await withinPace(owner.statsId, now))) return { state: "paced" };
  const day = new Date(now).toISOString().slice(0, 10);
  let raw: unknown[];
  try {
    // The changed mark and the day's credits are kept by the store's calls id (lib/call-records.ts), which a
    // rename does not change; settings written before they named it have neither, and the refresh stands.
    const marks = owner.callsId ? [bookingsChangedKey(owner.callsId), bookingCreditsKey(owner.callsId, day)] : ["", ""];
    raw = await redisPipeline([["MGET", outKey(owner.statsId), storeHandleKey(owner.handle), ...marks.filter(Boolean)]]);
  } catch {
    return { state: "none" };
  }
  const values = Array.isArray(raw[0]) ? (raw[0] as unknown[]) : [];
  const [copyRaw, handleRaw, changedRaw, creditsRaw] = [values[0] ?? null, values[1] ?? null, values[2] ?? null, values[3] ?? null];
  // The store was deleted or closed (its handle let go): what it kept, which names its buyers, goes now.
  if (!handleLeadsToStore(handleRaw)) {
    await redisPipeline([["DEL", outKey(owner.statsId)]]).catch(() => {});
    return { state: "gone" };
  }
  const ref = handleRaw as string;
  const kept = parseKept(copyRaw);
  // Already found to lead to another store: 404 at once, nothing made, nothing of the old store's shown.
  if (kept.gone) return { state: "gone" };
  // A copy is answered only while the handle leads to the store that made it; otherwise the file is made again,
  // and `make` reads the store behind the handle and compares its id with the feed's (FeedGone when it is another store).
  // Both what the handle led to and the feed's own store id must match. A copy without them (none was ever kept
  // so: the copy carried both from its first release) or one made before the owner's account moved (lib/store.ts,
  // moveAccount: the handle then leads to the new address) is set aside once and made again.
  const copy = kept.copy && kept.copy.ref === ref && kept.copy.sid === owner.statsId ? kept.copy : null;
  const changed = Number(changedRaw) || 0;
  const changedSince = copy !== null && changed > copy.at;
  const fresh = copy !== null && !changedSince && now - copy.at < CALENDAR_REFRESH_SECONDS * 1000;
  if (fresh) return { state: "copy", ics: copy.ics };
  // A booking made, moved or let go since the copy: one of the day's credits, which bookings give, up to
  // CALENDAR_CREDITS_PER_DAY. Otherwise (or with none left) one of the day's own CALENDAR_BUILDS_PER_DAY.
  const credits = Math.min(Number(creditsRaw) || 0, CALENDAR_CREDITS_PER_DAY);
  const paid =
    (changedSince && credits > 0 && (await takeCounted(creditsUsedKey(owner.statsId, day), credits, 2 * 86_400)))
    || (await takeCounted(buildsKey(owner.statsId, day), CALENDAR_BUILDS_PER_DAY, 2 * 86_400));
  if (!paid) return copy ? { state: "copy", ics: copy.ics } : { state: "none" };
  let ics: string;
  try {
    ics = await make();
  } catch (error) {
    // The handle leads to another store now: the old copy goes, a tombstone answers 404 from now on.
    if (error instanceof FeedGone) {
      await redisPipeline([["SET", outKey(owner.statsId), JSON.stringify({ gone: true }), "EX", CALENDAR_COPY_SECONDS]]).catch(() => {});
      return { state: "gone" };
    }
    // Stripe did not answer: the copy stands.
    if (copy) return { state: "copy", ics: copy.ics };
    throw error;
  }
  const file = JSON.stringify({ at: now, ics, ref, sid: owner.statsId });
  if (Buffer.byteLength(file, "utf8") > CALENDAR_FILE_MAX_BYTES) {
    console.error("a booking calendar file is larger than its ceiling, so it is neither kept nor sent", owner.statsId);
    return copy ? { state: "copy", ics: copy.ics } : { state: "none" };
  }
  // Kept only while the store's settings are still there: a deletion that ran while this was being made
  // (forgetStoreCalendar) is not undone by a copy written after it, with its buyers' names.
  await redisPipeline([["EVAL", KEEP_COPY, 2, cfgKey(owner.statsId), outKey(owner.statsId), file, CALENDAR_COPY_SECONDS]]).catch(() => {});
  return { state: "made", ics };
}
