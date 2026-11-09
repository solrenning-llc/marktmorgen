/**
 * What it takes to open a short link (app/l/[code]/route.ts), so that what
 * an open costs always has a ceiling (Claude 5, 7 November 2026), without
 * one store's traffic or one connection taking the other stores' links down
 * (9 November 2026). The CDN keeps an answer for one exact address only: a
 * code nobody has, or a link with a query of its own each time, reaches the
 * function and the database.
 *
 *   - What this instance already knows is answered from its memory, with
 *     nothing sent to the database: a code it found ended
 *     (SHORT_LINK_ENDED_MS), a link of a store it found resting (it
 *     remembers each link's store, SHORT_LINK_OWNER_MS), a connection over
 *     its share of that store's day (until the day, or the store's window,
 *     ends), a link that could not be read a moment ago.
 *   - Then one address may make this instance answer SHORT_LINK_OPENS_PER_ADDRESS
 *     opens in SHORT_LINK_ADDRESS_WINDOW_MS (lib/local-limit.ts, which costs
 *     nothing), and a code whose store this instance does not know may be
 *     looked up only while that address's lookups here that left units in the
 *     shared hour (a code nobody has, a store gone, a link refused for its
 *     connection, a read nobody paid) in SHORT_LINK_MISS_WINDOW_MS, with its
 *     lookups still in flight, are fewer than SHORT_LINK_MISSES_PER_ADDRESS;
 *     the place is taken before anything is awaited, so a burst sent at once
 *     cannot pass it (Claude 2's focal return on #3330). The lookup is counted in its hour, one unit,
 *     in one count every instance shares (SHORT_LINK_COUNT_COMMANDS). Past
 *     SHORT_LINK_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS units the open
 *     is refused until the hour ends, and this instance sends nothing more to
 *     the database for SHORT_LINK_USED_UP_PAUSE_MS, then counts again;
 *     meanwhile a link its store paid for here a moment ago
 *     (SHORT_LINK_KNOWN_MS) is still counted and read, up to
 *     SHORT_LINK_KNOWN_UNPAID_PER_HOUR reads past the figure, its store paying
 *     for it. A count that cannot be read is not room to read: refused, and
 *     this instance waits SHORT_LINK_UNKNOWN_PAUSE_MS before counting again.
 *     Only a code nobody has and what no store pays for stay in this hour: a
 *     link of a store with room is given back, and a resting store's never
 *     lands there (Claude 2's first cost review of #3330, 9 November 2026).
 *   - Once the link is found, the store's id, its resting mark and the open's
 *     refund off the hour it was counted in (DECR with its EXPIRE) go in one
 *     pipeline. The open is then one of the store's public requests
 *     (lib/traffic.ts, takePublicRequestWhy), so its plan pays for it. What
 *     the store does not pay for is counted in that hour again, at
 *     SHORT_LINK_UNPAID_READ_UNITS in the shared hour, except:
 *       - the store over its own requests (or a free store without a place):
 *         its resting mark is written for SHORT_LINK_TIRED_MS
 *         (shortLinkRestKey), so its links are refused everywhere without its
 *         record read, and this instance refuses every link of that store from
 *         memory, first for SHORT_LINK_TIRED_MS, then twice as long each time
 *         it is asked again and still rests, up to SHORT_LINK_TIRED_MAX_MS.
 *         The open is counted in the resting hour (shortLinkRestHourKey), never
 *         the shared one; past SHORT_LINK_REST_UNPAID_PER_HOUR it is refused,
 *         and the store's mark says SHORT_LINK_TIRED_MAX_MS, so every
 *         instance refuses it without its record read for that long. The mark
 *         holds that moment and lives two hours: once the moment is past, only
 *         the one open that takes shortLinkRestCheckKey, site-wide, reads the
 *         store again, and a store found paying has its mark taken away (Claude
 *         2's focal return on #3330). Each store is asked again on its own time,
 *         counted in the resting hour before it is read, so one store waiting
 *         never waits behind another; the resting hour used, it is kept
 *         resting here a minute, nothing sent;
 *       - one connection over its share of the store's day: that connection
 *         alone is refused the store's links, until the day or the store's
 *         window ends, and told so;
 *       - a count that could not be made: refused, and that link answered
 *         from memory for SHORT_LINK_TIRED_MS.
 *
 * So the opens that read a store and that no store pays for are at most
 * SHORT_LINK_UNPAID_PER_HOUR + SHORT_LINK_KNOWN_UNPAID_PER_HOUR an hour in the
 * shared count (or SHORT_LINK_UNPAID_READ_UNITS lookups of codes nobody has for
 * each) and SHORT_LINK_REST_UNPAID_PER_HOUR in the resting one, plus, on each
 * instance, one count a minute while either hour is used or a count is
 * unreadable, and, past the resting hour, what resting stores read: at most
 * SHORT_LINK_STORE_READS_PER_HOUR reads of each such store's record an hour, and
 * one lookup a day an instance for each of its links, their numbers unknown,
 * never zero. A refund that fails leaves the open counted, never the other
 * way. Every refusal says so in plain words, sends nobody anywhere and is
 * never kept by the CDN (except a link turned off, the same static page for
 * everybody): it is never shown as "this link ended", and a store's
 * record that cannot be read is refused, never taken for a store gone. The
 * company's month is priced in tests/short-link-open-cap.test.ts and held
 * there as a company cost that is unknown, never zero, per instance, their
 * number unknown (SHORT_LINK_UNPAID_COMPANY_COST, tests/plan-cost-registry.ts);
 * it is not a line of lib/llc-fixed-costs.ts, which feeds
 * CURRENT_COMMERCIAL_TERMS.
 *
 *   nl:slink:open:<hour>   string   the hour's lookups and opens not paid by a store, in units, kept two hours
 *   nl:slink:tired:<hour>  string   the hour's opens of stores over their own requests, kept two hours
 *   nl:slink:rest:<sid>    string   the moment the store rests until, SHORT_LINK_TIRED_MS on (SHORT_LINK_TIRED_MAX_MS once the resting hour is used), kept two hours
 *                                   past it; since 9 November 2026 (the owner's decision 14): a store with a paid plan rests until its window ends,
 *                                   and one without says "<until>:<since>:<read>", since when it has rested without a gap and when its
 *                                   record last said so, kept SHORT_LINK_OFF_KEEP_SECONDS past that reading (never renewed by a link off)
 *   nl:slink:rest:<sid>:check string "1", the one open that asks a store whose moment is past (SET NX), kept SHORT_LINK_TIRED_MS
 *   nl:slink:rest:<sid>:cap:<hour> string the store's reads this hour it did not pay for, kept two hours
 *   nl:slink:rest:<sid>:flight zset   the store's opens in flight, by when each took its place, each lapsing SHORT_LINK_FLIGHT_MS later
 *   nl:slink:rest:<sid>:back  string the studio's notice that its links were turned off (lib/short-link-rest.ts)
 *
 * The owner's decision 14 on #3330 (9 November 2026) did not approve the US$81.49 a month one resting store could cost
 * (its record read once a mark's time and by every open in flight while it had no mark). Since then:
 *   - each store has its own counts (SHORT_LINK_STORE_READS_PER_HOUR), taken in the pipeline that reads its id, before
 *     its record can be read, the first day and in a cold burst alike: its reads this hour it did not pay for, and its
 *     opens in flight, each place lapsing by itself SHORT_LINK_FLIGHT_MS later (a give-back lost never holds the store).
 *     Past their sum the open is refused with nothing of the record read, the store marked resting a minute where it
 *     had no mark and kept so in this instance's memory, so the opens after it send nothing; except a store in the list
 *     of stores that pay with fewer than the figure's unpaid reads this hour, which pays each read (Claude 2's focal);
 *   - a store without a paid plan that has rested SHORT_LINK_OFF_AFTER_MS without a gap (its record read at least once
 *     a SHORT_LINK_OFF_KEEP_SECONDS, saying so each time) has its links turned off: a short static page (410, kept by
 *     the CDN CACHE_SECONDS) that promises nothing, its record read again once a day at most, never renewed by the page,
 *     and one SISMEMBER of the list of stores that pay, so one that pays again opens at its next open (a list that
 *     cannot be read is refused as unknown, never answered off). The moment it pays (lib/store.ts, setSubscription) its
 *     mark goes and the studio is told they were turned off (lib/short-link-rest.ts); an instance that remembers it
 *     off answers so up to SHORT_LINK_TIRED_MAX_MS more, and the CDN keeps the page CACHE_SECONDS;
 *   - an instance keeps a resting store's links' store SHORT_LINK_RESTING_OWNER_MS, so it looks each up once a day.
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLocalLimit } from "@/lib/local-limit";
import { takePublicRequestWhy } from "@/lib/traffic";
import { statusTime } from "@/lib/status-page";
import { allowanceWindow } from "@/lib/allowance-window";
import { type Store, storeForIdRefRead, storeIdCommand } from "@/lib/store";
import {
  HOUR_MS, SHORT_LINK_ADDRESS_WINDOW_MS, SHORT_LINK_ENDED_MS, SHORT_LINK_KNOWN_KEPT, SHORT_LINK_KNOWN_MS, SHORT_LINK_KNOWN_UNPAID_PER_HOUR,
  SHORT_LINK_OPEN_UNITS, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_OWNER_MS, SHORT_LINK_REST_UNPAID_PER_HOUR, SHORT_LINK_TIRED_KEPT,
  SHORT_LINK_TIRED_MAX_MS, SHORT_LINK_TIRED_MS, SHORT_LINK_UNKNOWN_PAUSE_MS, SHORT_LINK_UNPAID_KEY_SECONDS, SHORT_LINK_UNPAID_PER_HOUR,
  SHORT_LINK_USED_UP_PAUSE_MS, SHORT_LINK_UNPAID_READ_UNITS, SHORT_LINK_MISSES_PER_ADDRESS, SHORT_LINK_MISS_WINDOW_MS,
  SHORT_LINK_FLIGHT_MS, SHORT_LINK_OFF_AFTER_MS, SHORT_LINK_OFF_KEEP_SECONDS, SHORT_LINK_PAID_REST_MAX_MS,
  SHORT_LINK_RESTING_OWNER_MS, SHORT_LINK_STORE_READS_PER_HOUR,
  hourOf, offState, readRestMark, shortLinkRestCheckKey, shortLinkRestHourKey, shortLinkRestKey, shortLinkStoreFlightKey, shortLinkStoreHourKey,
  shortLinkUnpaidKey,
} from "@/lib/short-link-open-rules";
import { CACHE_SECONDS } from "@/lib/short-link-rules";
import { SITE_URL } from "@/lib/site-url";
import { PAYING_INDEX } from "@/lib/free-pool-rules";
import { standingOf } from "@/lib/plan-standing";
import { backOnCommands, turnedOffAt } from "@/lib/short-link-rest";

/** The two hours an open no store pays for is counted in: the one every store's links share, and resting stores' own. */
type Hour = "shared" | "rest";
/** Each hour's figure: the shared one in units (a lookup one, an unpaid store read SHORT_LINK_UNPAID_READ_UNITS), the resting one in opens. */
const LIMIT: Record<Hour, number> = { shared: SHORT_LINK_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS, rest: SHORT_LINK_REST_UNPAID_PER_HOUR };
/** Units past the shared hour's figure a link its store paid for here a moment ago may still be read within. */
const KNOWN_LIMIT = SHORT_LINK_KNOWN_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS;
/** What an open that read its store and that no store pays for is counted again at, in each hour. */
const UNPAID_UNITS: Record<Hour, number> = { shared: SHORT_LINK_UNPAID_READ_UNITS, rest: 1 };
/** The end of the hour `now` is in: until when a used hour stays used. */
const hourEnd = (now: number) => (hourOf(now) + 1) * HOUR_MS;
const keyOf = (hour: Hour, now: number) => (hour === "shared" ? shortLinkUnpaidKey(now) : shortLinkRestHourKey(now));

