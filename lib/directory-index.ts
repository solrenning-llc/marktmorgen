/**
 * The list of creators who said their affiliate program may be listed in the
 * directory (app/affiliate-programs, lib/affiliate-directory.ts).
 *
 * Why an index and not a scan. The only way to enumerate stores is
 * `storesAfter`, a SCAN over the whole keyspace in pages of two hundred keys.
 * That is right for a nightly job and wrong for a page: every store carries
 * dozens of keys of its own — statistics, affiliates, codes, buyer bonds — so
 * a directory page built on a scan would spend thousands of Redis commands per
 * visit, and Upstash charges by the command. So the answer is kept rather than
 * discovered: a set written the moment a creator turns the consent on, and
 * unwritten the moment they turn it off, and the page reads that one set.
 *
 * The consent was collected before the directory opened, asked in the future
 * tense ("if one opens"), so the creators who said yes then are the ones it
 * opened with.
 *
 *   nl:dir:listed   set  the sid of every store whose creator said yes
 *   nl:dir:page     the directory's rows, kept a few minutes; dropped on a save that can change them
 *   nl:dir:build    "building" while one build runs, "failed" for a while after a build that could not finish
 *   nl:dir:builds   the builds counted in the window's hour, so they have a ceiling
 *   nl:dir:last     the last good build's rows with the sid of each, shown filtered past the ceiling
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";

const LISTED = "nl:dir:listed";

/** Where lib/affiliate-directory.ts keeps the rows it built, dropped whenever a program is saved. */
export const DIRECTORY_CACHE = "nl:dir:page";

/**
 * The directory's build mark (lib/affiliate-directory.ts, readDirectory): taken with SET NX before a build, so one
 * build runs at a time, dropped by a build that finished with the page kept, and set to "failed" for the cache's ten
 * minutes by one that could not finish, so a failure persisting in one listed store is built again once in that time,
 * not on every visit (#2921, CX-116 A1). Never dropped by a save: what it holds is no row of any store.
 */
export const DIRECTORY_BUILD = "nl:dir:build";

/**
 * The builds of the directory counted in a window (lib/affiliate-directory.ts, DIRECTORY_BUILDS_PER_HOUR):
 * INCR once the build mark is taken and before a build, the window's hour set once on a count that has no
 * end, so the builds have a ceiling however often a save drops the kept page. What it holds is no row of any store.
 */
export const DIRECTORY_BUILDS = "nl:dir:builds";

/**
 * The last good build of the directory, with the sid of each row (lib/affiliate-directory.ts, readDirectory). A save
 * never drops it: a visit past the window's ceiling is shown these rows, filtered by one SMISMEMBER against the
 * listed set, so a store just taken out is gone at once and the page stays up (Claude 6 on #3062).
 */
export const DIRECTORY_LAST = "nl:dir:last";

/** Which of these sids are in the listed set now, one flag each. Any reply but a list of 0 and 1, one a sid, is unknown. */
export async function stillListed(sids: string[]): Promise<boolean[]> {
  if (!sids.length) return [];
  const replies = repliesFor(await redisPipeline([["SMISMEMBER", LISTED, ...sids]]), 1);
  const flags = replies ? replies[0] : null;
  if (!Array.isArray(flags) || flags.length !== sids.length || flags.some((flag) => flag !== 0 && flag !== 1)) {
    throw new UnknownReplyError("the directory's SMISMEMBER");
  }
  return flags.map((flag) => flag === 1);
}

/**
 * How many programs the directory lists before search engines are asked to
 * show it. Below that the page is open to anyone with the link, and says how
 * many programs there are, but a search result for it would promise a
 * catalogue that is not there yet.
 */
export const INDEX_DIRECTORY_AT = 10;

