/**
 * What it takes to open a short link (app/l/[code]/route.ts), so that what
 * an open costs always has a ceiling (Claude 5, 7 November 2026), without
 * one store's traffic or one connection taking the other stores' links down
 * (9 November 2026). The CDN keeps an answer for one exact address only: a
 * code nobody has, or a link with a query of its own each time, reaches the
 * function and the database.
 *
 *   - Before anything is read: one address may make this instance answer
 *     SHORT_LINK_OPENS_PER_ADDRESS opens in SHORT_LINK_ADDRESS_WINDOW_MS
 *     (lib/local-limit.ts, which costs nothing), and the open is counted in
 *     its hour, in one count every instance shares (SHORT_LINK_COUNT_COMMANDS).
 *     Past SHORT_LINK_UNPAID_PER_HOUR the open is refused, and this instance
 *     sends nothing more to the database for SHORT_LINK_USED_UP_PAUSE_MS,
 *     then counts again; meanwhile a link its store paid for here a moment ago
 *     (SHORT_LINK_KNOWN_MS) is still answered, its store paying for it. A
 *     count that cannot be read is not room to read: refused, and this
 *     instance waits SHORT_LINK_UNKNOWN_PAUSE_MS before counting again.
 *   - Once the link is found, the store's id, its resting mark and the open's
 *     refund off the hour (DECR with its EXPIRE) go in one pipeline. The open
 *     is then one of the store's public requests (lib/traffic.ts,
 *     takePublicRequestWhy), so its plan pays for it. What the store does not
 *     pay for is counted in the hour again, except a refusal for the store's
 *     own requests, which at most SHORT_LINK_REST_REFUNDS_PER_MINUTE times a
 *     minute on this instance stays off it, so a store over its limit does
 *     not use the hour every other store's links need:
 *       - the store over its own requests (or a free store without a place):
 *         its resting mark is written for SHORT_LINK_TIRED_MS (shortLinkRestKey),
 *         so its links are refused everywhere without its record read, and
 *         this instance answers that link from memory meanwhile;
 *       - one connection over its share of the store's day: that connection
 *         alone is refused for the link (SHORT_LINK_CONNECTION_MS), told so,
 *         and everybody else still opens it;
 *       - a count that could not be made: refused, and that link answered
 *         from memory for SHORT_LINK_TIRED_MS.
 *
 * So the opens that read and that no store pays for are at most
 * SHORT_LINK_UNPAID_PER_HOUR an hour in the shared count, plus, on each
 * instance, one store refusal a minute (one read and one SET), one count a
 * minute while the hour is used or a count is unreadable, and one read per
 * link it found paid that is gone when next asked for. A refund that fails
 * leaves the open counted, never the other way. Every refusal says so in
 * plain words, sends nobody anywhere and is never kept by the CDN: it is
 * never shown as "this link ended". The company's month is priced in
 * tests/short-link-open-cap.test.ts and held there as a company cost that is
 * unknown, never zero, per instance, their number unknown
 * (SHORT_LINK_UNPAID_COMPANY_COST, tests/plan-cost-registry.ts); it is not a
 * line of lib/llc-fixed-costs.ts, which feeds CURRENT_COMMERCIAL_TERMS.
 *
 *   nl:slink:open:<hour>   string   the hour's opens not paid by a store, kept two hours
 *   nl:slink:rest:<sid>    string   "1" while the store could not take one more request, kept SHORT_LINK_TIRED_MS
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLocalLimit } from "@/lib/local-limit";
import { takePublicRequestWhy } from "@/lib/traffic";
import { statusTime } from "@/lib/status-page";
import { type Store, storeForIdRef, storeIdCommand } from "@/lib/store";
import {
  HOUR_MS, SHORT_LINK_ADDRESS_WINDOW_MS, SHORT_LINK_CONNECTION_MS, SHORT_LINK_KNOWN_KEPT, SHORT_LINK_KNOWN_MS, SHORT_LINK_OPEN_UNITS,
  SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_REST_REFUNDS_PER_MINUTE, SHORT_LINK_TIRED_KEPT, SHORT_LINK_TIRED_MS, SHORT_LINK_UNKNOWN_PAUSE_MS,
  SHORT_LINK_UNPAID_KEY_SECONDS, SHORT_LINK_UNPAID_PER_HOUR, SHORT_LINK_USED_UP_PAUSE_MS, hourOf, shortLinkRestKey, shortLinkUnpaidKey,
} from "@/lib/short-link-open-rules";

/**
 * Room to read, with the hour's key the open was counted in (null for a link its store paid for here a moment ago,
 * answered while the hour is used, not counted); or why not, and until when for a used hour.
 */
export type ShortLinkAdmission =
  | { state: "open"; key: string | null; address: string; now: number }
  | { state: "hour"; now: number; until: number }
  | { state: "address" | "unknown" | "tired" | "connection"; now: number };
