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
 *     nothing), and the open is counted in its hour, in one count every
 *     instance shares (SHORT_LINK_COUNT_COMMANDS). Past SHORT_LINK_UNPAID_PER_HOUR
 *     the open is refused, and this instance sends nothing more to the
 *     database for SHORT_LINK_USED_UP_PAUSE_MS, then counts again; meanwhile a
 *     link its store paid for here a moment ago (SHORT_LINK_KNOWN_MS) is still
 *     counted and read, up to SHORT_LINK_KNOWN_UNPAID_PER_HOUR past the
 *     figure, its store paying for it. A count that cannot be read is not room
 *     to read: refused, and this instance waits SHORT_LINK_UNKNOWN_PAUSE_MS
 *     before counting again.
 *   - Once the link is found, the store's id, its resting mark and the open's
 *     refund off the hour it was counted in (DECR with its EXPIRE) go in one
 *     pipeline. The open is then one of the store's public requests
 *     (lib/traffic.ts, takePublicRequestWhy), so its plan pays for it. What
 *     the store does not pay for is counted in that hour again, except:
 *       - the store over its own requests (or a free store without a place):
 *         its resting mark is written for SHORT_LINK_TIRED_MS
 *         (shortLinkRestKey), so its links are refused everywhere without its
 *         record read, and this instance refuses every link of that store from
 *         memory, first for SHORT_LINK_TIRED_MS, then twice as long each time
 *         it is asked again and still rests, up to SHORT_LINK_TIRED_MAX_MS.
 *         The open is counted in the resting hour (shortLinkRestHourKey), not
 *         the shared one; past SHORT_LINK_REST_UNPAID_PER_HOUR it is counted in
 *         the shared hour too. Each store is asked again on its own time,
 *         counted in the resting hour before it is read, so one store waiting
 *         never waits behind another; the resting hour used, it is kept
 *         resting here a minute, nothing sent;
 *       - one connection over its share of the store's day: that connection
 *         alone is refused the store's links, until the day or the store's
 *         window ends, and told so;
 *       - a count that could not be made: refused, and that link answered
 *         from memory for SHORT_LINK_TIRED_MS.
 *
 * So the opens that read and that no store pays for are at most
 * SHORT_LINK_UNPAID_PER_HOUR + SHORT_LINK_KNOWN_UNPAID_PER_HOUR an hour in the
 * shared count and SHORT_LINK_REST_UNPAID_PER_HOUR in the resting one, plus,
 * on each instance, one count a minute while either hour is used or a count is
 * unreadable. A refund that fails leaves the open counted, never the other
 * way. Every refusal says so in plain words, sends nobody anywhere and is
 * never kept by the CDN: it is never shown as "this link ended", and a store's
 * record that cannot be read is refused, never taken for a store gone. The
 * company's month is priced in tests/short-link-open-cap.test.ts and held
 * there as a company cost that is unknown, never zero, per instance, their
 * number unknown (SHORT_LINK_UNPAID_COMPANY_COST, tests/plan-cost-registry.ts);
 * it is not a line of lib/llc-fixed-costs.ts, which feeds
 * CURRENT_COMMERCIAL_TERMS.
 *
 *   nl:slink:open:<hour>   string   the hour's opens not paid by a store, kept two hours
 *   nl:slink:tired:<hour>  string   the hour's opens of stores over their own requests, kept two hours
 *   nl:slink:rest:<sid>    string   "1" while the store could not take one more request, kept SHORT_LINK_TIRED_MS
 */
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
  SHORT_LINK_USED_UP_PAUSE_MS, hourOf, shortLinkRestHourKey, shortLinkRestKey, shortLinkUnpaidKey,
} from "@/lib/short-link-open-rules";

/** The two hours an open no store pays for is counted in: the one every store's links share, and resting stores' own. */
type Hour = "shared" | "rest";
const LIMIT: Record<Hour, number> = { shared: SHORT_LINK_UNPAID_PER_HOUR, rest: SHORT_LINK_REST_UNPAID_PER_HOUR };
const keyOf = (hour: Hour, now: number) => (hour === "shared" ? shortLinkUnpaidKey(now) : shortLinkRestHourKey(now));

/**
 * Room to read, with the hour the open was counted in and its key; "ended" for a code this instance found ended a
 * moment ago, answered as ended with nothing read; or why not, and until when, where that is known.
 */