/**
 * Whether this store's programme would belong in a directory.
 *
 * Consent is necessary and not sufficient. A listing has to be worth an
 * affiliate's click: a programme switched off earns nobody anything, and a
 * store with nothing that pays a commission is a row that wastes the one
 * glance it gets. The page asks more of a row besides (lib/affiliate-directory.ts,
 * directoryRow): a store that can take a card today, with a product that earns.
 */
export function wouldList(store: Store): boolean {
  return Boolean(store.affiliates.enabled && store.affiliates.directory && store.affiliates.percent > 0 && store.sid);
}

/**
 * Keeps the set in step with what a creator just saved. Called on every save
 * of the programme, not only when the answer changed, because the cost of
 * being certain is one command and the cost of drift is a list that quietly
 * stops matching the consents behind it.
 *
 * The kept page is dropped only when the save can change it: the store would
 * be listed after the save, or was in the listed set before it. The state
 * before is read from the set itself, the reply of the SREM that takes it out
 * (1: it was there; 0: it was not), since the page is built from that set; a
 * reply in any other shape counts as listed, drops the page and is said
 * (UnknownReplyError), as is an SREM that failed. A store that is not listed
 * and stays so changes nothing the directory shows, so its saves never drop
 * the page (Claude 6 on #3062: any account could otherwise drop it in a loop).
 * The commands are the same or fewer: SADD + DEL, or SREM alone, or SREM + DEL.
 */
export async function rememberListing(store: Store): Promise<void> {
  if (!store.sid || !isRedisConfigured()) return;
  if (wouldList(store)) {
    await redisPipeline([["SADD", LISTED, store.sid], ["DEL", DIRECTORY_CACHE]]);
    return;
  }
  let removed: unknown = null;
  try {
    const replies = repliesFor(await redisPipeline([["SREM", LISTED, store.sid]]), 1);
    removed = replies ? replies[0] : null;
  } catch (error) {
    await redisPipeline([["DEL", DIRECTORY_CACHE]]);
    throw error;
  }
  if (removed === 0) return;
  await redisPipeline([["DEL", DIRECTORY_CACHE]]);
  if (removed !== 1) throw new UnknownReplyError("the directory's SREM");
}

/** Takes a store out, whatever it had said. For a store being deleted. */
export async function forgetListing(sid: string): Promise<void> {
  if (!sid || !isRedisConfigured()) return;
  await redisPipeline([["SREM", LISTED, sid], ["DEL", DIRECTORY_CACHE]]);
}

/**
 * How many creators have said yes and would be listed today. A reply in any
 * other shape throws UnknownReplyError: it is not "no program listed".
 */
export async function listedCount(): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const replies = repliesFor(await redisPipeline([["SCARD", LISTED]]), 1);
  const count = replies ? countOf(replies[0]) : null;
  if (count === null) throw new UnknownReplyError("the directory's SCARD");
  return count;
}

/**
 * The sids of the listed stores, in pages.
 *
 * One command for a page of stores rather than a walk over the database
 * (lib/affiliate-directory.ts, readDirectory). Only an exact [cursor, members]
 * reply is a page; any other shape throws UnknownReplyError, never "no sid,
 * walk finished", so the directory is not built from no stores. A member may
 * come back more than once (SSCAN's own contract); the caller drops repeats.
 */
export async function listedStores(cursor = "0", count = 100): Promise<{ sids: string[]; next: string }> {
  if (!isRedisConfigured()) return { sids: [], next: "0" };
  const replies = repliesFor(await redisPipeline([["SSCAN", LISTED, cursor, "COUNT", String(count)]]), 1);
  const page = replies ? repliesFor(replies[0], 2) : null;
  // A cursor is a string of digits exactly (Codex T on #2921); "", "abc" or " 0" is not one, and would end or mislead the walk.
  const next = page && typeof page[0] === "string" && /^[0-9]+$/.test(page[0]) ? page[0] : null;
  const sids = page ? stringList(page[1]) : null;
  if (next === null || sids === null) throw new UnknownReplyError("the directory's SSCAN");
  return { next, sids };
}
