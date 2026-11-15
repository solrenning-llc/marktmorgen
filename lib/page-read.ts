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
 *   - the route writes one command;
 *   - only one visitor in READ_SAMPLE sends anything at all, chosen by the
 *     browser at random. A share worked out from a random eighth of the
 *     visitors is the same share, give or take, and the studio says so and
 *     waits for enough of them before it shows one.
 *
 * Nothing about the visitor is sent or kept: no cookie, no address, only
 * which block or item, and on the store page which one was clicked.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";

export { READ_MIN_VISITORS, READ_SAMPLE } from "@/lib/page-read-sample";

/**
 * How many read beacons one connection may have counted for one store in READ_WINDOW_SECONDS (MM-SA-43;
 * app/api/store/read, as app/api/store/hit has its own). A visitor sends one as they leave a page, and only one
 * in READ_SAMPLE is asked, so this is far above anything a person sends; past it nothing more is counted.
 */
export const READ_PER_CONNECTION = 60;
export const READ_WINDOW_SECONDS = 600;

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

function sign(statsId: string, scope: string): string {
  const k = key();
  return k ? createHmac("sha256", k).update(`${statsId}|${scope}`).digest("base64url").slice(0, 22) : "";
}

/** The token a page carries: which store's numbers it writes to, and that it may. Empty when nothing can be signed. */
export function readToken(statsId: string | null, scope: string): string {
  if (!statsId || !STATS_ID.test(statsId) || !SCOPE.test(scope)) return "";
  const signature = sign(statsId, scope);
  return signature ? `${statsId}.${signature}` : "";
}

/** The statistics id a token was made for, when it was made for this page by this deployment; else null. */
export function readTokenStats(token: string, scope: string): string | null {
  if (typeof token !== "string" || token.length > 80 || !SCOPE.test(scope)) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const statsId = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!STATS_ID.test(statsId)) return null;
  const want = sign(statsId, scope);
  if (!want || given.length !== want.length) return null;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want)) ? statsId : null;
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
