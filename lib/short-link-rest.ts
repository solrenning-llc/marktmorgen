/**
 * A store's short links once it pays again (the owner's decision 14 on #3330, 9 November 2026): a store without a
 * paid plan that rested SHORT_LINK_OFF_AFTER_MS has its links turned off (lib/short-link-open.ts), answered without
 * its record read. The moment it pays (lib/store.ts, setSubscription), its resting mark, the one check that asks it
 * again and its count of the hour are taken away, so its links open at once; and when they had been turned off, the
 * studio is told (shortLinksOffNotice), for SHORT_LINK_BACK_NOTICE_SECONDS.
 *
 * Kept apart from lib/short-link-open.ts so that lib/store.ts can call it: it reads and writes only these keys.
 *
 *   nl:slink:rest:<sid>:back  string  "<turned off at>:<back at>", in milliseconds, kept SHORT_LINK_BACK_NOTICE_SECONDS
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import {
  SHORT_LINK_BACK_NOTICE_SECONDS, SHORT_LINK_OFF_AFTER_MS, readRestMark, shortLinkBackKey, shortLinkRestCheckKey, shortLinkRestKey,
  shortLinkStoreHourKey,
} from "@/lib/short-link-open-rules";

/** A store id as lib/store.ts writes it (STORE_ID_PATTERN; not imported, lib/store.ts imports this file). */
const STORE_ID = /^[0-9a-f]{32}$/;

/** When a store's links were turned off, read from its resting mark: null when they were not (or nothing says so). */
export function turnedOffAt(mark: unknown, now: number): number | null {
  const read = readRestMark(mark);
  if (!read || read.since === null) return null;
  const off = read.since + SHORT_LINK_OFF_AFTER_MS;
  return off <= now ? off : null;
}

/** What takes a store's resting state away once it pays, and keeps the studio's notice when its links were turned off. */
export function backOnCommands(sid: string, offAt: number | null, now: number): (string | number)[][] {
  const commands: (string | number)[][] = [["DEL", shortLinkRestKey(sid)], ["DEL", shortLinkRestCheckKey(sid)], ["DEL", shortLinkStoreHourKey(sid, now)]];
  if (offAt !== null) commands.push(["SET", shortLinkBackKey(sid), `${offAt}:${now}`, "EX", SHORT_LINK_BACK_NOTICE_SECONDS]);
  return commands;
}

/** A store that has just started paying: its links open again at once. Best effort for the caller; throws when the database does not answer. */
export async function shortLinksBackOn(sid: string, now = Date.now()): Promise<void> {
  if (!STORE_ID.test(sid) || !isRedisConfigured()) return;
  const [mark] = await redisPipeline([["GET", shortLinkRestKey(sid)]]);
  await redisPipeline(backOnCommands(sid, turnedOffAt(mark, now), now));
}

/** The studio's notice that the store's short links were turned off and work again, or null. One GET. */
export async function shortLinksOffNotice(sid: string): Promise<{ offAt: number; backAt: number } | null> {
  if (!STORE_ID.test(sid) || !isRedisConfigured()) return null;
  const [value] = await redisPipeline([["GET", shortLinkBackKey(sid)]]);
  if (typeof value !== "string") return null;
  const found = /^([0-9]{13,15}):([0-9]{13,15})$/.exec(value);
  if (!found) return null;
  const offAt = Number(found[1]);
  const backAt = Number(found[2]);
  return Number.isSafeInteger(offAt) && Number.isSafeInteger(backAt) && backAt >= offAt ? { offAt, backAt } : null;
}
