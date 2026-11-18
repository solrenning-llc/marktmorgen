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
 *   nl:traffic:read:<statsId>:<window> page readings, apart from the requests (lib/page-read.ts)
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
import { createHash, createHmac, randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { rememberFolderOwner } from "@/lib/delivery";
import { type AllowanceWindow, WINDOW_ID, allowanceWindow, calendarWindow, keepSecondsFor } from "@/lib/allowance-window";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { admitNonPaying } from "@/lib/free-pool";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { noteReadStore } from "@/lib/page-read";
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
  // Read exactly (rule 24; audit F2, 12 November 2026): a reply in another shape is unknown, never "no store had a
  // visit", which would end the monthly, weekly and quiet-sales runs as done with nobody looked at.
  const members = stringList(repliesFor(await redisPipeline([["SMEMBERS", foldersKey(month)]]), 1)?.[0]);
  if (!members) throw new UnknownReplyError("the stores visited in a month");
  return members.filter((f) => FOLDER_PATTERN.test(f)).sort();
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
  const { counted, at } = await admitPage(store, now, who, from.shared === true, 0);
  const resting = counted !== "all";
  // What a reading of the public page about to be drawn may count, for its
  // token (lib/page-read.ts, readToken): the window and its ceiling while
  // the page may be drawn, nothing when it rests or the store is suspended.
  // Readings are counted apart from the window's requests, so they never make
  // a page rest (639 [GL7](25)). The page's place among the window's requests
  // (`at`) is its reading's slot: one request in each READ_SAMPLE may carry a
  // token (lib/page-read.ts, readSlot), so a window can never be sent more
  // readings than its ceiling (the review of #2571, 5 November 2026).
  if (who === "public") {
    try {
      noteReadStore(store.statsId, resting || store.suspended ? null : store, now, at);
    } catch {}
  }
  return resting;
}

/**
 * A public page drawn, counted as isResting counts it, with `hold` requests of
 * the work it may go on to do set aside in the same count (one INCRBY of the
 * store's window, not two): the calendar embedded on a creator's site, whose
 * frame and a weekly call's times are one request of the browser
 * (app/embed/[handle]/[product], tests/embed-card-metered.test.ts). "all": the
 * page and its hold fit. "page": the page fits and the hold did not; the hold
 * was given back, as holdPublicRequests gives back a refused hold, since
 * nothing was read for it. "resting": the page rests, its own request counted
 * as a resting page's always is, its hold given back. `release` gives back,
 * in the same window, a hold the page then does not use (givePublicRequests).
 */
export async function admitPageAndHold(store: Store, hold: number, now = Date.now()): Promise<{ admitted: "all" | "page" | "resting"; release: () => Promise<void> }> {
  const nothing = async () => {};
  if (!Number.isSafeInteger(hold) || hold < 0) return { admitted: "resting", release: nothing };
  const { counted } = await admitPage(store, now, "public", false, hold);
  const admitted = counted === "none" ? "resting" : counted === "base" ? "page" : "all";
  return { admitted, release: admitted === "all" && hold > 0 ? () => givePublicRequests(store, hold, now) : nothing };
}

/**
 * isResting's count, with `hold` more units set aside in it (admitPageAndHold), and the page's place among the
 * window's requests (1 or more) when the page was counted within it, 0 otherwise (#2571, a reading's slot).
 */
async function admitPage(store: Store, now: number, who: "public" | "buyer", shared: boolean, hold: number): Promise<{ counted: Counted; at: number }> {
  const none = { counted: "none" as const, at: 0 };
  try {
    const window = allowanceWindow(store, now);
    if (!window) return none;
    if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return none;
    const month = visitLimitFor(store, now / 1000);
    const limit = who === "buyer" ? month : publicVisitLimit(month);
    if (!Number.isSafeInteger(limit) || limit < 0) return none;
    const folder = await storeFolder(storeRef(store));
    const traffic = await trafficForAdmission(folder, window.id);
    if (traffic === null || traffic.visits >= limit) return none;
    // The page about to be drawn is one of the window's requests, and one of
    // its connection's share of the day, unless it is asked for by a service
    // many people's apps share (a podcast app's servers), which is bounded
    // by its own feed instead.
    return await countRequests(folder, store, window, who, now, 1 + hold, shared ? null : await askingConnection(), hold);
  } catch { return none; }
}

