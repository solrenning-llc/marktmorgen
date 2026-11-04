/**
 * How many visits a store had this month.
 *
 * lib/traffic-rules.ts says what a visit is and why it is the measure a
 * plan covers and a bill is made from. This file keeps it.
 *
 *   nl:traffic:day:<folder>:<day>    who came that day, each once
 *   nl:traffic:n:<folder>:<window>   visits, added up, in the store's window
 *   nl:traffic:x:<folder>:<window>   the live room, in hundredths of a visit
 *   nl:traffic:r:<folder>:<window>   pages drawn and public requests answered
 *   nl:traffic:c:<folder>:<window>   each connection's share of them, by day (MM-SA-01)
 *   nl:traffic:folders:<month>       the stores that had any, that calendar month
 *
 * The window is the store's billing month when it pays us, and the calendar
 * month otherwise (lib/allowance-window.ts, since 17 October 2026): one
 * payment, one month of visits. A paying store whose period is not known has
 * no window; nothing is counted for it and its pages rest until it is read.
 *
 * A page of a store says it was opened (app/api/store/hit). The visitor is
 * reduced to a few letters made from the day, the store and the address
 * they came from (visitorAddress), and put in the day's set. The set
 * answers whether they were already in it; only somebody new to the day
 * adds a visit to the month. The letters are made with a key of our own and
 * cannot be turned back into an address, and the set is gone two days
 * later: what is kept is a count.
 *
 * Counted exactly, by a set and not by an estimate, because a bill is made
 * from it.
 *
 * What this errs toward. Everybody behind one address, a household or an
 * office, is one visit a day. A count that cannot be written is not made.
 * A robot that says it is one, and the store's owner, are never counted
 * (lib/visit.ts). Every one of those is in the creator's favor, which is
 * the way round a figure that is billed from has to err.
 */
import { createHash, createHmac } from "node:crypto";
import { headers } from "next/headers";
import { rememberFolderOwner } from "@/lib/delivery";
import { type AllowanceWindow, WINDOW_ID, allowanceWindow, calendarWindow, keepSecondsFor } from "@/lib/allowance-window";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { admitNonPaying } from "@/lib/free-pool";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { deriveKey } from "@/lib/secret-box";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { PARTS_PER_VISIT, SHARE_BATCH, clientDayShare, publicVisitLimit, requestLimitFor, shareAddress, visitLimitFor, visitorAddress } from "@/lib/traffic-rules";

const dayKey = (folder: string, day: string) => `nl:traffic:day:${folder}:${day}`;
const countKey = (folder: string, month: string) => `nl:traffic:n:${folder}:${month}`;
const partsKey = (folder: string, month: string) => `nl:traffic:x:${folder}:${month}`;
const requestsKey = (folder: string, window: string) => `nl:traffic:r:${folder}:${window}`;
const shareKey = (folder: string, window: string) => `nl:traffic:c:${folder}:${window}`;
const foldersKey = (month: string) => `nl:traffic:folders:${month}`;

/** A day's set is kept until the day after it is over, and a little longer. */
const DAY_KEEP_SECONDS = 2 * 24 * 60 * 60;
/** A month's figures are kept long enough to be billed, asked about and answered for. */
const KEEP_SECONDS = 400 * 24 * 60 * 60;

const FOLDER_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The few letters a visitor is kept as for a day. Made with a key only this
 * deployment has (lib/secret-box.ts), so that somebody who read the set
 * could not find an address in it by trying every address there is.
 */
function fingerprint(of: string): string {
  const key = deriveKey("traffic-visitor");
  const made = key ? createHmac("sha256", key).update(of) : createHash("sha256").update(of);
  return made.digest("hex").slice(0, 16);
}

/**
 * What is written beside a month's count: how long it is kept, and that the
 * store had visits that month, which is what the daily job reads to bill
 * (lib/usage-billing.ts). Written with the month's first visit, and again at
 * every hundredth, so that one write lost to a bad moment mends itself long
 * before a bill could be made from the count: no plan covers fewer than a
 * hundred visits.
 */
