/**
 * How a page is read, measured cheaply enough to be in the cost of a visit
 * (added 11 October 2026).
 *
 * Two things are measured when a visitor leaves a page:
 *
 *   - on a product's sales page, the furthest block they saw
 *     (lib/page-depth.ts, components/page-depth.tsx);
 *   - on the store's own page, the furthest item they saw — a product, a
 *     link, or a part such as the sign-up box — and the one they clicked, if
 *     they clicked one (components/store-reach.tsx), so the studio can say,
 *     for each item, how many of the people who got as far as it clicked it.
 *
 * Why this file exists. The sales-page measure used to go through the
 * store's general count, which reads the store (two commands), asks the rate
 * limit (two) and wrote three: seven commands and a call on every sales page
 * left, and none of it was in what a visit is costed at (tests/traffic-cost.ts).
 * Every plan's margin is worked out from that cost, so a measure outside it is
 * a loss nothing watches. Now:
 *
 *   - the page carries a token made from the store's statistics id and the
 *     page, signed with a key only this deployment has, so the route needs no
 *     read of the store to know which one it is and that the page is its own;
 *   - only one visitor in READ_SAMPLE sends anything at all. A share worked
 *     out from a random eighth of the visitors is the same share, give or
 *     take, and the studio says so and waits for enough of them before it
 *     shows one.
 *
 * Every reading has a ceiling before it costs anything (639 [GL7](25), the
 * cost lane's finding of 4 November 2026: the eighth was drawn only in the
 * browser, a token never expired, and the route was in no store's figure):
 *
 *   - the eighth is drawn on the server: a page view gets a token only when
 *     its visit's random nonce is drawn (readSampled), and the route checks
 *     the same draw, so a call made by hand cannot pick itself in;
 *   - a token is good for READ_TOKEN_SECONDS after the page was drawn and
 *     for one reading: the route marks its nonce used (spendReadToken, one
 *     SET NX that expires two hours after the page was drawn) before
 *     anything else is asked, so the same token sent again costs that one
 *     command and counts nothing;
 *   - a reading is counted in the store's own count of readings for its
 *     window (takeReading, nl:traffic:read:), never in the window of public
 *     requests its pages are drawn from (lib/traffic.ts): until 4 November
 *     2026 it was one of those requests, so readings made a Store plan's
 *     pages rest about 7% before its visits, a visible limit cut by stealth.
 *     The count stops at readCeiling, one reading for every READ_SAMPLE
 *     requests the store's public pages may answer in the window; past it
 *     nothing is counted, and the studio says the window's readings are
 *     partial (readingsPartial), with no figure made up for the rest;
 *   - the route never reads the store: the token says which window it counts
 *     in, when that window ends and its ceiling, signed with the rest. The
 *     page learns them from the check every store page makes before it is
 *     drawn (lib/traffic.ts, isResting, through noteReadStore), and a page
 *     with nothing learned, or a store resting or suspended, gets no token.
 *
 * Nothing about the visitor is sent or kept: no cookie, no address, only
 * which block or item, and on the store page which one was clicked.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type WindowFields, WINDOW_ID, allowanceWindow } from "@/lib/allowance-window";
import type { Tier } from "@/lib/plan";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { deriveKey } from "@/lib/secret-box";
import { READ_SAMPLE, READ_TOKEN_SECONDS } from "@/lib/page-read-sample";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";

export { READ_MIN_VISITORS, READ_SAMPLE, READ_TOKEN_SECONDS } from "@/lib/page-read-sample";

/** How far ahead of this server's clock a token's time may be, for servers whose clocks differ a little. */
const CLOCK_SLACK_SECONDS = 60;
/**
 * The longest token there is: a statistics id of 40, the time it was made
 * (9), a nonce of 16, its window's name (10), the window's end (9), its
 * ceiling (7) and a signature of 22, with their six dots.
 */
export const READ_TOKEN_MAX = 40 + 9 + 16 + 10 + 9 + 7 + 22 + 6;
const NONCE = /^[A-Za-z0-9_-]{16}$/;
const ISSUED = /^[0-9a-z]{1,9}$/;
const END = /^[0-9a-z]{1,9}$/;
const CAP = /^[1-9a-z][0-9a-z]{0,6}$/;
/** What a signature is: checked before it is compared, so nothing but 22 such letters reaches timingSafeEqual. */
const SIGNATURE = /^[A-Za-z0-9_-]{22}$/;

/** What the store's own page is called where a product's id would go. */
export const STORE_SCOPE = "~store";

const STATS_ID = /^[a-z0-9]{8,40}$/;
const SCOPE = /^(~store|[a-z0-9]{6,40})$/;
/** An item of the store's page: p (a product), l (a link) or s (a part), and its id. */
export const ITEM_PATTERN = /^[pls]:[A-Za-z0-9_-]{1,40}$/;