/**
 * One more request answered for this store's public side, counted in its
 * window: true when it fits, where public pages rest at 95% of the window's
 * requests and what buyers have at all of them (lib/traffic-rules.ts,
 * requestLimitFor). A count that cannot be made is a request refused; a
 * reply that came back in another shape is not known, so it throws
 * UnknownReplyError (rule 24): never "the window is spent" and never room.
 */
async function countRequest(folder: string, store: Store, window: AllowanceWindow, who: "public" | "buyer", now: number, units = 1, client: string | null = null, giveBack = false): Promise<boolean> {
  return (await countRequests(folder, store, window, who, now, units, client, giveBack ? units : 0)).counted === "all";
}

/**
 * A public request's take, said three ways (outage drill, 13 November 2026): "ok" counted within the window; "over"
 * refused by a figure that was read (the window, the connection's share, a free store's place); "unknown" when the
 * count could not be made, so a caller can say "not checked just now" instead of "too many". Both refuse.
 */
export type RequestTake = "ok" | "over" | "unknown";

/** countRequest, said three ways (RequestTake): the same count, a refused hold (`giveBack`) given back. */
async function countRequestWhy(folder: string, store: Store, window: AllowanceWindow, who: "public" | "buyer", now: number, units = 1, client: string | null = null, giveBack = false): Promise<RequestTake> {
  const counted = await countRequestsWhy(folder, store, window, who, now, units, client, giveBack ? units : 0);
  return counted === "all" ? "ok" : counted === "unknown" ? "unknown" : "over";
}

/**
 * What fits of `units` requests counted in one INCRBY, of which the last
 * `hold` are a hold (a reading set aside at its worst): "all" when every unit
 * fits; past the window, the hold is not left counted, since nothing was read
 * for it, and "base" when the units before it still fit, "none" when they do
 * not. A request refused as a page resting stays counted, as it always has.
 * With it, the place of the first unit among the window's requests (n - hold)
 * when it was counted, 0 otherwise: a page's place, its reading's slot (#2571).
 */
type Counted = "all" | "base" | "none";
async function countRequests(folder: string, store: Store, window: AllowanceWindow, who: "public" | "buyer", now: number, units: number, client: string | null, hold: number): Promise<{ counted: Counted; at: number }> {
  const { counted, at } = await countRequestsAt(folder, store, window, who, now, units, client, hold);
  return counted === "all" || counted === "base" ? { counted, at } : { counted: "none", at: 0 };
}

/** countRequests, saying why nothing fits: "over" for a figure that was read, "unknown" for a count not made (RequestTake). */
async function countRequestsWhy(folder: string, store: Store, window: AllowanceWindow, who: "public" | "buyer", now: number, units: number, client: string | null, hold: number): Promise<"all" | "base" | "over" | "unknown"> {
  return (await countRequestsAt(folder, store, window, who, now, units, client, hold)).counted;
}

/**
 * countRequestsWhy with the place of the request's first unit among the window's requests (n - hold, 1 or more) when
 * that unit was counted within the window ("all" or "base"), 0 otherwise: a page's place, its reading's slot (#2571).
 */