async function markMonth(folder: string, window: string, owner: string | null, now: number): Promise<void> {
  // The counts by the store's window; the line of stores by the calendar
  // month, which is how the daily jobs find them (app/api/cron/usage).
  const month = calendarWindow(now).id;
  await redisPipeline([
    ["EXPIRE", countKey(folder, window), KEEP_SECONDS],
    ["EXPIRE", partsKey(folder, window), KEEP_SECONDS],
    ["SADD", foldersKey(month), folder],
    ["EXPIRE", foldersKey(month), KEEP_SECONDS],
  ]);
  // Whose folder this is, for the daily job that bills and writes
  // (lib/usage-billing.ts, storeOf).
  if (owner) await rememberFolderOwner(folder, owner);
}

/** One person, on one day, for one store: adds a visit to the month if they are new to today. */
async function countOnce(folder: string, owner: string | null, who: string, now: number, window: AllowanceWindow): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const [fresh] = await redisPipeline([["SADD", dayKey(folder, day), fingerprint(`${day}|${folder}|${who}`)]]);
  if (Number(fresh) !== 1) return false;
  const [count] = await redisPipeline([
    ["INCR", countKey(folder, window.id)],
    ["EXPIRE", dayKey(folder, day), DAY_KEEP_SECONDS],
  ]);
  const n = Number(count);
  if (n === 1 || n % 100 === 0) await markMonth(folder, window.id, owner, now);
  return true;
}

/**
 * Somebody opened a page of this store. Adds a visit to the month if they
 * are new to today; answers whether they were.
 *
 * Never throws: a count that cannot be written must not cost anybody the
 * page they opened.
 */
export async function recordVisit(store: Store, ip: string, now = Date.now()): Promise<boolean> {
  const window = allowanceWindow(store, now);
  if (!isRedisConfigured() || !window) return false;
  try {
    return await countOnce(await storeFolder(storeRef(store)), storeRef(store), visitorAddress(ip), now, window);
  } catch (error) {
    console.error("could not count a visit to a store", error);
    return false;
  }
}

/**
 * A subscriber's podcast app asked for its feed (lib/podcast-access.ts): one
 * visit for that subscriber that day, however often the app asks. Told
 * apart by the feed and not by an address, because many apps ask from their
 * maker's servers and a thousand subscribers would be one address.
 */
export async function recordListener(store: Store, feed: string, now = Date.now()): Promise<boolean> {
  const window = allowanceWindow(store, now);
  if (!isRedisConfigured() || !feed || !window) return false;
  try {
    return await countOnce(await storeFolder(storeRef(store)), storeRef(store), `feed:${feed}`, now, window);
  } catch (error) {
    console.error("could not count a podcast subscriber's day", error);
    return false;
  }
}

/**
 * Adds hundredths of a visit to a store's month: the live room, by the ten
 * minutes it is open for one member (lib/chat-grant.ts). Answers the
 * month's hundredths after it, or null when it could not be written.
 */
export async function recordParts(store: Store, parts: number, now = Date.now()): Promise<number | null> {
  const window = allowanceWindow(store, now);
  if (!isRedisConfigured() || !window || !Number.isInteger(parts) || parts <= 0) return null;
  try {
    const owner = storeRef(store);
    const folder = await storeFolder(owner);
    if (!FOLDER_PATTERN.test(folder)) return null;
    const [total] = await redisPipeline([["INCRBY", partsKey(folder, window.id), parts]]);
    const held = Number(total);
    // The same mending as a visit's: with the first, and each time a
    // hundred visits' worth has been added.
    const step = 100 * PARTS_PER_VISIT;
    if (held === parts || Math.floor(held / step) !== Math.floor((held - parts) / step)) await markMonth(folder, window.id, owner, now);
    return held;
  } catch (error) {
    console.error("could not count the live room toward a store's visits", error);
    return null;
  }
}

/** A month of a store, taken apart: people who came, and the live room in hundredths of a visit. */
export type Traffic = { people: number; parts: number; visits: number };