export type ShortLinkAdmission =
  | { state: "open"; hour: Hour; key: string; address: string; now: number }
  | { state: "ended"; now: number }
  | { state: "hour" | "tired" | "connection"; now: number; until: number }
  | { state: "address" | "unknown"; now: number };
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
/** A store found resting, by its id: refused from memory until `until`; `wait` is how long it was kept the last time. */
const resting = new Map<string, { until: number; wait: number }>();
const known = new Map<string, number>();
/** A connection over its share of a store's day, by the address and the store's id. */
const refusedConnections = new Map<string, number>();

/** Forgets this instance's memory (the tests, between cases). */
export function forgetShortLinkOpenMemory(): void {
  pausedUntil.shared = 0;
  pausedUntil.rest = 0;
  unknownUntil = 0;
  for (const map of [held, ended, owners, resting, known, refusedConnections]) map.clear();
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
async function count(hour: Hour, key: string, now: number, first: (string | number)[][] = []): Promise<number | null> {
  let seen: number | null = null;
  try {
    seen = countOf(await redisPipeline([...first, ["INCR", key], ["EXPIRE", key, SHORT_LINK_UNPAID_KEY_SECONDS]]), first.length + 2);
  } catch {
    seen = null;
  }
  if (seen === null) unknownUntil = now + SHORT_LINK_UNKNOWN_PAUSE_MS;
  else if (seen > LIMIT[hour]) pausedUntil[hour] = Math.min(now + SHORT_LINK_USED_UP_PAUSE_MS, (hourOf(now) + 1) * HOUR_MS);
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
    if (rest && rest.until > now) return { state: "tired", now, until: rest.until };
  }
  if (!withinLocalLimit("short-link-open", address, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_ADDRESS_WINDOW_MS, now)) return { state: "address", now };
  if (rest) {
    // A store found resting, due to be asked again: on its own time, counted in the resting hour before it is read,
    // never in the hour every other store's links need. That hour used, it rests here until this instance counts
    // in it again, nothing sent.
    if (now < pausedUntil.rest) {
      rest.until = pausedUntil.rest;
      return { state: "tired", now, until: rest.until };
    }
    if (now < unknownUntil || !isRedisConfigured()) return { state: "unknown", now };
    const key = keyOf("rest", now);
    const seen = await count("rest", key, now);
    if (seen === null) return { state: "unknown", now };
    if (seen > LIMIT.rest) {
      rest.until = pausedUntil.rest;
      return { state: "tired", now, until: rest.until };
    }
    return { state: "open", hour: "rest", key, address, now };
  }
  const isKnown = holds(known, code, now);
  if (now < pausedUntil.shared && !isKnown) return { state: "hour", now, until: pausedUntil.shared };
  if (now < unknownUntil || !isRedisConfigured()) return { state: "unknown", now };
  const key = keyOf("shared", now);
  const seen = await count("shared", key, now);
  if (seen === null) return { state: "unknown", now };
  if (seen > SHORT_LINK_UNPAID_PER_HOUR) {
    // The hour is used: a link its store paid for here a moment ago is still read, counted, up to its own figure past
    // the hour's; its store pays, and the count is given back. One that ends unpaid stays counted.
    if (isKnown && seen <= SHORT_LINK_UNPAID_PER_HOUR + SHORT_LINK_KNOWN_UNPAID_PER_HOUR) return { state: "open", hour: "shared", key, address, now };
    return { state: "hour", now, until: pausedUntil.shared };
  }
  return { state: "open", hour: "shared", key, address, now };
}

/**
 * A code whose link was not found ("missing", answered as ended, and so remembered here), or could not be read
 * ("unreadable", refused, and so remembered for a moment): an unpaid read, which stays where it was counted.
 */