let signing: Buffer | null | undefined;
function key(): Buffer | null {
  if (signing === undefined) signing = deriveKey("page-read");
  return signing;
}

/** The signature of a token's fields (statistics id, time, nonce, window, end, ceiling) for a page. */
function sign(scope: string, fields: readonly string[]): string {
  const k = key();
  return k ? createHmac("sha256", k).update([fields[0], scope, ...fields.slice(1)].join("|")).digest("base64url").slice(0, 22) : "";
}

/**
 * The most readings a store's window counts: one for every READ_SAMPLE
 * requests its public pages may answer in it (lib/traffic-rules.ts,
 * requestLimitFor and publicVisitLimit), rounded up. A page view is one of
 * those requests and one in READ_SAMPLE is measured, so a store drawing all
 * of its pages has no more readings than this to send. Zero when the figure
 * is not one. Pure.
 */
export function readCeiling(store: WindowFields & { tier?: Tier }, now = Date.now()): number {
  const cap = Math.ceil(publicVisitLimit(requestLimitFor(store, now / 1000)) / READ_SAMPLE);
  return Number.isSafeInteger(cap) && cap > 0 ? cap : 0;
}

/** A store's readings' window as its last page check found it: its name, its end in seconds, its ceiling, and when it was found. */
type ReadWindow = { id: string; end: number; cap: number; at: number };
/** By statistics id, the oldest let go past READ_WINDOWS_HELD: a page's token is made moments after its check. */
const readWindows = new Map<string, ReadWindow>();
export const READ_WINDOWS_HELD = 1_000;
/** How long after its check a store's window may still sign a token. */
const READ_WINDOW_FRESH_MS = 10 * 60_000;

/**
 * What a reading of the store page about to be drawn may count: its window
 * and ceiling, kept for the page's token (readToken). Called by the check
 * every store page makes before it is drawn (lib/traffic.ts, isResting),
 * with the store when its public pages may be drawn, and with null when
 * they rest or the store is suspended, which forgets what was kept, so such
 * a page can make no token. No command.
 */
export function noteReadStore(statsId: string | null, store: (WindowFields & { tier?: Tier }) | null, now = Date.now()): void {
  if (!statsId) return;
  readWindows.delete(statsId);
  if (!store || !STATS_ID.test(statsId)) return;
  const window = allowanceWindow(store, now);
  const cap = readCeiling(store, now);
  if (!window || !WINDOW_ID.test(window.id) || cap <= 0 || !(window.end > now)) return;
  if (readWindows.size >= READ_WINDOWS_HELD) {
    const oldest = readWindows.keys().next().value;
    if (oldest !== undefined) readWindows.delete(oldest);
  }
  readWindows.set(statsId, { id: window.id, end: Math.ceil(window.end / 1000), cap, at: now });
}

/**
 * Whether a visit's nonce is one of the READ_SAMPLE measured: a draw from the
 * nonce itself, the same wherever it is made, so the route checks the very
 * draw the page was given its token by. Pure.
 */
export function readSampled(nonce: string): boolean {
  return NONCE.test(nonce) && createHash("sha256").update(`page-read|${nonce}`).digest()[0] % READ_SAMPLE === 0;
}

/**
 * The token a page view carries: which store's numbers it writes to, that it
 * may, when the page was drawn, the visit's nonce, and the window its reading
 * counts in with that window's end and ceiling (noteReadStore). Empty for the
 * visitors not drawn, seven in eight (readSampled), so their pages send
 * nothing; when the store's window was not found by its page's check moments
 * before (never a token without its ceiling); and when nothing can be
 * signed. A fresh nonce each page view.
 */
export function readToken(statsId: string | null, scope: string, now = Date.now(), nonce = randomBytes(12).toString("base64url")): string {
  if (!statsId || !STATS_ID.test(statsId) || !SCOPE.test(scope) || !readSampled(nonce)) return "";
  const window = readWindows.get(statsId);
  if (!window || Math.abs(now - window.at) > READ_WINDOW_FRESH_MS || now >= window.end * 1000) return "";
  const fields = [statsId, Math.floor(now / 1000).toString(36), nonce, window.id, window.end.toString(36), window.cap.toString(36)];
  const signature = sign(scope, fields);
  return signature ? `${fields.join(".")}.${signature}` : "";
}

/**
 * What a good token says: the statistics id it writes to, its visit's nonce,
 * when its page was drawn (seconds), and the window its reading counts in,
 * with the window's end (seconds) and its ceiling.
 */
export type ReadPass = { statsId: string; nonce: string; issued: number; window: string; end: number; cap: number };

/**
 * What a token made for this page by this deployment says, when it was
 * drawn and is not older than READ_TOKEN_SECONDS; else null. No command:
 * whether it was used already is spendReadToken's, and whether its window
 * has room takeReading's.
 */