type Refused = Exclude<ShortLinkAdmission, { state: "open" }>;

/** This instance's memory (see the top of this file). */
let pausedUntil = 0;
let unknownUntil = 0;
let refundMinute = -1;
let refundsThisMinute = 0;
const tired = new Map<string, number>();
const known = new Map<string, number>();
const refusedConnections = new Map<string, number>();

/** Forgets this instance's memory (the tests, between cases). */
export function forgetShortLinkOpenMemory(): void {
  pausedUntil = 0;
  unknownUntil = 0;
  refundMinute = -1;
  refundsThisMinute = 0;
  tired.clear();
  known.clear();
  refusedConnections.clear();
}

/** Remembers `key` until `until`, the oldest forgotten past `most`. */
function remember(map: Map<string, number>, key: string, until: number, most: number): void {
  map.delete(key);
  if (map.size >= most) map.delete(map.keys().next().value as string);
  map.set(key, until);
}

/** Whether `key` is remembered at `now`; forgotten once its time is past. */
function holds(map: Map<string, number>, key: string, now: number): boolean {
  const until = map.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  map.delete(key);
  return false;
}

/** Exactly the two answers asked for: the count, a whole number of at least 1, and EXPIRE's 1; null for anything else. */
function countOf(reply: unknown): number | null {
  if (!Array.isArray(reply)) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value") || length.value !== 2) return null;
  const count = Object.getOwnPropertyDescriptor(reply, "0");
  const expire = Object.getOwnPropertyDescriptor(reply, "1");
  if (!count || !Object.hasOwn(count, "value") || !Number.isSafeInteger(count.value) || count.value < 1) return null;
  if (!expire || !Object.hasOwn(expire, "value") || expire.value !== 1) return null;
  return count.value as number;
}

/** One open counted in `key`'s hour: its count, or null when it cannot be read (this instance then waits before counting again). */
async function count(key: string, now: number): Promise<number | null> {
  let seen: number | null = null;
  try {
    seen = countOf(await redisPipeline([["INCR", key], ["EXPIRE", key, SHORT_LINK_UNPAID_KEY_SECONDS]]));
  } catch {
    seen = null;
  }
  if (seen === null) unknownUntil = now + SHORT_LINK_UNKNOWN_PAUSE_MS;
  else if (seen > SHORT_LINK_UNPAID_PER_HOUR) pausedUntil = Math.min(now + SHORT_LINK_USED_UP_PAUSE_MS, (hourOf(now) + 1) * HOUR_MS);
  return seen;
}

/** Whether this open may read the database, decided before anything is read. */
export async function admitShortLinkOpen(code: string, { address, now = Date.now() }: { address: string; now?: number }): Promise<ShortLinkAdmission> {
  if (holds(tired, code, now)) return { state: "tired", now };
  if (holds(refusedConnections, `${address}|${code}`, now)) return { state: "connection", now };
  if (!withinLocalLimit("short-link-open", address, SHORT_LINK_OPENS_PER_ADDRESS, SHORT_LINK_ADDRESS_WINDOW_MS, now)) return { state: "address", now };
  if (now < pausedUntil) {
    // The hour is used: only a link its store paid for here a moment ago is read, and its store pays again.
    if (holds(known, code, now)) return { state: "open", key: null, address, now };
    return { state: "hour", now, until: pausedUntil };
  }
  if (now < unknownUntil || !isRedisConfigured()) return { state: "unknown", now };
  const key = shortLinkUnpaidKey(now);
  const seen = await count(key, now);
  if (seen === null) return { state: "unknown", now };
  if (seen > SHORT_LINK_UNPAID_PER_HOUR) {
    if (holds(known, code, now)) return { state: "open", key, address, now };
    return { state: "hour", now, until: pausedUntil };
  }
  return { state: "open", key, address, now };
}

/** Puts back in the hour an open that read and that no store paid for, when it is not counted there (best effort; a count that fails pauses this instance). */
async function countAgain(admission: { key: string | null; now: number }, now: number): Promise<void> {
  await count(admission.key ?? shortLinkUnpaidKey(now), now);
}

/** A code whose link was not found, or could not be read: an unpaid read, counted in the hour already, or now when it was read as one found a moment ago. */
export async function shortLinkNotPaid(code: string, admission: Extract<ShortLinkAdmission, { state: "open" }>, now = Date.now()): Promise<void> {
  known.delete(code);
  if (admission.key === null) await countAgain(admission, now);
}

/**
 * The store a found link belongs to, paying for this open; null when it has none (the link is then answered as
 * ended, the open counted in the hour); or the refusal to send when it does not pay.
 */