async function countRequestsAt(folder: string, store: Store, window: AllowanceWindow, who: "public" | "buyer", now: number, units: number, client: string | null, hold: number): Promise<{ counted: "all" | "base" | "over" | "unknown"; at: number }> {
  const why = (counted: "over" | "unknown") => ({ counted, at: 0 });
  const whole = requestLimitFor(store, now / 1000);
  const limit = who === "buyer" ? whole : publicVisitLimit(whole);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !FOLDER_PATTERN.test(folder)) return why("unknown");
  if (!Number.isSafeInteger(units) || units < 1 || !Number.isSafeInteger(hold) || hold < 0 || hold > units) return why("unknown");
  // A store that pays nothing answers only while it holds one of the month's places (lib/free-pool-rules.ts).
  if (!(await admitNonPaying(store, now))) return why("over");
  // One connection's share of the day first (lib/traffic-rules.ts, clientDayShare):
  // past it this connection alone is refused, and nothing is counted against the store.
  if (client && (await overShare(folder, window, whole, client, units, now))) return why("over");
  const key = requestsKey(folder, window.id);
  const replies = repliesFor(await redisPipeline([["INCRBY", key, units]]), 1);
  // Only Redis's own answer to this one command counts (Codex G2 on #2583):
  // one reply, an integer at least `units`. Anything else, a `true`, a text
  // or a second item, is a count that is not known (rule 24; follow-up of
  // #3067): it is never said as a spent window, and nothing is answered for it.
  const n = replies ? countOf(replies[0]) : null;
  if (n === null || n < units) throw new UnknownReplyError("the store's public requests count");
  if (n === units) await redisPipeline([["EXPIRE", key, keepSecondsFor(window, now)]]);
  if (n <= limit) return { counted: "all", at: n - hold };
  // A hold refused over the window (a reading set aside at its worst) is not left counted: nothing was read for it.
  // A request refused as a page resting stays counted, as it always has.
  if (hold > 0) await redisPipeline([["DECRBY", key, hold]]).catch(() => {});
  return hold > 0 && hold < units && n - hold <= limit ? { counted: "base", at: n - hold } : why("over");
}

/**
 * A public request this store is about to answer, other than a page drawn
 * (which isResting counts): the cart, a search, a download, the page after
 * paying... Refused when the window's requests are used, as its pages rest.
 * `units` is how many requests it counts as: more than one for a request
 * that sends a file's bytes through us (a community picture, since 18
 * October 2026), so each is priced at what it costs (tests/plan-cost-registry.ts).
 * `shared` is for work done once for everybody, not for the connection that
 * happens to ask (an affiliate program's book refreshed for all its
 * affiliates, lib/affiliate-page-admission.ts): it counts against the
 * store's window alone, not the connection's share of the day.
 *
 * Three answers (rule 24; follow-up of #3067): true for room, false for a
 * window confirmed spent (or a store with no window, no place or no funded
 * period, or a Redis that cannot be asked at all, which refuses as it always
 * has: this count bounds what the store's month costs), and UnknownReplyError
 * thrown for a count or a share that came back in a shape that cannot be
 * read, so the caller says it could not check just now, never "too many" or
 * "resting". A caller that answers it in its own words reads it with
 * `.catch(unknownLimit)` (lib/request-guard.ts).
 */
export async function takePublicRequestExact(store: Store, who: "public" | "buyer" = "public", now = Date.now(), units = 1, from: { shared?: boolean } = {}): Promise<boolean> {
  return takePublic(store, who, now, units, from.shared === true, false);
}

/** An unknown count read as a no, for the callers that answer only yes or no (Claude 7 on #3068). */
const unknownIsNo = (error: unknown): false => {
  if (error instanceof UnknownReplyError) return false;
  throw error;
};

/**
 * takePublicRequestExact as a plain yes or no: a count that came back in a shape that cannot be read is a no, as it
 * always was, so the many callers that read a boolean (an optional shelf, a sitemap, an image) are never broken by it
 * (Claude 7's MEDIUM on #3068). A caller that tells the person "could not check just now" uses the exact one.
 */
export async function takePublicRequest(store: Store, who: "public" | "buyer" = "public", now = Date.now(), units = 1, from: { shared?: boolean } = {}): Promise<boolean> {
  return takePublicRequestExact(store, who, now, units, from).catch(unknownIsNo);
}