export function readTokenPass(token: unknown, scope: string, now = Date.now()): ReadPass | null {
  if (typeof token !== "string" || token.length > READ_TOKEN_MAX || !SCOPE.test(scope)) return null;
  const parts = token.split(".");
  if (parts.length !== 7) return null;
  const [statsId, issued, nonce, window, end, cap, given] = parts;
  if (!STATS_ID.test(statsId) || !ISSUED.test(issued) || !readSampled(nonce) || !WINDOW_ID.test(window) || !END.test(end) || !CAP.test(cap) || !SIGNATURE.test(given)) return null;
  const at = parseInt(issued, 36);
  const until = parseInt(end, 36);
  const most = parseInt(cap, 36);
  const age = now / 1000 - at;
  if (!(age <= READ_TOKEN_SECONDS && age >= -CLOCK_SLACK_SECONDS) || !(at < until) || !Number.isSafeInteger(most) || most < 1) return null;
  const want = sign(scope, [statsId, issued, nonce, window, end, cap]);
  if (!SIGNATURE.test(want)) return null;
  return timingSafeEqual(Buffer.from(given, "ascii"), Buffer.from(want, "ascii")) ? { statsId, nonce, issued: at, window, end: until, cap: most } : null;
}

/** The statistics id a good token was made for (readTokenPass), or null. */
export function readTokenStats(token: unknown, scope: string, now = Date.now()): string | null {
  return readTokenPass(token, scope, now)?.statsId ?? null;
}

/** A visit's token marked used, until it expires anyway (639 [GL7](25)). */
const onceKey = (nonce: string) => `nl:read:once:${nonce}`;

/**
 * Marks a good token's nonce used: true the first time, false when it was
 * used already or the mark cannot be made. One command, made before anything
 * else is asked, so a token sent again costs only this. The mark lasts until
 * the token could no longer pass anyway, counted from when its page was
 * drawn (`issued`, seconds), and a minute more: two hours after the page was
 * drawn, as the privacy policy says, never two hours after the reading.
 */
export async function spendReadToken(nonce: string, issued: number, now = Date.now()): Promise<boolean> {
  if (!NONCE.test(nonce) || !Number.isSafeInteger(issued)) return false;
  const seconds = Math.max(1, issued + READ_TOKEN_SECONDS + CLOCK_SLACK_SECONDS - Math.floor(now / 1000));
  try {
    const [reply] = await redisPipeline([["SET", onceKey(nonce), "1", "NX", "EX", seconds]]);
    return reply === "OK";
  } catch {
    return false;
  }
}

/** A store's readings counted in one window, by its statistics id: what the route knows it by, from the token alone. */
const readsKey = (statsId: string, window: string) => `nl:traffic:read:${statsId}:${window}`;

/**
 * One reading taken in its window's count: true while the count is within
 * the token's ceiling, false past it or when it cannot be counted. One
 * pipeline of two commands, the count and its expiry together, never a read
 * and then an add, so readings sent at once can never pass the ceiling
 * between them. Kept to the window's end and a day, as the window's other
 * counts are (lib/allowance-window.ts, keepSecondsFor).
 */
export async function takeReading(pass: ReadPass, now = Date.now()): Promise<boolean> {
  if (!STATS_ID.test(pass.statsId) || !WINDOW_ID.test(pass.window) || !Number.isSafeInteger(pass.cap) || pass.cap < 1) return false;
  const key = readsKey(pass.statsId, pass.window);
  const keep = Math.max(86_400, pass.end - Math.floor(now / 1000) + 86_400);
  try {
    const [count] = await redisPipeline([["INCR", key], ["EXPIRE", key, keep]]);
    const n = Number(count);
    // The first reading past the ceiling marks the window, once: the studio then says it is partial even if the plan grows later.
    // It keeps the ceiling that was passed, so the studio says how many were counted, not how many came.
    if (n === pass.cap + 1) await redisPipeline([["SET", `${key}:over`, String(pass.cap), "EX", keep]]).catch((error: unknown) => console.error("marking a window's readings partial failed", error));
    return Number.isSafeInteger(n) && n >= 1 && n <= pass.cap;
  } catch {
    return false;
  }
}

/**
 * A window whose readings went past their ceiling: only the first `counted`
 * were counted, and counting starts again at `opens` (milliseconds). When
 * the plan grew since (`resumed`), counting went on after the change, so
 * `counted` is the ceiling that was reached, not every reading counted: the
 * visits between reaching it and the change are the ones left out.
 */
export type ReadingsPartial = { counted: number; opens: number; resumed?: true };