export async function payShortLinkOpen(code: string, link: { sid: string; statsId: string }, admission: Extract<ShortLinkAdmission, { state: "open" }>, now = Date.now()): Promise<Store | null | Response> {
  let inHour = admission.key !== null;
  const unpaid = async (): Promise<void> => {
    known.delete(code);
    if (!inHour) await countAgain(admission, now);
  };
  const commands: (string | number)[][] = [storeIdCommand(link.sid), ["GET", shortLinkRestKey(link.sid)]];
  if (admission.key !== null) commands.push(["DECR", admission.key], ["EXPIRE", admission.key, SHORT_LINK_UNPAID_KEY_SECONDS]);
  let replies: unknown[];
  try {
    // The refund may have been made, or not: counted again below, never left out of the hour.
    inHour = false;
    replies = await redisPipeline(commands);
  } catch {
    remember(tired, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
    await unpaid();
    return shortLinkRefusal({ state: "unknown", now });
  }
  if (!Array.isArray(replies) || replies.length !== commands.length) {
    remember(tired, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
    await unpaid();
    return shortLinkRefusal({ state: "unknown", now });
  }
  if (replies[1] === "1") return restRefused(code, now, unpaid);
  let store: Store | null;
  try {
    store = await storeForIdRef(link.sid, replies[0]);
  } catch {
    remember(tired, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
    await unpaid();
    return shortLinkRefusal({ state: "unknown", now });
  }
  if (!store || store.statsId !== link.statsId) {
    await unpaid();
    return null;
  }
  const why = await takePublicRequestWhy(store, "public", now, SHORT_LINK_OPEN_UNITS).catch(() => "unknown" as const);
  if (why === "ok") {
    remember(known, code, now + SHORT_LINK_KNOWN_MS, SHORT_LINK_KNOWN_KEPT);
    return store;
  }
  if (why === "store") {
    // Only the store's own refusal marks it resting; best effort, a mark not written is read again next time.
    await redisPipeline([["SET", shortLinkRestKey(link.sid), "1", "EX", SHORT_LINK_TIRED_MS / 1000]]).catch(() => undefined);
    return restRefused(code, now, unpaid);
  }
  if (why === "connection") {
    // That connection alone: nobody else is refused the link.
    remember(refusedConnections, `${admission.address}|${code}`, now + SHORT_LINK_CONNECTION_MS, SHORT_LINK_TIRED_KEPT);
    await unpaid();
    return shortLinkRefusal({ state: "connection", now });
  }
  remember(tired, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
  await unpaid();
  return shortLinkRefusal({ state: "unknown", now });
}

/** A store that cannot take one more request: that link answered from memory, and the open off the hour within this instance's minute. */
async function restRefused(code: string, now: number, unpaid: () => Promise<void>): Promise<Response> {
  remember(tired, code, now + SHORT_LINK_TIRED_MS, SHORT_LINK_TIRED_KEPT);
  const minute = Math.floor(now / 60_000);
  if (minute !== refundMinute) {
    refundMinute = minute;
    refundsThisMinute = 0;
  }
  if (refundsThisMinute < SHORT_LINK_REST_REFUNDS_PER_MINUTE) {
    refundsThisMinute += 1;
    known.delete(code);
  } else {
    await unpaid();
  }
  return shortLinkRefusal({ state: "tired", now });
}

const refusal = (status: number, text: string, retrySeconds: number) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(Math.max(1, Math.ceil(retrySeconds))) },
  });

/** What a refused open says: never a redirect, never kept by the CDN. */
export function shortLinkRefusal(admission: Refused): Response {
  if (admission.state === "address") {
    return refusal(429, "Too many links were opened from your network in the last few minutes. Try this link again in 10 minutes.", SHORT_LINK_ADDRESS_WINDOW_MS / 1000);
  }
  if (admission.state === "hour") {
    const next = (hourOf(admission.now) + 1) * HOUR_MS;
    return refusal(
      503,
      `Short links on this site were asked for too often this hour, so this one is paused. Try this link again after ${statusTime(admission.until)}. If it is still paused then, it opens again by ${statusTime(next)}.`,
      (admission.until - admission.now) / 1000,
    );
  }
  if (admission.state === "tired") {
    return refusal(503, "The page this link leads to cannot be opened right now. Try this link again later.", SHORT_LINK_TIRED_MS / 1000);
  }
  if (admission.state === "connection") {
    const tomorrow = (Math.floor(admission.now / 86_400_000) + 1) * 86_400_000;
    return refusal(
      429,
      "This store's pages were opened from your network more often today than one network may, so this link is not opened for you right now. Other people can still open it. Try again tomorrow, or from another network.",
      (tomorrow - admission.now) / 1000,
    );
  }
  return refusal(503, "This link could not be opened right now. Try again in a minute.", SHORT_LINK_UNKNOWN_PAUSE_MS / 1000);
}