export function shortLinkNotPaid(code: string, why: "missing" | "unreadable", now = Date.now()): void {
  known.delete(code);
  if (why === "missing") remember(ended, code, now + SHORT_LINK_ENDED_MS, SHORT_LINK_TIRED_KEPT);
  else remember(held, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
}

/**
 * The store a found link belongs to, paying for this open; null when it has none (the link is then answered as
 * ended, the open counted in the hour); or the refusal to send when it does not pay.
 */
export async function payShortLinkOpen(code: string, link: { sid: string; statsId: string }, admission: Open, now = Date.now()): Promise<Store | null | Response> {
  remember(owners, code, { sid: link.sid, until: now + SHORT_LINK_OWNER_MS }, SHORT_LINK_TIRED_KEPT);
  if (admission.hour === "shared") {
    // What this instance learned of the store since it was counted, from another of its links: refused at once,
    // nothing more read. A resting store's open is moved to the resting hour, out of the one every other store's
    // links need, unless the resting hour is used; a connection's stays where it was counted.
    const rest = resting.get(link.sid);
    if (rest && rest.until > now) {
      known.delete(code);
      if (now >= pausedUntil.rest) await countResting(now, [["DECR", admission.key], ["EXPIRE", admission.key, SHORT_LINK_UNPAID_KEY_SECONDS]]);
      return shortLinkRefusal({ state: "tired", now, until: rest.until });
    }
    const refused = until(refusedConnections, `${admission.address}|${link.sid}`, now);
    if (refused !== null) {
      known.delete(code);
      return shortLinkRefusal({ state: "connection", now, until: refused });
    }
  }
  // An open the store does not pay for: back in the hour it was counted in, which its refund may have left, after
  // `first` (sent with it).
  const unpaid = async (first: (string | number)[][] = []): Promise<void> => {
    known.delete(code);
    await count(admission.hour, admission.key, now, first);
  };
  const unknown = async (): Promise<Response> => {
    remember(held, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
    resting.delete(link.sid);
    await unpaid();
    return shortLinkRefusal({ state: "unknown", now });
  };
  const commands: (string | number)[][] = [
    storeIdCommand(link.sid), ["GET", shortLinkRestKey(link.sid)], ["DECR", admission.key], ["EXPIRE", admission.key, SHORT_LINK_UNPAID_KEY_SECONDS],
  ];
  let replies: unknown[];
  try {
    // The refund may have been made, or not: counted again below, never left out of the hour.
    replies = await redisPipeline(commands);
  } catch {
    return unknown();
  }
  if (!Array.isArray(replies) || replies.length !== commands.length) return unknown();
  if (replies[1] === "1") return restRefused(link.sid, code, now, false);
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
    await unpaid();
    return null;
  }
  const why = await takePublicRequestWhy(store, "public", now, SHORT_LINK_OPEN_UNITS).catch(() => "unknown" as const);
  if (why === "ok") {
    resting.delete(link.sid);
    remember(known, code, now + SHORT_LINK_KNOWN_MS, SHORT_LINK_KNOWN_KEPT);
    return store;
  }
  // Only the store's own refusal marks it resting; best effort, a mark not written is read again next time.
  if (why === "store") return restRefused(link.sid, code, now, true);
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
    await unpaid();
    return shortLinkRefusal({ state: "connection", now, until: end });
  }
  return unknown();
}

/**
 * A store that cannot take one more request: every link of it refused from this instance's memory, for longer each
 * time it is found still resting. The open is counted in the resting hour, never the shared one, until the resting
 * hour is used; past it, or when it cannot be counted, in the shared hour too. `mark` writes the store's resting mark,
 * in the same pipeline.
 */
async function restRefused(sid: string, code: string, now: number, mark: boolean): Promise<Response> {
  const before = resting.get(sid);
  const wait = before ? Math.min(before.wait * 2, SHORT_LINK_TIRED_MAX_MS) : SHORT_LINK_TIRED_MS;
  remember(resting, sid, { until: now + wait, wait }, SHORT_LINK_TIRED_KEPT);
  known.delete(code);
  const first: (string | number)[][] = mark ? [["SET", shortLinkRestKey(sid), "1", "EX", SHORT_LINK_TIRED_MS / 1000]] : [];
  await countResting(now, first);
  return shortLinkRefusal({ state: "tired", now, until: now + wait });
}

/**
 * An open of a resting store that no store pays for, counted in the resting hour after `first` (sent with it); past
 * that hour's figure, or when it cannot be counted, in the shared hour too. The resting hour known to be used here:
 * straight to the shared hour, after `first`, one pipeline.
 */
async function countResting(now: number, first: (string | number)[][]): Promise<void> {
  const restUsed = now < pausedUntil.rest;
  const seen = restUsed ? null : await count("rest", keyOf("rest", now), now, first);
  if (seen === null || seen > LIMIT.rest) await count("shared", keyOf("shared", now), now, restUsed ? first : []);
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

/** What a refused open says: never a redirect, never kept by the CDN. */
export function shortLinkRefusal(admission: Refused): Response {
  if (admission.state === "address") {
    return refusal(429, "Too many links were opened from your network in the last few minutes. Try this link again in 10 minutes.", SHORT_LINK_ADDRESS_WINDOW_MS / 1000);
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