/**
 * Whether the store's readings of its current window went past the window's
 * ceiling, for the studio to say that the window's time on page and reading
 * depth are partial: then only the first `counted` readings were counted.
 * One command; null when they did not, or when it cannot be told. Compared
 * with the ceiling of the store's plan now, and with the mark the first
 * reading past the ceiling left: a window that went past it stays partial
 * if the plan grows later in it.
 */
export async function readingsPartial(store: WindowFields & { tier?: Tier; statsId: string | null }, now = Date.now()): Promise<ReadingsPartial | null> {
  const statsId = store.statsId;
  const window = allowanceWindow(store, now);
  const cap = readCeiling(store, now);
  if (!statsId || !STATS_ID.test(statsId) || !window || cap <= 0 || !isRedisConfigured()) return null;
  try {
    const key = readsKey(statsId, window.id);
    const [both] = await redisPipeline([["MGET", key, `${key}:over`]]);
    const [raw, over] = Array.isArray(both) ? both : [null, null];
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    const passed = Number(over);
    // Past the ceiling now, or once this window (the mark keeps the ceiling passed, if the plan grew since).
    if (!Number.isSafeInteger(n)) return null;
    if (n > cap) return { counted: cap, opens: window.end };
    // A mark left before the plan grew: the ceiling then was reached, and counting went on after the change.
    if (Number.isSafeInteger(passed) && passed > 0) return n > passed ? { counted: passed, opens: window.end, resumed: true } : { counted: n, opens: window.end };
    return null;
  } catch {
    return null;
  }
}

/**
 * The field one measured visit of the store's page is counted under, in the
 * day's record (lib/stats.ts): `sr:<position>.<furthest item>><clicked item>`.
 * The position is where the furthest item stood on the page as it was drawn
 * then, so a store reordered later is still read against what visitors saw.
 * Null when anything in it is not what a page sends.
 */
export function reachField(position: unknown, furthest: unknown, clicked: unknown): string | null {
  const at = Number(position);
  if (!Number.isInteger(at) || at < 0 || at > 999) return null;
  if (typeof furthest !== "string" || !ITEM_PATTERN.test(furthest)) return null;
  const click = typeof clicked === "string" ? clicked : "";
  if (click && !ITEM_PATTERN.test(click)) return null;
  return `sr:${at}.${furthest}>${click}`;
}

export type ReachRow = {
  /** The item: p:, l: or s: and its id. */
  item: string;
  /** Where it stood on the page, top first. */
  position: number;
  /** Measured visitors who got at least as far as it. */
  reached: number;
  /** Measured visitors who clicked it. */
  clicks: number;
};

/**
 * The store page, item by item, from the counted fields of a window (without
 * their `sr:` prefix): how many measured visitors reached each item and how
 * many clicked it, in the order of the page. An item somebody clicked but
 * that was never anybody's furthest still has its row, placed by where it was
 * clicked from at the latest; an item's position is the one it was most
 * often seen at.
 */
export function reachRows(fields: Record<string, number>): { visitors: number; rows: ReachRow[] } {
  const furthestAt = new Map<number, number>();
  const seenAt = new Map<string, Map<number, number>>();
  const clicks = new Map<string, number>();
  let visitors = 0;
  for (const [field, count] of Object.entries(fields)) {
    const match = /^(\d{1,3})\.([pls]:[A-Za-z0-9_-]{1,40})>([pls]:[A-Za-z0-9_-]{1,40})?$/.exec(field);
    if (!match || !(count > 0)) continue;
    const at = Number(match[1]);
    visitors += count;
    furthestAt.set(at, (furthestAt.get(at) ?? 0) + count);
    const places = seenAt.get(match[2]) ?? new Map<number, number>();
    places.set(at, (places.get(at) ?? 0) + count);
    seenAt.set(match[2], places);
    if (match[3]) clicks.set(match[3], (clicks.get(match[3]) ?? 0) + count);
  }
  const positionOf = (item: string): number | null => {
    const places = seenAt.get(item);
    if (!places) return null;
    return [...places.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  };
  // Everybody whose furthest point was at or below a position reached it.
  const reachedAt = (at: number) => {
    let n = 0;
    for (const [position, count] of furthestAt) if (position >= at) n += count;
    return n;
  };
  const items = new Set<string>([...seenAt.keys(), ...clicks.keys()]);
  const rows: ReachRow[] = [];
  for (const item of items) {
    const at = positionOf(item);
    // Clicked but never anybody's furthest: it was on screen for whoever
    // clicked it, so it counts as reached at least by them.
    const reached = at === null ? clicks.get(item) ?? 0 : Math.max(reachedAt(at), clicks.get(item) ?? 0);
    rows.push({ item, position: at ?? -1, reached, clicks: clicks.get(item) ?? 0 });
  }
  rows.sort((a, b) => (a.position < 0 ? 1e6 : a.position) - (b.position < 0 ? 1e6 : b.position) || a.item.localeCompare(b.item));
  return { visitors, rows };
}