/**
 * `units` public requests set aside at a reading's worst, before it (lib/affiliates.ts, accepting a partnership by its
 * emailed link): taken as takePublicRequest takes them, from the asking connection's share too, except that a hold
 * refused over the window is not left counted, since nothing was read for it. What the reading did not need is given
 * back after it (givePublicRequests), and what it read beyond them counted (forcePublicRequests). `who` is whose
 * share of the window it is: a buyer's download (lib/stamp-cost-rules.ts) holds from the whole of it, as
 * takePublicRequest does for a buyer. `shared`, as for takePublicRequest, holds from the store's window alone, not the
 * asking connection's share of the day: a copy stamped on the fly is work for the order, whose link's opens an hour
 * already bound it, and its hold can be larger than one connection's whole share (Claude 1 cloud's triage on #3899).
 */
export async function holdPublicRequests(store: Store, units: number, now: number, who: "public" | "buyer" = "public", from: { shared?: boolean } = {}): Promise<boolean> {
  // A yes or no for its caller: an unknown count is a no, as before (Claude 7 on #3068).
  if (from.shared !== true) return takePublic(store, who, now, units, false, true).catch(unknownIsNo);
  // Held from the store's window alone, never from the connection's share of the day for pages (a big copy would shut
  // the buyer out of the store, the triage's MEDIUM on #3899), but counted on the asking connection's own share of
  // copies made on the fly (Claude 2 nuvem I's focal on #3899): a connection whose copies today already used that share
  // is refused before anything is held; what is held is added to it and what was not used given back with the rest
  // (givePublicRequests). One order's link can then never spend the store's whole window, while a big copy that fits
  // the window is still made once, and the buyer's pages are never refused for it.
  const share = await connectionShare(store, now);
  if (share === "unknown" || (share !== null && share.spent)) return false;
  if (!(await takePublic(store, who, now, units, true, true).catch(unknownIsNo))) return false;
  // The copy goes ahead only once its share holds it too, read in its exact shape (Codex X8's MEDIUM on #3899): an add
  // refused, or answered otherwise and not found in place by its token, gives the window's hold back and refuses, so
  // no give-back later subtracts from a share that never held it, no credit below zero is left for the next copies,
  // and no share is left debited for a copy that was not made (Codex C2's and X4's MEDIUM on #3899).
  if (share !== null && !(await holdShare(share, units))) {
    await movePublicRequests(store, -units, now);
    return false;
  }
  return true;
}

/**
 * A connection's share of copies taken for one hold, under the hold's own token (Codex C2's and X4's MEDIUM on #3899):
 * the token's field is written first, and only when it is not there, so one hold is never added twice and a hold
 * fenced by FLY_SHARE_SETTLE never lands after it; then the share's count, then its expiry. Answers the share's count,
 * or -1 when the token was already there (nothing added). KEYS: the share's hash; ARGV: the share's field, the token's
 * field, the hold's units, the share's expiry in seconds.
 */
const FLY_SHARE_HOLD = `-- marktmorgen:fly-share-hold:v1
if redis.call('HSETNX', KEYS[1], ARGV[2], ARGV[3]) == 0 then return -1 end
local n = redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return n`;

/**
 * A hold whose reply was lost or came in another shape, settled by its token alone: 1 when the token holds the hold's
 * units (the hold is in place); 0 when no token is there, which is then written as "~" with the share's expiry, so the
 * hold can never land after it; -1 for anything else (nothing written). KEYS: the share's hash; ARGV: the token's
 * field, the hold's units, the share's expiry in seconds.
 */
const FLY_SHARE_SETTLE = `-- marktmorgen:fly-share-settle:v1
local held = redis.call('HGET', KEYS[1], ARGV[1])
if held == ARGV[2] then return 1 end
if held then return -1 end
redis.call('HSET', KEYS[1], ARGV[1], '~')
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 0`;

/** One script's reply read in its exact shape: a single whole number (CX-123 rule 24); null for anything else. */
function oneWhole(replies: unknown): number | null {
  const reply = repliesFor(replies, 1)?.[0];
  return typeof reply === "number" && Number.isSafeInteger(reply) ? reply : null;
}