/**
 * Room to read, with the hour the open was counted in and its key; "ended" for a code this instance found ended a
 * moment ago, answered as ended with nothing read; or why not, and until when, where that is known.
 */
export type ShortLinkAdmission =
  | { state: "open"; hour: Hour; key: string; address: string; now: number; miss: boolean }
  | { state: "ended"; now: number }
  | { state: "hour" | "tired" | "connection" | "misses"; now: number; until: number }
  | { state: "address" | "unknown" | "off"; now: number };
type Refused = Exclude<ShortLinkAdmission, { state: "open" | "ended" }>;
type Open = Extract<ShortLinkAdmission, { state: "open" }>;

/** This instance's memory (see the top of this file): until when each hour is known to be used. */
const pausedUntil: Record<Hour, number> = { shared: 0, rest: 0 };
let unknownUntil = 0;
/** A link that could not be read or counted a moment ago, by its code. */
const held = new Map<string, number>();
/** A code found ended: no link, or its store gone. */
const ended = new Map<string, number>();
/** Which store each link read here belongs to. */
const owners = new Map<string, { sid: string; until: number }>();
/**
 * A store found resting, by its id: refused from memory until `until`; `wait` is how long it was kept the last time;
 * `off` when its links are turned off (answered with the static page, not as resting).
 */
