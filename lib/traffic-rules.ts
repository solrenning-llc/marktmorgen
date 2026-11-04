/** Visit allowances, and where a month's visits stop.
 * A visitor count is not a bound on requests, transferred bytes, database
 * operations or CPU. These figures alone do not prove a funded cost ceiling
 * or the required 60% after-all-tax margin. Provider enforcement and the
 * commercial review must cover every resource at full simultaneous usage.
 *
 * Since 17 October 2026 visits past a plan's figure are never sold. A visit
 * was billed at VISIT_CENTS_PER_THOUSAND_OVER, half a cent for ten, against
 * about a fortieth of a cent of cost (tests/traffic-cost.ts): more than the
 * 17.2% of a price that a cost may be and still leave the owner's 60% after
 * a 27.5% tax. The price is not changed; it is no longer charged. Instead a
 * month's visits stop at the plan's figure, for every standing:
 *
 *   - the store's public pages (its page, products, blog, collections, the
 *     checkout script's cards) rest at publicVisitLimit, the figure less the
 *     share kept for buyers (BUYER_RESERVE_BPS);
 *   - what buyers already have (courses and lessons, the community and its
 *     live room, a private podcast's feed) goes on until the whole figure,
 *     then rests too, with a page that says their access is kept;
 *   - a checkout already open is never part of it: the checkout and the page
 *     after paying are not visits (lib/order-rules.ts stops new orders).
 */
import { ROOM_GRANT_MINUTES } from "@/lib/chat-pace";
import type { Tier } from "@/lib/plan";
import { type PlanFields, standingOf } from "@/lib/plan-standing";

/** Visits every plan covers, per store, per calendar month. */
export const VISITS_INCLUDED: Record<Tier, number> = {
  creator: 3_400,
  pro: 10_000,
  // 50,000 until 17 October 2026, when the uses that had no monthly figure
  // were priced into each plan's worst month (tests/plan-cost-registry.ts):
  // visits are Scale's largest cost, and 40,000 keeps it at the owner's 60%.
  scale: 40_000,
};

/**
 * What a thousand visits past that cost the creator, in cents, until 17
 * October 2026. Kept as the published price it was; nothing is billed at it
 * any more (see the top of this file).
 */
export const VISIT_CENTS_PER_THOUSAND_OVER = 50;

/**
 * The share of a month's visits kept for buyers' own pages, in hundredths of
 * a percent: public pages rest at 95% of the figure, so a store whose page is
 * busy does not shut its students and members out with it.
 */
export const BUYER_RESERVE_BPS = 500;

/** Where a store's public pages rest, for a month's figure. */
export function publicVisitLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 0;
  return limit - Math.floor((limit * BUYER_RESERVE_BPS) / 10_000);
}

/** The live room is counted in hundredths of a visit. */
export const PARTS_PER_VISIT = 100;

/**
 * What those minutes of the room count as, in hundredths of a visit: with
 * people talking, when it asks every few seconds, and with the room quiet,
 * when it asks twice a minute.
 *
 * 260 with people talking, kept by the owner on 4 November 2026 (C2-58)
 * when a visit was costed as Upstash bills it (313 [CV1], 31 October 2026):
 * a visit costs more, so ten minutes of a talking room now cost about 217.6
 * hundredths of one, and 260 is a ceiling over them with about 19.5% room,
 * held by tests/room.test.ts (never below the cost, and within a quarter
 * over it). The quiet room's 60 still covers its own.
 */
export const ROOM_LIVE_PARTS = 260;
export const ROOM_IDLE_PARTS = 60;

/** "2.6", "0.6": hundredths of a visit as a figure a page can print. */
export function partsWords(parts: number): string {
  return String(Number((Math.max(0, parts) / PARTS_PER_VISIT).toFixed(2)));
}

/** An hour of the room for one member, in visits: "16" while people talk, "3.6" while it is quiet. */
export function roomHourWords(parts: number): string {
  const visits = (Math.max(0, parts) * (60 / ROOM_GRANT_MINUTES)) / PARTS_PER_VISIT;
  return String(Number(visits.toFixed(visits >= 10 ? 0 : 1)));
}

/** Visits a store with no plan has in a month, before one is started and after one has ended. */
export const SETUP_VISITS = 500;

/**
 * Visits a store has in its free trial, whichever plan the trial is of. A
 * trial has paid nothing yet, and a larger figure would be handed out for a
 * card number alone. Store's figure until 17 October 2026, when what stores
 * that pay nothing cost came under one shared ceiling (lib/free-pool-rules.ts)
 * that each paying store carries a share of.
 */
export const TRIAL_VISITS = 1_000;

/** The visits a store's plan covers in a month. */
export function visitsIncluded(tier: Tier): number {
  return Object.hasOwn(VISITS_INCLUDED, tier) ? VISITS_INCLUDED[tier] : VISITS_INCLUDED.creator;
}

/** Finite monthly counted-visit threshold for every standing, including paid plans:
 * where buyers' own pages rest. Public pages rest at publicVisitLimit of it.
 * This is not a request/byte ceiling: provider exposure still needs its own bound.
 */
export function visitLimitFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number {
  const standing = standingOf(store, nowSeconds);
  if (standing === "paid") return visitsIncluded(store.tier ?? "creator");
  return standing === "trial" ? TRIAL_VISITS : SETUP_VISITS;
}