/**
 * Adds a hold of `units` to the connection's share of copies (FLY_SHARE_HOLD). True only when the share holds it: its
 * count answered in its exact shape, at least `units`; or, when that reply is lost or in another shape, the hold found
 * in place by its token (FLY_SHARE_SETTLE). False when the hold was not added (then fenced, so it never lands later)
 * and when the settling cannot be read either: a copy is never made on an unknown, and nothing is given back from a
 * share that may not hold it.
 */
async function holdShare(share: ConnectionShare, units: number): Promise<boolean> {
  if (!Number.isSafeInteger(units) || units < 1) return false;
  const token = `${share.day}:h:${randomBytes(8).toString("hex")}`;
  try {
    const count = oneWhole(await redisPipeline([["EVAL", FLY_SHARE_HOLD, 1, share.key, share.field, token, units, share.keep]]));
    if (count !== null && count >= units) return true;
  } catch {
    // The reply was lost: the hold may be in place or not, which only its token tells.
  }
  try {
    return oneWhole(await redisPipeline([["EVAL", FLY_SHARE_SETTLE, 1, share.key, token, units, share.keep]])) === 1;
  } catch {
    return false;
  }
}

/**
 * The asking connection's share of the day for copies made on the fly in this store's window, read now (the same size
 * as its share for pages, clientDayShare): null outside a request; "unknown" when it cannot be read.
 */
type ConnectionShare = { key: string; field: string; day: string; keep: number; spent: boolean };

async function connectionShare(store: Store, now: number): Promise<ConnectionShare | null | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  try {
    const window = allowanceWindow(store, now);
    if (!window) return "unknown";
    const client = await askingConnection();
    if (!client) return null;
    const folder = await storeFolder(storeRef(store));
    if (!FOLDER_PATTERN.test(folder)) return "unknown";
    const day = new Date(now).toISOString().slice(0, 10);
    // Its own field beside the connection's share for pages, in the same hash and with its expiry: "f:" for copies.
    const field = `${day}:f:${fingerprint(`${day}|${folder}|fly|${client}`)}`;
    const key = shareKey(folder, window.id);
    const replies = await redisPipeline([["HGET", key, field]]);
    const raw = Array.isArray(replies) && replies.length === 1 ? replies[0] : undefined;
    if (raw !== null && (typeof raw !== "string" || !/^-?\d{1,15}$/.test(raw))) return "unknown";
    const spent = (raw === null ? 0 : Number(raw)) >= clientDayShare(requestLimitFor(store, now / 1000));
    return { key, field, day, keep: keepSecondsFor(window, now), spent };
  } catch {
    return "unknown";
  }
}

/**
 * One HINCRBY on a connection's share (a give-back below zero), with the share's expiry. True only when both answered
 * in their exact shape: a whole count, at least `by` for an add, and 1 for the expiry (CX-123 rule 24). A hold is added
 * by holdShare, under its token; this gives back what a confirmed hold did not use.
 */
async function moveShare(share: ConnectionShare, by: number): Promise<boolean> {
  if (!Number.isSafeInteger(by) || by === 0) return true;
  const replies = await redisPipeline([
    ["HINCRBY", share.key, share.field, by],
    ["EXPIRE", share.key, share.keep],
  ]);
  if (!Array.isArray(replies) || replies.length !== 2) return false;
  const whole = (reply: unknown): number | null =>
    typeof reply === "number" && Number.isSafeInteger(reply) ? reply : typeof reply === "string" && /^-?\d{1,15}$/.test(reply) ? Number(reply) : null;
  const count = whole(replies[0]);
  return count !== null && (by < 0 || count >= by) && whole(replies[1]) === 1;
}

/**
 * The yes or no of takePublicRequestExact (rule 24; follow-up of #3067): a count or a share that came back in a shape
 * that cannot be read throws UnknownReplyError; anything else that keeps the count from being made (no Redis, no
 * window, no funded period, Redis not reached) refuses, as it always has.
 */
async function takePublic(store: Store, who: "public" | "buyer", now: number, units: number, shared: boolean, giveBack: boolean): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  try {
    const window = allowanceWindow(store, now);
    if (!window) return false;
    if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return false;
    return (await countRequestWhy(await storeFolder(storeRef(store)), store, window, who, now, units, shared ? null : await askingConnection(), giveBack)) === "ok";
  } catch (error) {
    if (error instanceof UnknownReplyError) throw error;
    return false;
  }
}