const resting = new Map<string, { until: number; wait: number; off?: boolean }>();
const known = new Map<string, number>();
/** A connection over its share of a store's day, by the address and the store's id. */
const refusedConnections = new Map<string, number>();
/**
 * Per address: the lookups it made this instance leave in the shared hour (`n`: a code nobody has, a store gone, a link
 * refused for its connection, a store read nobody paid), counted until `until`; and its lookups still in flight, each
 * held until when at the most (`flying`), taken before the count is awaited, so a burst sent at once cannot pass the cap
 * (Claude 2's focal return on #3330, 9 November 2026).
 */
const misses = new Map<string, { n: number; until: number; flying: number[] }>();
/** The longest a lookup in flight holds its address's place: the minute this instance waits after a count it could not read. */
const FLIGHT_MS = SHORT_LINK_UNKNOWN_PAUSE_MS;

/** Forgets this instance's memory (the tests, between cases). */
export function forgetShortLinkOpenMemory(): void {
  pausedUntil.shared = 0;
  pausedUntil.rest = 0;
  unknownUntil = 0;
  for (const map of [held, ended, owners, resting, known, refusedConnections, misses]) map.clear();
}

/** Remembers `value` under `key`, the oldest forgotten past `most`. */
function remember<V>(map: Map<string, V>, key: string, value: V, most: number): void {
  map.delete(key);
  if (map.size >= most) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

/** When `key` is remembered until at `now`, or null; forgotten once its time is past. */
function until(map: Map<string, number>, key: string, now: number): number | null {
  const at = map.get(key);
  if (at === undefined) return null;
  if (at > now) return at;
  map.delete(key);
  return null;
}
const holds = (map: Map<string, number>, key: string, now: number) => until(map, key, now) !== null;

/** The store a link read here belongs to, while remembered. */
function ownerOf(code: string, now: number): string | null {
  const owner = owners.get(code);
  if (!owner) return null;
  if (owner.until > now) return owner.sid;
  owners.delete(code);
  return null;
}

const nextDay = (now: number) => (Math.floor(now / 86_400_000) + 1) * 86_400_000;

/** What `address` has here at `now`, its time past forgotten; null when nothing. */
function missesOf(address: string, now: number): { n: number; until: number; flying: number[] } | null {
  const seen = misses.get(address);
  if (!seen) return null;
  if (seen.until <= now) {
    seen.n = 0;
    seen.until = 0;
  }
  seen.flying = seen.flying.filter((end) => end > now);
  if (seen.n === 0 && seen.flying.length === 0) {
    misses.delete(address);
    return null;
  }
  return seen;
}

/**
 * Until when `address` may look up no more codes this instance does not know; "flying" while its lookups in flight
 * would take it to the cap (refused for a moment, nothing sent); null while it may.
 */
function missedUntil(address: string, now: number): number | "flying" | null {
  const seen = missesOf(address, now);
  if (!seen) return null;
  if (seen.n >= SHORT_LINK_MISSES_PER_ADDRESS) return seen.until;
  return seen.n + seen.flying.length >= SHORT_LINK_MISSES_PER_ADDRESS ? "flying" : null;
}

/** A lookup for `address` about to be counted: its place taken before anything is awaited (memory only). */
function takeMiss(address: string, now: number): void {
  const seen = missesOf(address, now) ?? { n: 0, until: 0, flying: [] };
  seen.flying.push(now + FLIGHT_MS);
  remember(misses, address, seen, SHORT_LINK_TIRED_KEPT);
}

/** That lookup ended: its place given back, and, when it left units in the shared hour (`kept`), counted toward the cap. */
function settleMiss(address: string, now: number, kept: boolean): void {
  const seen = missesOf(address, now);
  if (seen) seen.flying.shift();
  if (!kept) return;
  const counted = seen ?? { n: 0, until: 0, flying: [] };
  if (counted.n === 0) counted.until = now + SHORT_LINK_MISS_WINDOW_MS;
  counted.n += 1;
  remember(misses, address, counted, SHORT_LINK_TIRED_KEPT);
}

/** Exactly the answers asked for, ending with INCR's count, a whole number of at least 1, and EXPIRE's 1; null for anything else. */
function countOf(reply: unknown, length: number): number | null {
  if (!Array.isArray(reply)) return null;
  const size = Object.getOwnPropertyDescriptor(reply, "length");
  if (!size || !Object.hasOwn(size, "value") || size.value !== length) return null;
  const count = Object.getOwnPropertyDescriptor(reply, String(length - 2));
  const expire = Object.getOwnPropertyDescriptor(reply, String(length - 1));
  if (!count || !Object.hasOwn(count, "value") || !Number.isSafeInteger(count.value) || count.value < 1) return null;
  if (!expire || !Object.hasOwn(expire, "value") || expire.value !== 1) return null;
  return count.value as number;
}

/**
 * One open counted in `hour`, under `key`, after `first` (sent in the same pipeline): its count, or null when it
 * cannot be read (this instance then waits before counting again). Past the hour's figure, this instance waits a
 * minute before counting in that hour again.
 */
async function count(hour: Hour, key: string, now: number, first: (string | number)[][] = [], units = 1): Promise<number | null> {
  let seen: number | null = null;
  try {
    const add: (string | number)[] = units === 1 ? ["INCR", key] : ["INCRBY", key, units];
    seen = countOf(await redisPipeline([...first, add, ["EXPIRE", key, SHORT_LINK_UNPAID_KEY_SECONDS]]), first.length + 2);
  } catch {
    seen = null;
  }
  if (seen === null) unknownUntil = now + SHORT_LINK_UNKNOWN_PAUSE_MS;
  else if (seen > LIMIT[hour]) pausedUntil[hour] = Math.min(now + SHORT_LINK_USED_UP_PAUSE_MS, hourEnd(now));
  else pausedUntil[hour] = 0;
  return seen;
}

/** Whether this open may read the database, decided before anything is read. */
export async function admitShortLinkOpen(code: string, { address, now = Date.now() }: { address: string; now?: number }): Promise<ShortLinkAdmission> {
  if (holds(ended, code, now)) return { state: "ended", now };
  if (holds(held, code, now)) return { state: "unknown", now };
  const owner = ownerOf(code, now);
  const rest = owner === null ? undefined : resting.get(owner);
  if (owner !== null) {
    const refused = until(refusedConnections, `${address}|${owner}`, now);
    if (refused !== null) return { state: "connection", now, until: refused };
    if (rest && rest.until > now) return rest.off ? { state: "off", now } : { state: "tired", now, until: rest.until };
  }
  // An address that looked up many codes nobody has here looks up no more it does not know, so a few addresses
  // cannot fill the hour every store's links are looked up in; a link whose store this instance knows still opens.
  // Every lookup that leaves units in the shared hour counts toward the cap (a code nobody has, a store gone, a link
  // refused for its connection), and one in flight holds its place, so a burst sent at once cannot pass it.
  if (owner === null) {
    const missedTill = missedUntil(address, now);
    if (missedTill === "flying") return { state: "unknown", now };
    if (missedTill !== null) return { state: "misses", now, until: missedTill };
  }
  if (!withinLocalLimit("short-link-open", address, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_ADDRESS_WINDOW_MS, now)) return { state: "address", now };
  if (rest) {
    // A store found resting, due to be asked again: on its own time, counted in the resting hour before it is read,
    // never in the hour every other store's links need. That hour used, it rests here until this instance counts
    // in it again, nothing sent.
    if (now < pausedUntil.rest) {
      rest.until = pausedUntil.rest;
      return rest.off ? { state: "off", now } : { state: "tired", now, until: rest.until };
    }
    if (now < unknownUntil || !isRedisConfigured()) return { state: "unknown", now };
    const key = keyOf("rest", now);
    const seen = await count("rest", key, now);
    if (seen === null) return { state: "unknown", now };
    if (seen > LIMIT.rest) {
      rest.until = pausedUntil.rest;
      return rest.off ? { state: "off", now } : { state: "tired", now, until: rest.until };
    }
    return { state: "open", hour: "rest", key, address, now, miss: false };
  }
  const isKnown = holds(known, code, now);
  // A used hour stays used until it ends; this instance only waits a minute before counting again.
  if (now < pausedUntil.shared && !isKnown) return { state: "hour", now, until: hourEnd(now) };
  if (now < unknownUntil || !isRedisConfigured()) return { state: "unknown", now };
  const key = keyOf("shared", now);
  // A link whose store this instance does not know takes its address's place before the count is awaited.
  const miss = owner === null;
  if (miss) takeMiss(address, now);
  const refuse = (refused: Refused): Refused => {
    if (miss) settleMiss(address, now, false);
    return refused;
  };
  const seen = await count("shared", key, now);
  if (seen === null) return refuse({ state: "unknown", now });
  if (seen > LIMIT.shared) {
    // The hour is used: a link its store paid for here a moment ago is still read, counted, up to its own figure past
    // the hour's; its store pays, and the count is given back. One that ends unpaid stays counted.
    if (isKnown && seen <= LIMIT.shared + KNOWN_LIMIT) return { state: "open", hour: "shared", key, address, now, miss };
    return refuse({ state: "hour", now, until: hourEnd(now) });
  }
  return { state: "open", hour: "shared", key, address, now, miss };
}

/**
 * A code whose link was not found ("missing", answered as ended, and so remembered here), or could not be read
 * ("unreadable", refused, and so remembered for a moment): an unpaid read, which stays where it was counted.
 */
export function shortLinkNotPaid(code: string, why: "missing" | "unreadable", admission: Open, now = Date.now()): void {
  known.delete(code);
  if (why === "missing") remember(ended, code, now + SHORT_LINK_ENDED_MS, SHORT_LINK_TIRED_KEPT);
  else remember(held, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
  // Its unit stays in the hour either way, so it counts toward its address's cap.
  if (admission.miss) settleMiss(admission.address, now, true);
}

/**
 * The store a found link belongs to, paying for this open; null when it has none (the link is then answered as
 * ended, the open counted in the hour); or the refusal to send when it does not pay.
 */
export async function payShortLinkOpen(code: string, link: { sid: string; statsId: string }, admission: Open, now = Date.now()): Promise<Store | null | Response> {
  // Whether this lookup left units in the shared hour: only a store that paid, or an open moved to the resting hour (its
  // unit given back), leaves none; everything else counts toward the address's cap.
  const outcome = { kept: true };
  try {
    return await payOpen(code, link, admission, now, outcome);
  } finally {
    if (admission.miss) settleMiss(admission.address, now, outcome.kept);
  }
}

async function payOpen(
  code: string, link: { sid: string; statsId: string }, admission: Open, now: number, outcome: { kept: boolean },
): Promise<Store | null | Response> {
  remember(owners, code, { sid: link.sid, until: now + SHORT_LINK_OWNER_MS }, SHORT_LINK_TIRED_KEPT);
  if (admission.hour === "shared") {
    // What this instance learned of the store since it was counted, from another of its links: refused at once,
    // nothing more read. A resting store's open is moved to the resting hour, always out of the one every other
    // store's links need; a connection's stays where it was counted.
    const rest = resting.get(link.sid);
    if (rest && rest.until > now) {
      known.delete(code);
      outcome.kept = false;
      // Its link's store kept here a day, so each of a resting store's links is looked up once a day on this instance.
      remember(owners, code, { sid: link.sid, until: now + SHORT_LINK_RESTING_OWNER_MS }, SHORT_LINK_TIRED_KEPT);
      await countResting(now, [["DECR", admission.key], ["EXPIRE", admission.key, SHORT_LINK_UNPAID_KEY_SECONDS]]);
      return shortLinkRefusal(rest.off ? { state: "off", now } : { state: "tired", now, until: rest.until });
    }
    const refused = until(refusedConnections, `${admission.address}|${link.sid}`, now);
    if (refused !== null) {
      known.delete(code);
      return shortLinkRefusal({ state: "connection", now, until: refused });
    }
  }
  // The store's own counts (SHORT_LINK_STORE_READS_PER_HOUR, the owner's decision 14 on #3330, and Claude 2's focal):
  // this open takes a place among the store's opens in flight, which lapses by itself SHORT_LINK_FLIGHT_MS later, and
  // reads how many of the store's reads this hour it did not pay for; both before its record can be read, a cold
  // burst as much as any other. The place is given back however the open ends (ZREM: one not there changes nothing);
  // only a read the store itself could not pay for is added to the hour's.
  const flightKey = shortLinkStoreFlightKey(link.sid);
  const hourKey = shortLinkStoreHourKey(link.sid, now);
  const place = `${now}:${randomBytes(6).toString("hex")}`;
  const capBack: (string | number)[][] = [["ZREM", flightKey, place]];
  const kept: (string | number)[][] = [...capBack, ["INCR", hourKey], ["EXPIRE", hourKey, SHORT_LINK_UNPAID_KEY_SECONDS]];
  // An open the store does not pay for: back in the hour it was counted in, which its refund may have left, after
  // `first` (sent with it).
  const unpaid = async (first: (string | number)[][] = []): Promise<void> => {
    known.delete(code);
    await count(admission.hour, admission.key, now, first, UNPAID_UNITS[admission.hour]);
  };
  const unknown = async (): Promise<Response> => {
    remember(held, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
    resting.delete(link.sid);
    await unpaid(capBack);
    return shortLinkRefusal({ state: "unknown", now });
  };
  const commands: (string | number)[][] = [
    storeIdCommand(link.sid), ["GET", shortLinkRestKey(link.sid)], ["DECR", admission.key], ["EXPIRE", admission.key, SHORT_LINK_UNPAID_KEY_SECONDS],
    ["ZREMRANGEBYSCORE", flightKey, 0, now - SHORT_LINK_FLIGHT_MS], ["ZADD", flightKey, now, place], ["ZCARD", flightKey],
    ["EXPIRE", flightKey, 2 * SHORT_LINK_FLIGHT_MS / 1000], ["GET", hourKey],
  ];
  let replies: unknown[];
  try {
    // The refund may have been made, or not: counted again below, never left out of the hour.
    replies = await redisPipeline(commands);
  } catch {
    return unknown();
  }
  if (!Array.isArray(replies) || replies.length !== commands.length) return unknown();
  // The store's own counts, read exactly; anything else is a count that cannot be told, refused, nothing read.
  const inFlight = replies[6];
  const unpaidReads = replies[8] === null ? 0 : typeof replies[8] === "string" && /^[0-9]{1,9}$/.test(replies[8]) ? Number(replies[8]) : null;
  if (replies[5] !== 1 || !Number.isSafeInteger(inFlight) || (inFlight as number) < 1 || replies[7] !== 1 || unpaidReads === null) return unknown();
  const ref = typeof replies[0] === "string" && replies[0] ? replies[0] : null;
  // Whether the store is in the list of stores that pay (one SISMEMBER by the reference its id names): true, false, or
  // null when that cannot be told. Asked at most once, only where it decides something.
  let paying: boolean | null | undefined;
  const isPaying = async (): Promise<boolean | null> => {
    if (paying !== undefined) return paying;
    paying = null;
    if (!ref) return paying;
    try {
      const reply = await redisPipeline([["SISMEMBER", PAYING_INDEX, ref]]);
      const member = Array.isArray(reply) && reply.length === 1 ? reply[0] : null;
      paying = member === 1 ? true : member === 0 ? false : null;
    } catch {
      paying = null;
    }
    return paying;
  };
  const read = readRestMark(replies[1]);
  // A store found resting is refused without its record read; once its resting moment is past, only the one open that
  // takes the check, site-wide, reads it again, so the opens in flight when it turns due do not all read it.
  let mark = restMarkOf(replies[1], now);
  // Turned off: a store without a paid plan that has rested SHORT_LINK_OFF_AFTER_MS without a gap, its record saying
  // so less than a day ago. Nothing of its record is read; only whether it pays now, so a store that pays again opens at
  // its next open even when the moment it paid could not take its mark away (lib/short-link-rest.ts), and a list that
  // cannot be read is refused as unknown, never answered as turned off. Too old a reading: one open reads it again.
  const off = offState(read, now);
  let paysAgain = false;
  if (off === "off") {
    const nowPaying = await isPaying();
    if (nowPaying === null) return unknown();
    if (!nowPaying) {
      outcome.kept = false;
      return offRefused(link.sid, code, now, capBack);
    }
    paysAgain = true;
  }
  if (off === "stale" || paysAgain) mark = "due";
  if (mark === "resting") {
    outcome.kept = false;
    return restRefused(link.sid, code, now, null, capBack);
  }
  // Past the store's own counts: refused with nothing of its record read, its place given back, unless the store pays
  // and has had fewer than the figure's unpaid reads this hour (a paying store with room pays for each read). Refused,
  // it is marked resting a minute where it had no mark (NX, so a mark that says more is never written over) and kept
  // so in this instance's memory, so the opens after it send nothing (Claude 2's focal on #3330, HIGH 1).
  if (inFlight as number + unpaidReads > SHORT_LINK_STORE_READS_PER_HOUR) {
    const paysWithRoom = unpaidReads < SHORT_LINK_STORE_READS_PER_HOUR && (await isPaying()) === true;
    if (!paysWithRoom) {
      outcome.kept = false;
      return restRefused(link.sid, code, now, mark === null ? "short" : null, capBack);
    }
  }
  let checking = false;
  if (mark === "due") {
    let took: unknown = null;
    try {
      const reply = await redisPipeline([["SET", shortLinkRestCheckKey(link.sid), "1", "NX", "EX", SHORT_LINK_TIRED_MS / 1000]]);
      took = Array.isArray(reply) && reply.length === 1 ? reply[0] : null;
    } catch {
      took = null;
    }
    // Another open is asking, or the check could not be taken: still resting, nothing read.
    if (took !== "OK") {
      outcome.kept = false;
      return restRefused(link.sid, code, now, null, capBack);
    }
    checking = true;
  }
  let store: Store | null | "unknown";
  try {
    store = await storeForIdRefRead(link.sid, replies[0]);
  } catch {
    return unknown();
  }
  // A record that cannot be read is not a store gone.
  if (store === "unknown") return unknown();
  if (!store || store.statsId !== link.statsId) {
    resting.delete(link.sid);
    remember(ended, code, now + SHORT_LINK_ENDED_MS, SHORT_LINK_TIRED_KEPT);
    await unpaid(capBack);
    return null;
  }
  const why = await takePublicRequestWhy(store, "public", now, SHORT_LINK_OPEN_UNITS).catch(() => "unknown" as const);
  if (why === "ok") {
    outcome.kept = false;
    resting.delete(link.sid);
    remember(known, code, now + SHORT_LINK_KNOWN_MS, SHORT_LINK_KNOWN_KEPT);
    // Its place given back; a store that rested and pays again has its mark taken away too, so its links open on every
    // instance that does not remember it resting, and the studio is told when they had been turned off (best effort:
    // a place not given back lapses SHORT_LINK_FLIGHT_MS later, a mark left only asks the store again later).
    await redisPipeline(checking ? [...capBack, ...backOnCommands(link.sid, turnedOffAt(replies[1], now), now)] : capBack).catch(() => {});
    return store;
  }
  // Only the store's own refusal marks it resting and is kept in its hour's unpaid reads; best effort, a mark not
  // written is read again next time.
  if (why === "store") {
    outcome.kept = false;
    return restRefused(link.sid, code, now, { store, before: read }, kept);
  }
  if (why === "connection") {
    // That connection alone, for that store, until its share starts again: the day's end, or the store's window's
    // end if it renews first (lib/traffic.ts keeps the share by window and day). Nobody else is refused the link.
    resting.delete(link.sid);
    let end = nextDay(now);
    try {
      const window = allowanceWindow(store, now);
      if (window && window.end > now) end = Math.min(end, window.end);
    } catch {
      // The day's end, then.
    }
    remember(refusedConnections, `${admission.address}|${link.sid}`, end, SHORT_LINK_TIRED_KEPT);
    await unpaid(capBack);
    return shortLinkRefusal({ state: "connection", now, until: end });
  }
  return unknown();
}

/** What a resting mark is written from: the store's record just read, with what its mark said before; or "short". */
type MarkFrom = { store: Store; before: { since: number | null; read: number | null } | null } | "short";

/**
 * A store that cannot take one more request: every link of it refused from this instance's memory, for longer each
 * time it is found still resting, and each link's store kept here a day. The open is counted in the resting hour,
 * never the shared one (Claude 2's first cost review of #3330: a store that cannot pay never uses the hour every other
 * store's links need), after `first` (sent with it). `write` writes the store's resting mark in the same pipeline:
 * from its record (restMark), SHORT_LINK_TIRED_MS on while the resting hour has room and SHORT_LINK_TIRED_MAX_MS once it
 * is used; or "short", a store past its own counts with no mark, a minute on and only where none is (NX). A store
 * without a paid plan whose record says it has rested SHORT_LINK_OFF_AFTER_MS without a gap is answered turned off.
 */
async function restRefused(sid: string, code: string, now: number, write: MarkFrom | null, first: (string | number)[][]): Promise<Response> {
  const restUsed = now < pausedUntil.rest;
  const markMs = restUsed ? SHORT_LINK_TIRED_MAX_MS : SHORT_LINK_TIRED_MS;
  const written = write === null ? null : write === "short"
    ? { command: ["SET", shortLinkRestKey(sid), String(now + SHORT_LINK_TIRED_MS), "NX", "EX", SHORT_LINK_UNPAID_KEY_SECONDS] as (string | number)[], off: false }
    : restMark(sid, write, now, markMs);
  if (written?.off) return offRefused(sid, code, now, [...first, written.command]);
  const before = resting.get(sid);
  const wait = before && !before.off ? Math.min(before.wait * 2, SHORT_LINK_TIRED_MAX_MS) : SHORT_LINK_TIRED_MS;
  remember(resting, sid, { until: now + wait, wait }, SHORT_LINK_TIRED_KEPT);
  remember(owners, code, { sid, until: now + SHORT_LINK_RESTING_OWNER_MS }, SHORT_LINK_TIRED_KEPT);
  known.delete(code);
  const used = await countResting(now, written ? [...first, written.command] : first);
  // The resting hour found used by this very count: the store rests the longer time too (best effort; a mark kept
  // the shorter time only asks the store again sooner, one open site-wide, inside its own counts).
  if (write !== null && write !== "short" && used && !restUsed) await redisPipeline([restMark(sid, write, now, SHORT_LINK_TIRED_MAX_MS).command]).catch(() => {});
  return shortLinkRefusal({ state: "tired", now, until: now + wait });
}

/**
 * A store's resting mark, from its record just read. A store with a paid plan rests until its window ends, when its
 * own requests come back (at least `ms` on, at most SHORT_LINK_PAID_REST_MAX_MS), kept that long and two hours more; a
 * change to its plan takes the mark away (lib/short-link-rest.ts). A store without one rests `ms` on, and the mark says
 * since when it has rested without a gap (carried from its last mark when that one's record was read less than
 * SHORT_LINK_OFF_KEEP_SECONDS ago, the mark's own life, or now; a store turned off is read again once a reading is
 * SHORT_LINK_OFF_CONFIRM_MS old, so a store that keeps resting keeps its since) and that its record said so now, kept SHORT_LINK_OFF_KEEP_SECONDS: once that is
 * SHORT_LINK_OFF_AFTER_MS, `off`, and its links are turned off (Claude 2's focal on #3330, MEDIUM 3).
 */
function restMark(sid: string, { store, before }: Exclude<MarkFrom, "short">, now: number, ms: number): { command: (string | number)[]; off: boolean } {
  let paid = false;
  try {
    paid = standingOf(store, now / 1000) === "paid";
  } catch {
    paid = false;
  }
  if (paid) {
    let until = now + ms;
    try {
      const window = allowanceWindow(store, now);
      if (window && window.end > until) until = Math.min(window.end, now + SHORT_LINK_PAID_REST_MAX_MS);
    } catch {
      // `ms` on, then.
    }
    return { command: ["SET", shortLinkRestKey(sid), String(until), "EX", Math.ceil((until - now) / 1000) + SHORT_LINK_UNPAID_KEY_SECONDS], off: false };
  }
  const carried = before && before.since !== null && before.read !== null && before.since <= now && now - before.read <= SHORT_LINK_OFF_KEEP_SECONDS * 1000;
  const since = carried ? (before.since as number) : now;
  return {
    command: ["SET", shortLinkRestKey(sid), `${now + ms}:${since}:${now}`, "EX", SHORT_LINK_OFF_KEEP_SECONDS],
    off: now - since >= SHORT_LINK_OFF_AFTER_MS,
  };
}

/**
 * A store whose links are turned off: every link of it answered off from this instance's memory for
 * SHORT_LINK_TIRED_MAX_MS, each link's store kept a day, the open counted in the resting hour after `first`. Its mark
 * is never kept longer for it: only a reading of the store's record does that.
 */
async function offRefused(sid: string, code: string, now: number, first: (string | number)[][]): Promise<Response> {
  remember(resting, sid, { until: now + SHORT_LINK_TIRED_MAX_MS, wait: SHORT_LINK_TIRED_MAX_MS, off: true }, SHORT_LINK_TIRED_KEPT);
  remember(owners, code, { sid, until: now + SHORT_LINK_RESTING_OWNER_MS }, SHORT_LINK_TIRED_KEPT);
  known.delete(code);
  await countResting(now, first);
  return shortLinkRefusal({ state: "off", now });
}

/**
 * What a store's resting mark says at `now`: "resting" until the moment it holds (anything else written there too, so
 * a mark that cannot be read never reads the store), "due" once that moment is past, null when there is none.
 */
function restMarkOf(reply: unknown, now: number): "resting" | "due" | null {
  if (reply === null || reply === undefined) return null;
  const read = readRestMark(reply);
  if (!read) return "resting";
  return read.until <= now ? "due" : "resting";
}

/**
 * An open of a resting store that no store pays for, counted in the resting hour after `first` (sent with it), never in
 * the shared hour. The resting hour known to be used here: `first` alone is sent (the store's mark, or the open's
 * refund off the shared hour), nothing counted. True when the resting hour is used, or could not be counted.
 */
async function countResting(now: number, first: (string | number)[][]): Promise<boolean> {
  if (now < pausedUntil.rest) {
    if (first.length > 0) await redisPipeline(first).catch(() => {});
    return true;
  }
  const seen = await count("rest", keyOf("rest", now), now, first);
  return seen === null || seen > LIMIT.rest;
}

/** A moment in words, the time zone spelled out (WCAG 3.1.4). */
const at = (ms: number) => `${statusTime(ms)} (Coordinated Universal Time)`;

const refusal = (status: number, text: string, retrySeconds: number) =>
  new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8", "Content-Language": "en-US", "Cache-Control": "no-store",
      "Retry-After": String(Math.max(1, Math.ceil(retrySeconds))),
    },
  });