/**
 * Requests a store's public side may answer in a window (added 17 October
 * 2026). A visit is counted once a day per person, but a person can open a
 * page twenty times, search the store, open the cart, a download or the page
 * after paying: each is a function answering, and none of them was bounded
 * per store. Now every page drawn and every public request a store answers
 * (the routes counted with withinStore, lib/public-requests.ts) is counted
 * in the store's window, and the store rests where its visits rest when the
 * count reaches REQUESTS_PER_VISIT for each visit of its figure, and
 * EXTRA_REQUESTS more: public pages at the same 95% as visits, what buyers
 * already have at the whole figure.
 *
 * The visit is costed as three pages (tests/traffic-cost.ts, PAGES_PER_VISIT):
 * the three requests per visit here are those pages, and EXTRA_REQUESTS are
 * priced on their own (tests/plan-cost-registry.ts, line public-requests).
 */
export const REQUESTS_PER_VISIT = 3;
export const EXTRA_REQUESTS: Record<Tier, number> = {
  creator: 500,
  pro: 2_000,
  scale: 5_000,
};
/** A free trial's extra requests, and a store with no plan's. */
export const TRIAL_EXTRA_REQUESTS = 300;
export const SETUP_EXTRA_REQUESTS = 100;

/** The requests a store's window holds, where what buyers have rests; public pages rest at publicVisitLimit of it. */
export function requestLimitFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number {
  const standing = standingOf(store, nowSeconds);
  const extra = standing === "paid" ? EXTRA_REQUESTS[store.tier ?? "creator"] ?? EXTRA_REQUESTS.creator : standing === "trial" ? TRIAL_EXTRA_REQUESTS : SETUP_EXTRA_REQUESTS;
  return REQUESTS_PER_VISIT * visitLimitFor(store, nowSeconds) + extra;
}

/**
 * The most of a store's window one connection may take in a day (added 18
 * October 2026; docs/security-audit-2026-10-18.md, MM-SA-01).
 *
 * The window bounds what a store costs, and past it the store rests for
 * everybody. Until this nothing told one connection apart from another, so a
 * script on one machine could spend a creator store's month of requests in a
 * few minutes (made-up download links were enough) and shut its buyers out
 * until the month turned. Now each connection's requests are counted for the
 * day as well, and past its share it alone is refused, without counting
 * against the store: the store's own figure, and everything that rests at
 * it, is exactly what it was.
 *
 * The share is the larger of CLIENT_DAY_SHARE_MIN and a CLIENT_DAY_SHARE_PARTS
 * part of the window (300 a day on a creator store, 640 on Pro, 2,500 on
 * Scale), which a person, a household or a class behind one address does not
 * come near in a day on one store, and which leaves a single machine at most
 * that part of the window a day. It does not stop many machines at once: that
 * is the host's firewall's to stop, and the store's figure still bounds what
 * any number of them can cost.
 *
 * A connection's requests are added to its share SHARE_BATCH at a time, by
 * each server that answers them (lib/traffic.ts, overShare): one write, with
 * its expiry, for every SHARE_BATCH requests, so the share adds
 * SHARE_COMMANDS_PER_REQUEST to a request at the most, and one that asks less
 * often than that on a server adds nothing. A connection can therefore pass
 * its share by fewer than SHARE_BATCH requests on each server before it is
 * refused, which the share's size leaves room for.
 */
export const CLIENT_DAY_SHARE_MIN = 300;
export const CLIENT_DAY_SHARE_PARTS = 50;
export const SHARE_BATCH = 10;
/** The commands one batch writes (HINCRBY and EXPIRE), spread over the requests it holds. */
export const SHARE_COMMANDS_PER_REQUEST = 2 / SHARE_BATCH;

/** One connection's share of a day, for a window of `whole` requests. */
export function clientDayShare(whole: number): number {
  if (!Number.isSafeInteger(whole) || whole <= 0) return 0;
  return Math.max(CLIENT_DAY_SHARE_MIN, Math.floor(whole / CLIENT_DAY_SHARE_PARTS));
}

/**
 * The connection a share is counted for: an address of the old kind as it
 * is, and the new kind by its first three groups (a /48), which is what one
 * site is handed. Telling the new kind apart by a /64, as a visit does, would
 * let one machine with a /48 of its own (a free tunnel hands one out) be
 * sixty-five thousand connections. "" when there is no address to go by.
 */
export function shareAddress(ip: string): string {
  const address = visitorAddress(ip);
  if (!address || address === "unknown") return "";
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(address);
  return v6 ? `${v6[1]}:${v6[2]}:${v6[3]}::/48` : address;
}

/** "4,812 visits", "1 visit": a count, for a page or an email. */
export function visitsWords(visits: number): string {
  const counted = Number.isFinite(visits) && visits > 0 ? Math.floor(visits) : 0;
  return `${counted.toLocaleString("en-US")} ${counted === 1 ? "visit" : "visits"}`;
}

/** "5,000", "30,000": a figure with its thousands marked. */
export function countWords(count: number): string {
  return Math.max(0, Math.floor(count)).toLocaleString("en-US");
}

/**
 * The address a visitor is told apart by, for one day: as it is for the old
 * kind, and the network it belongs to for the new kind, where one
 * subscriber is handed more addresses than there are grains of sand and
 * could otherwise be counted as that many people.
 */
export function visitorAddress(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(":")) return address || "unknown";
  // An old address written the new way ("::ffff:203.0.113.9") is the old address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1];
  // The first four groups of the eight: the network, whatever follows it.
  const [head, tail = ""] = address.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - front.length - back.length);
  const groups = address.includes("::") ? [...front, ...Array<string>(missing).fill("0"), ...back] : front;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return address;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
