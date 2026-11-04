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
 *     SET NX that expires with the token) before anything else is asked, so
 *     the same token sent again costs that one command and counts nothing;
 *   - a reading the route takes is one of the store's public requests
 *     (lib/traffic.ts, takePublicRequest), in its monthly window like a page
 *     drawn: past the window nothing is counted.
 *
 * Nothing about the visitor is sent or kept: no cookie, no address, only
 * which block or item, and on the store page which one was clicked.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { deriveKey } from "@/lib/secret-box";
import { READ_SAMPLE } from "@/lib/page-read-sample";

export { READ_MIN_VISITORS, READ_SAMPLE } from "@/lib/page-read-sample";

/** How long after its page was drawn a token is good for: a visitor who leaves later is not counted. */
export const READ_TOKEN_SECONDS = 2 * 3600;
/** How far ahead of this server's clock a token's time may be, for servers whose clocks differ a little. */
const CLOCK_SLACK_SECONDS = 60;
/** The longest token there is: a statistics id of 40, a time, a nonce of 16 and a signature of 22, with their dots. */
export const READ_TOKEN_MAX = 100;
const NONCE = /^[A-Za-z0-9_-]{16}$/;
const ISSUED = /^[0-9a-z]{1,9}$/;

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

function sign(statsId: string, scope: string, issued: string, nonce: string): string {
  const k = key();
  return k ? createHmac("sha256", k).update(`${statsId}|${scope}|${issued}|${nonce}`).digest("base64url").slice(0, 22) : "";
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
 * may, when the page was drawn and the visit's nonce. Empty for the visitors
 * not drawn, seven in eight (readSampled), so their pages send nothing, and
 * when nothing can be signed. A fresh nonce each page view.
 */
export function readToken(statsId: string | null, scope: string, now = Date.now(), nonce = randomBytes(12).toString("base64url")): string {
  if (!statsId || !STATS_ID.test(statsId) || !SCOPE.test(scope) || !readSampled(nonce)) return "";
  const issued = Math.floor(now / 1000).toString(36);
  const signature = sign(statsId, scope, issued, nonce);
  return signature ? `${statsId}.${issued}.${nonce}.${signature}` : "";
}

/** What a good token says: the statistics id it writes to and its visit's nonce. */
export type ReadPass = { statsId: string; nonce: string };

/**
 * The statistics id and nonce of a token made for this page by this
 * deployment, drawn, and not older than READ_TOKEN_SECONDS; else null. No
 * command: whether it was used already is spendReadToken's.
 */
export function readTokenPass(token: unknown, scope: string, now = Date.now()): ReadPass | null {
  if (typeof token !== "string" || token.length > READ_TOKEN_MAX || !SCOPE.test(scope)) return null;
  const [statsId, issued, nonce, given, ...rest] = token.split(".");
  if (rest.length || !STATS_ID.test(statsId ?? "") || !ISSUED.test(issued ?? "") || !readSampled(nonce ?? "")) return null;
  const age = now / 1000 - parseInt(issued, 36);
  if (!(age <= READ_TOKEN_SECONDS && age >= -CLOCK_SLACK_SECONDS)) return null;
  const want = sign(statsId, scope, issued, nonce);
  if (!want || typeof given !== "string" || given.length !== want.length) return null;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want)) ? { statsId, nonce } : null;
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
 * else is asked, so a token sent again costs only this.
 */
export async function spendReadToken(nonce: string): Promise<boolean> {
  if (!NONCE.test(nonce)) return false;
  try {
    const [reply] = await redisPipeline([["SET", onceKey(nonce), "1", "NX", "EX", READ_TOKEN_SECONDS + CLOCK_SLACK_SECONDS]]);
    return reply === "OK";
  } catch {
    return false;
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