/**
 * The page a link of a store whose links are turned off answers with: short, static, the same for every link, in
 * plain US English, readable without styles or script; dark text on white (and light on near black in a dark theme),
 * well over 7:1 either way; one heading and one link that says where it goes.
 */
const OFF_PAGE = [
  "<!doctype html>",
  '<html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  "<title>This link is turned off - Marktmorgen</title>",
  "<style>body{margin:0;padding:2rem 1rem;font:1.125rem/1.6 system-ui,sans-serif;color:#111;background:#fff}main{max-width:40rem;margin:0 auto}",
  "a{color:inherit;display:inline-block;min-height:44px;padding:.5rem 0}@media (prefers-color-scheme:dark){body{color:#f5f5f5;background:#111}}</style>",
  "</head><body><main><h1>This link is turned off</h1>",
  "<p>This short link is turned off, because the store that shared it has not had a paid plan for more than 30 days.</p>",
  `<p><a href="${SITE_URL}/">Go to the Marktmorgen home page</a></p></main></body></html>`,
].join("");

/**
 * What a refused open says: never a redirect. Never kept by the CDN, except the page of a link turned off, which is
 * the same for everybody and kept CACHE_SECONDS, as long as a link that opens is.
 */
export function shortLinkRefusal(admission: Refused): Response {
  if (admission.state === "off") {
    return new Response(OFF_PAGE, {
      status: 410,
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Language": "en-US", "Cache-Control": `public, max-age=0, s-maxage=${CACHE_SECONDS}` },
    });
  }
  if (admission.state === "address") {
    return refusal(429, "Too many links were opened from your network in the last few minutes. Try this link again in 10 minutes.", SHORT_LINK_ADDRESS_WINDOW_MS / 1000);
  }
  if (admission.state === "misses") {
    return refusal(
      429,
      `Your network opened too many short links that do not exist or could not be opened for you in the last hour, so new links will not open for you right now. Try this link again after ${at(admission.until)}, or use another network.`,
      (admission.until - admission.now) / 1000,
    );
  }
  if (admission.state === "hour") {
    return refusal(
      503,
      `Short links on this site were opened too many times this hour, so this one is paused for now. Try this link again after ${at(admission.until)}.`,
      (admission.until - admission.now) / 1000,
    );
  }
  if (admission.state === "tired") {
    return refusal(503, "The page this link leads to cannot be opened right now. Try this link again later.", (admission.until - admission.now) / 1000);
  }
  if (admission.state === "connection") {
    return refusal(
      429,
      `Your network opened this store's pages too many times today, so this link will not open for you right now. Try again after ${at(admission.until)}, or use another network.`,
      (admission.until - admission.now) / 1000,
    );
  }
  return refusal(503, "This link could not be opened right now. Try again in a minute.", SHORT_LINK_UNKNOWN_PAUSE_MS / 1000);
}