export async function trafficIn(folder: string, month = calendarWindow().id): Promise<Traffic> {
  if (!isRedisConfigured() || !folder) return { people: 0, parts: 0, visits: 0 };
  try {
    const [raw] = await redisPipeline([["MGET", countKey(folder, month), partsKey(folder, month)]]);
    const [n, x] = Array.isArray(raw) ? raw : [];
    const whole = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
    const people = whole(n);
    const parts = whole(x);
    return { people, parts, visits: people + Math.floor(parts / PARTS_PER_VISIT) };
  } catch (error) {
    console.error("could not read a store's visits", error);
    return { people: 0, parts: 0, visits: 0 };
  }
}

/**
 * The visits a store had in a window: a calendar month ("2026-10"), this one
 * by default, or a billing month by the day it began ("2026-10-19"). People
 * who came, and the live room's hundredths made into whole visits.
 */
export async function visitsIn(folder: string, month = calendarWindow().id): Promise<number> {
  return (await trafficIn(folder, month)).visits;
}

/** The stores that had any visit in a month. */
export async function visitedFolders(month = calendarWindow().id): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["SMEMBERS", foldersKey(month)]]);
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string" && FOLDER_PATTERN.test(f)).sort() : [];
}

/** Strict admission read. Display/billing fallbacks must never authorize new work.
 * A null key is the existing meter's unused-month representation; this does
 * not establish freshness or defend against acknowledged counter deletion.
 */
export async function trafficForAdmission(folder: string, month = calendarWindow().id): Promise<Traffic | null> {
  if (!isRedisConfigured() || !FOLDER_PATTERN.test(folder) || !WINDOW_ID.test(month)) return null;
  try {
    const results = await redisPipeline([["MGET", countKey(folder, month), partsKey(folder, month)]]);
    if (results.length !== 1 || !Array.isArray(results[0]) || results[0].length !== 2) return null;
    const values: number[] = [];
    for (const raw of results[0]) {
      if (raw === null) { values.push(0); continue; }
      if ((typeof raw !== "string" && typeof raw !== "number") || (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw))) return null;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) return null;
      values.push(value);
    }
    const [people, parts] = values;
    const visits = people + Math.floor(parts / PARTS_PER_VISIT);
    return Number.isSafeInteger(visits) ? { people, parts, visits } : null;
  } catch { return null; }
}

/** Finite plan threshold. Unknown measurements pause new page/room admission.
 * Counted visits are not an atomic request reservation or a supplier-byte cap.
 * `who` is "public" for the store's own pages, which rest at publicVisitLimit,
 * and "buyer" for what buyers already have (courses, the community and its
 * room, a private podcast), which rests at the whole month's figure
 * (lib/traffic-rules.ts).
 */
export async function isResting(store: Store, now = Date.now(), who: "public" | "buyer" = "public", from: { shared?: boolean } = {}): Promise<boolean> {
  try {
    const window = allowanceWindow(store, now);
    if (!window) return true;
    if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return true;
    const month = visitLimitFor(store, now / 1000);
    const limit = who === "buyer" ? month : publicVisitLimit(month);
    if (!Number.isSafeInteger(limit) || limit < 0) return true;
    const folder = await storeFolder(storeRef(store));
    const traffic = await trafficForAdmission(folder, window.id);
    if (traffic === null || traffic.visits >= limit) return true;
    // The page about to be drawn is one of the window's requests, and one of
    // its connection's share of the day, unless it is asked for by a service
    // many people's apps share (a podcast app's servers), which is bounded
    // by its own feed instead.
    return !(await countRequest(folder, store, window, who, now, 1, from.shared ? null : await askingConnection()));
  } catch { return true; }
}

/**
 * One more request answered for this store's public side, counted in its
 * window: true when it fits, where public pages rest at 95% of the window's
 * requests and what buyers have at all of them (lib/traffic-rules.ts,
 * requestLimitFor). A count that cannot be made is a request refused.
 */