/**
 * The same take said three ways (RequestTake, outage drill of 13 November 2026), for a page that tells "too many"
 * apart from "not checked just now": an unreadable count or share (UnknownReplyError) and a count that could not be
 * made at all are both "unknown".
 */
async function takePublicWhy(store: Store, who: "public" | "buyer", now: number, units: number, shared: boolean, giveBack: boolean): Promise<RequestTake> {
  if (!isRedisConfigured()) return "unknown";
  try {
    const window = allowanceWindow(store, now);
    if (!window) return "unknown";
    if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return "over";
    return await countRequestWhy(await storeFolder(storeRef(store)), store, window, who, now, units, shared ? null : await askingConnection(), giveBack);
  } catch {
    // Redis or the store's folder could not be reached: a count that was not made, never room, and never "too many".
    return "unknown";
  }
}

/** takePublicRequest, said three ways (RequestTake): for a page that tells "too many" apart from "not checked just now". */
export async function takePublicRequestWhy(store: Store, who: "public" | "buyer" = "public", now = Date.now()): Promise<RequestTake> {
  return takePublicWhy(store, who, now, 1, false, false);
}

/**
 * Gives back `units` of the store's window that a public request took at `now` (takePublicRequest, the same moment,
 * so the same window) and did not need: a reading taken at its worst, then measured (lib/affiliates.ts, accepting a
 * partnership by its emailed link). One DECRBY on the window's count; its connection's share of the day is not given
 * back. Best effort: a give-back that fails leaves the count higher, never lower.
 */
export async function givePublicRequests(store: Store, units: number, now: number, from: { shared?: boolean } = {}): Promise<void> {
  await movePublicRequests(store, -units, now);
  // A shared hold (holdPublicRequests) also gives back from the connection's share what it did not use.
  if (from.shared === true && Number.isSafeInteger(units) && units > 0) {
    const share = await connectionShare(store, now);
    if (share !== null && share !== "unknown") await moveShare(share, -units).catch(() => {});
  }
}

/**
 * Counts `units` more in the store's window at `now`, already used by a reading that moved more than was set aside
 * for it, past the window's figure if it must (as lib/store-allowance.ts forceAllowance does for a store's own
 * figures): only the true count of what was spent, so the next request is refused as usual. Best effort.
 */
export async function forcePublicRequests(store: Store, units: number, now: number): Promise<void> {
  await movePublicRequests(store, units, now);
}

/** One INCRBY (or DECRBY, below zero) on the store's window at `now`. */
async function movePublicRequests(store: Store, by: number, now: number): Promise<void> {
  const units = Math.abs(by);
  if (!Number.isSafeInteger(units) || units < 1 || !isRedisConfigured()) return;
  try {
    const window = allowanceWindow(store, now);
    if (!window) return;
    const folder = await storeFolder(storeRef(store));
    if (!FOLDER_PATTERN.test(folder)) return;
    const key = requestsKey(folder, window.id);
    const [n] = await redisPipeline([[by < 0 ? "DECRBY" : "INCRBY", key, units]]);
    // A count made by this INCRBY (none was there) keeps the window's expiry, as countRequest's does.
    if (by > 0 && Number(n) === units) await redisPipeline([["EXPIRE", key, keepSecondsFor(window, now)]]);
  } catch {
    // Best effort: a give-back that fails leaves the count higher; a count that fails was already spent.
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
 * came back in another shape throws UnknownReplyError, as the window's count does.
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
  const replies = repliesFor(await redisPipeline([
    ["HINCRBY", shareKey(folder, window.id), field, held],
    ["EXPIRE", shareKey(folder, window.id), keepSecondsFor(window, now)],
  ]), 2);
  // A share that came back in another shape is not known (rule 24): never "over its share", never room.
  const total = replies ? countOf(replies[0]) : null;
  if (total === null || total < held) throw new UnknownReplyError("a connection's share of the day");
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