async function countRequest(folder: string, store: Store, window: AllowanceWindow, who: "public" | "buyer", now: number, units = 1, client: string | null = null): Promise<boolean> {
  const whole = requestLimitFor(store, now / 1000);
  const limit = who === "buyer" ? whole : publicVisitLimit(whole);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !FOLDER_PATTERN.test(folder)) return false;
  if (!Number.isSafeInteger(units) || units < 1) return false;
  // A store that pays nothing answers only while it holds one of the month's places (lib/free-pool-rules.ts).
  if (!(await admitNonPaying(store, now))) return false;
  // One connection's share of the day first (lib/traffic-rules.ts, clientDayShare):
  // past it this connection alone is refused, and nothing is counted against the store.
  if (client && (await overShare(folder, window, whole, client, units, now))) return false;
  const key = requestsKey(folder, window.id);
  const [count] = await redisPipeline([["INCRBY", key, units]]);
  const n = Number(count);
  if (!Number.isSafeInteger(n) || n < units) return false;
  if (n === units) await redisPipeline([["EXPIRE", key, keepSecondsFor(window, now)]]);
  return n <= limit;
}

/**
 * A public request this store is about to answer, other than a page drawn
 * (which isResting counts): the cart, a search, a download, the page after
 * paying... Refused when the window's requests are used, as its pages rest.
 * `units` is how many requests it counts as: more than one for a request
 * that sends a file's bytes through us (a community picture, since 18
 * October 2026), so each is priced at what it costs (tests/plan-cost-registry.ts).
 */
export async function takePublicRequest(store: Store, who: "public" | "buyer" = "public", now = Date.now(), units = 1): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  try {
    const window = allowanceWindow(store, now);
    if (!window) return false;
    if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return false;
    return await countRequest(await storeFolder(storeRef(store)), store, window, who, now, units, await askingConnection());
  } catch {
    return false;
  }
}

/**
 * A connection's requests this server has answered and not yet added to its
 * share, and the connections it has seen refused, each by store, window, day
 * and connection. Forgotten all at once when either grows past MAX_HELD:
 * what is forgotten is at most a batch per connection, and a refusal is
 * learned again at the next batch.
 */
const heldShare = new Map<string, number>();
const refusedShare = new Set<string>();
const MAX_HELD = 20_000;

/**
 * Whether this request takes its connection past its share of the day
 * (lib/traffic-rules.ts, clientDayShare). Added to the share SHARE_BATCH
 * requests at a time, with the share's expiry in the same write; a share that
 * cannot be read refuses the request, as a count that cannot be made does.
 */
async function overShare(folder: string, window: AllowanceWindow, whole: number, client: string, units: number, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const field = `${day}:${fingerprint(`${day}|${folder}|share|${client}`)}`;
  const local = `${folder}|${window.id}|${field}`;
  if (refusedShare.has(local)) return true;
  const held = (heldShare.get(local) ?? 0) + units;
  if (held < SHARE_BATCH) {
    if (heldShare.size >= MAX_HELD) heldShare.clear();
    heldShare.set(local, held);
    return false;
  }
  heldShare.delete(local);
  const [taken] = await redisPipeline([
    ["HINCRBY", shareKey(folder, window.id), field, held],
    ["EXPIRE", shareKey(folder, window.id), keepSecondsFor(window, now)],
  ]);
  const total = Number(taken);
  if (!Number.isSafeInteger(total) || total < held) return true;
  if (total <= clientDayShare(whole)) return false;
  if (refusedShare.size >= MAX_HELD) refusedShare.clear();
  refusedShare.add(local);
  return true;
}

/**
 * The connection the request being answered came from, as the share counts it
 * (lib/traffic-rules.ts, shareAddress): read from the request Next.js is
 * answering. Null outside a request (a scheduled job), which counts against
 * the store's window alone, as everything did before the share.
 */
async function askingConnection(): Promise<string | null> {
  let from: Headers;
  try {
    from = await headers();
  } catch {
    return null;
  }
  const ip = from.get("x-forwarded-for")?.split(",")[0]?.trim() || from.get("x-real-ip") || "";
  return shareAddress(ip) || null;
}

/** The store's requests in its window so far, for the studio. */
export async function requestsIn(folder: string, window: string): Promise<number> {
  if (!isRedisConfigured() || !FOLDER_PATTERN.test(folder) || !WINDOW_ID.test(window)) return 0;
  try {
    const [raw] = await redisPipeline([["GET", requestsKey(folder, window)]]);
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
